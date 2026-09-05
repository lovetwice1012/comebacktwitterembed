'use strict';

const TABLES = require('./table-count-tables.json');
const VERSION = 1;
const SHARDS = 16;
const BASELINES = 'bot_table_count_baselines';
const DELTAS = 'bot_table_count_deltas';
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS ${BASELINES} (
        table_name VARCHAR(64) NOT NULL PRIMARY KEY,
        baseline_count BIGINT NOT NULL DEFAULT 0,
        ready TINYINT(1) NOT NULL DEFAULT 0,
        counter_version INT NOT NULL DEFAULT 1,
        seeded_at TIMESTAMP NULL,
        verified_at TIMESTAMP NULL
    ) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin`,
    `CREATE TABLE IF NOT EXISTS ${DELTAS} (
        table_name VARCHAR(64) NOT NULL,
        shard_id TINYINT UNSIGNED NOT NULL,
        delta BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (table_name, shard_id)
    ) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin`,
];

function targetFor(table) {
    const target = TABLES.find(item => item.table === table);
    if (!target) throw new Error(`Unsupported counter table: ${table}`);
    return target;
}

function shardExpression(target, record) {
    if (target.key.length === 1) return `MOD(${record}.\`${target.key[0]}\`, ${SHARDS})`;
    return `MOD(CRC32(CONCAT_WS(CHAR(31), ${target.key.map(key => `${record}.\`${key}\``).join(', ')})), ${SHARDS})`;
}

function triggerDefinitions(table, legacyShards = false) {
    const target = targetFor(table);
    const definitions = ['INSERT', 'DELETE'].map(event => {
        const sign = event === 'INSERT' ? '+' : '-';
        const value = event === 'INSERT' ? 1 : -1;
        const record = event === 'INSERT' ? 'NEW' : 'OLD';
        return {
            name: `cbte_tc_${target.alias}_${event === 'INSERT' ? 'ai' : 'ad'}_v1`,
            table, timing: 'AFTER', event, replace: false,
            body: `INSERT INTO ${DELTAS} (table_name, shard_id, delta)
                VALUES ('${table}', ${legacyShards ? shardExpression(target, record) : `MOD(CONNECTION_ID(), ${SHARDS})`}, ${value})
                ON DUPLICATE KEY UPDATE delta = delta ${sign} 1`,
        };
    });
    if (table === 'bot_provider_content_events') definitions.unshift({
        name: 'cbte_tc_content_bd_v1', table, timing: 'BEFORE', event: 'DELETE', replace: false,
        // InnoDB cascades do not fire child DELETE triggers. Delete children
        // explicitly first; the existing FK cascade then has nothing left.
        body: 'DELETE FROM bot_provider_content_facets WHERE content_event_id = OLD.content_event_id',
    });
    return definitions;
}

function canonicalSql(sql) { return String(sql).replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }

async function assertTriggers(query, table, allowMissing = false, upgradeOwned = false) {
    const rows = await query(`SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
        FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ?`, [table]);
    const byName = new Map(rows.map(row => [row.TRIGGER_NAME, row]));
    const missing = [];
    for (const trigger of triggerDefinitions(table)) {
        const row = byName.get(trigger.name);
        if (!row) {
            if (allowMissing) { missing.push(trigger); continue; }
            throw new Error(`Counter trigger missing: ${trigger.name}. Run install and reseed before enabling counts.`);
        }
        if (row.ACTION_TIMING !== trigger.timing || row.EVENT_MANIPULATION !== trigger.event
            || canonicalSql(row.ACTION_STATEMENT) !== canonicalSql(trigger.body)) {
            const previous = triggerDefinitions(table, true).find(item => item.name === trigger.name);
            if (upgradeOwned && row.ACTION_TIMING === trigger.timing && row.EVENT_MANIPULATION === trigger.event
                && previous && canonicalSql(row.ACTION_STATEMENT) === canonicalSql(previous.body)) {
                missing.push({ ...trigger, replace: true });
                continue;
            }
            throw new Error(`Counter trigger definition mismatch: ${trigger.name}`);
        }
    }
    return missing;
}

async function install(query, upgradeOwned = false) {
    const lock = await query("SELECT GET_LOCK('cbte_table_counts_install_v1', 5) AS acquired");
    if (Number(lock[0]?.acquired) !== 1) throw new Error('Another counter installation is running.');
    try {
        for (const sql of SCHEMA) await query(sql);
        // Refuse unknown cascading paths instead of silently counting them incorrectly.
        const cascades = await query(`SELECT TABLE_NAME, REFERENCED_TABLE_NAME, DELETE_RULE
            FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND DELETE_RULE = 'CASCADE'`);
        for (const fk of cascades) {
            if (!TABLES.some(target => target.table === fk.TABLE_NAME)) continue;
            if (fk.TABLE_NAME !== 'bot_provider_content_facets' || fk.REFERENCED_TABLE_NAME !== 'bot_provider_content_events') {
                throw new Error(`Unsupported cascade into counted table: ${fk.TABLE_NAME}`);
            }
        }
        // Child triggers must exist before enabling the parent's explicit delete.
        const ordered = [...TABLES.filter(item => item.table !== 'bot_provider_content_events'), targetFor('bot_provider_content_events')];
        for (const { table } of ordered) {
            await query(`INSERT IGNORE INTO ${BASELINES} (table_name, counter_version) VALUES (?, ?)`, [table, VERSION]);
            const missing = await assertTriggers(query, table, true, upgradeOwned);
            if (missing.length) {
                // Keep old baseline/deltas for a consistent reseed; never reset deltas
                // underneath active writers or claim an untracked interval is exact.
                await query(`UPDATE ${BASELINES} SET ready = 0 WHERE table_name = ?`, [table]);
                for (const trigger of missing) {
                    if (trigger.replace) await query(`DROP TRIGGER \`${trigger.name}\``);
                    await query(`CREATE TRIGGER \`${trigger.name}\` ${trigger.timing} ${trigger.event} ON \`${table}\`
                        FOR EACH ROW ${trigger.body}`);
                }
            }
        }
    } finally { await query("SELECT RELEASE_LOCK('cbte_table_counts_install_v1')"); }
}

async function observedCount(query, table) {
    targetFor(table);
    const rows = await query(`SELECT b.baseline_count + COALESCE(SUM(d.delta), 0) AS row_count, b.ready, b.counter_version
        FROM ${BASELINES} b LEFT JOIN ${DELTAS} d ON d.table_name = b.table_name
        WHERE b.table_name = ? GROUP BY b.table_name, b.baseline_count, b.ready, b.counter_version`, [table]);
    const row = rows[0];
    if (!row || Number(row.ready) !== 1 || Number(row.counter_version) !== VERSION) throw new Error(`Counter not ready: ${table}`);
    return BigInt(row.row_count);
}

async function withSnapshot(query, work) {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try {
        const result = await work();
        await query('COMMIT');
        return result;
    } catch (error) {
        await query('ROLLBACK').catch(() => {});
        throw error;
    }
}

/** @param {Function} query @param {string} table @param {{ reseed?: boolean, afterCount?: () => Promise<void> }} options */
async function seed(query, table, options = {}) {
    targetFor(table);
    const lockName = `cbte_tc_seed_${table}`;
    const lock = await query('SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
    if (Number(lock[0]?.acquired) !== 1) throw new Error(`Counter seed already running: ${table}`);
    try {
        await assertTriggers(query, table);
        const current = await query(`SELECT ready FROM ${BASELINES} WHERE table_name = ?`, [table]);
        if (Number(current[0]?.ready) === 1 && !options.reseed) return { table, skipped: true };
        const baseline = await withSnapshot(query, async () => {
            const rows = await query(`SELECT COUNT(*) AS row_count FROM \`${table}\``);
            if (typeof options.afterCount === 'function') await options.afterCount();
            const deltas = await query(`SELECT COALESCE(SUM(delta), 0) AS total_delta FROM ${DELTAS} WHERE table_name = ?`, [table]);
            return BigInt(rows[0].row_count) - BigInt(deltas[0].total_delta);
        });
        // Concurrent changes committed since the snapshot stay in deltas. Only
        // publish the baseline; replacing the current counter would lose them.
        await query(`UPDATE ${BASELINES} SET baseline_count = ?, ready = 1, counter_version = ?,
            seeded_at = CURRENT_TIMESTAMP, verified_at = NULL WHERE table_name = ?`, [baseline.toString(), VERSION, table]);
        return { table, baseline: baseline.toString(), count: (await observedCount(query, table)).toString() };
    } finally { await query('SELECT RELEASE_LOCK(?)', [lockName]); }
}

async function verify(query, table) {
    await assertTriggers(query, table);
    const result = await withSnapshot(query, async () => {
        const counted = await observedCount(query, table);
        const rows = await query(`SELECT COUNT(*) AS row_count FROM \`${targetFor(table).table}\``);
        const actual = BigInt(rows[0].row_count);
        return { table, counter: counted.toString(), actual: actual.toString(), equal: counted === actual };
    });
    if (!result.equal) {
        await query(`UPDATE ${BASELINES} SET ready = 0 WHERE table_name = ?`, [table]);
        throw new Error(`Counter mismatch: ${JSON.stringify(result)}`);
    }
    await query(`UPDATE ${BASELINES} SET verified_at = CURRENT_TIMESTAMP WHERE table_name = ?`, [table]);
    return result;
}

module.exports = { TABLES, VERSION, SHARDS, BASELINES, DELTAS, SCHEMA, targetFor, triggerDefinitions, assertTriggers, install, observedCount, seed, verify };
