'use strict';

// Explicitly scoped migration. MySQL DDL commits implicitly; an interrupted
// run must be reviewed and may then be safely resumed using the same command.
const MIGRATIONS = Object.freeze([
    '20261110_add_x_subscription_browser_kind.sql',
    '20261110_add_chrome_mcs_pending.sql',
    '20261110_add_chrome_checkin.sql',
    '20261110_allow_chrome_mcs_control_pending.sql',
    '20261110_add_wns_token_state.sql',
]);
const BASE_TABLES = ['schema_migrations', 'automation_x_subscriptions', 'automation_x_push_receivers', 'automation_x_push_inbox'];
const COLUMNS = Object.freeze({
    'automation_x_subscriptions.browser_kind': { type: /^varchar\(16\)$/, nullable: 'NO', collation: 'ascii_bin', defaultValue: 'firefox' },
    'automation_x_push_receivers.chrome_checkin_at_ms': { type: /^bigint(?:\(\d+\))?$/, nullable: 'YES' },
    'automation_x_push_receivers.chrome_checkin_interval_seconds': { type: /^int(?:\(\d+\))? unsigned$/, nullable: 'YES' },
    'automation_x_push_receivers.chrome_checkin_revision': { type: /^int(?:\(\d+\))? unsigned$/, nullable: 'YES' },
    'automation_x_push_receivers.wns_token_sealed_json': { type: /^text$/, nullable: 'YES' },
    'automation_x_push_receivers.wns_token_revision': { type: /^int(?:\(\d+\))? unsigned$/, nullable: 'YES' },
    'automation_x_push_receivers.wns_token_generation': { type: /^bigint(?:\(\d+\))? unsigned$/, nullable: 'YES' },
    'automation_x_mcs_pending.subscription_id': { type: /^char\(36\)$/, nullable: 'NO', collation: 'ascii_bin' },
    'automation_x_mcs_pending.subscription_revision': { type: /^int(?:\(\d+\))? unsigned$/, nullable: 'NO' },
    'automation_x_mcs_pending.persistent_id': { type: /^varchar\(256\)$/, nullable: 'NO', collation: 'ascii_bin' },
    'automation_x_mcs_pending.inbox_id': { type: /^bigint(?:\(\d+\))? unsigned$/, nullable: 'YES', allowLegacyNotNull: true },
    'automation_x_mcs_pending.created_at_ms': { type: /^bigint(?:\(\d+\))?$/, nullable: 'NO' },
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function inspect(query, { requireComplete = false } = {}) {
    const tables = await query(`SELECT TABLE_NAME name, ENGINE engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('schema_migrations','automation_x_subscriptions','automation_x_push_receivers','automation_x_push_inbox','automation_x_mcs_pending')`);
    const byName = new Map(tables.map(row => [row.name, row]));
    for (const table of BASE_TABLES) if (!byName.has(table) || String(byName.get(table).engine).toLowerCase() !== 'innodb') fail('CHROMIUM_MIGRATION_BASE_INVALID');
    if (byName.has('automation_x_mcs_pending') && String(byName.get('automation_x_mcs_pending').engine).toLowerCase() !== 'innodb') fail('CHROMIUM_MIGRATION_SCHEMA_INVALID');
    const rows = await query(`SELECT TABLE_NAME tableName,COLUMN_NAME columnName,COLUMN_TYPE columnType,IS_NULLABLE nullable,
        COLLATION_NAME collationName,COLUMN_DEFAULT defaultValue FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN ('automation_x_subscriptions','automation_x_push_receivers','automation_x_mcs_pending')`);
    const found = new Map(rows.map(row => [`${row.tableName}.${row.columnName}`, row]));
    for (const [name, expected] of Object.entries(COLUMNS)) {
        const row = found.get(name);
        if (!row) {
            if (requireComplete || name.startsWith('automation_x_mcs_pending.') && byName.has('automation_x_mcs_pending')) fail('CHROMIUM_MIGRATION_SCHEMA_INVALID');
            continue;
        }
        const validNull = row.nullable === expected.nullable || !requireComplete && expected.allowLegacyNotNull && row.nullable === 'NO';
        if (!expected.type.test(String(row.columnType).toLowerCase()) || !validNull
            || expected.collation && row.collationName !== expected.collation
            // MariaDB reports string defaults as quoted SQL literals; MySQL
            // reports the unquoted value for this fixed, non-escaped default.
            || expected.defaultValue && ![expected.defaultValue, `'${expected.defaultValue}'`].includes(row.defaultValue)
            || expected.nullable === 'YES' && row.nullable === 'YES' && row.defaultValue !== null && row.defaultValue !== 'NULL') fail('CHROMIUM_MIGRATION_SCHEMA_INVALID');
    }
    if (byName.has('automation_x_mcs_pending')) {
        const index = await query("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='automation_x_mcs_pending' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX");
        if (index.map(row => row.name).join(',') !== 'subscription_id,persistent_id') fail('CHROMIUM_MIGRATION_SCHEMA_INVALID');
        const keys = await query(`SELECT k.COLUMN_NAME name,k.REFERENCED_TABLE_NAME target,k.REFERENCED_COLUMN_NAME targetColumn,r.DELETE_RULE deleteRule
            FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='automation_x_mcs_pending' AND k.REFERENCED_TABLE_NAME IS NOT NULL`);
        if (keys.length !== 2) fail('CHROMIUM_MIGRATION_SCHEMA_INVALID');
        for (const [name, target] of [['subscription_id', 'automation_x_subscriptions'], ['inbox_id', 'automation_x_push_inbox']]) {
            if (!keys.some(row => row.name === name && row.target === target && row.targetColumn === 'id' && row.deleteRule === 'CASCADE')) fail('CHROMIUM_MIGRATION_SCHEMA_INVALID');
        }
    } else if (requireComplete) fail('CHROMIUM_MIGRATION_SCHEMA_INVALID');
    return { ready: requireComplete, migrations: MIGRATIONS.length };
}
async function run(query, applyFile, { apply = false } = {}) {
    if (typeof query !== 'function' || typeof applyFile !== 'function') fail('CHROMIUM_MIGRATION_CONFIG_INVALID');
    await inspect(query);
    if (!apply) return { state: 'checked', migrations: MIGRATIONS.length };
    for (const file of MIGRATIONS) await applyFile(query, file);
    await inspect(query, { requireComplete: true });
    return { state: 'applied', migrations: MIGRATIONS.length };
}
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--apply'].includes(args[0])) {
        process.stderr.write('Usage: node scripts/migrate-chromium-schema.cjs --check|--apply\n'); process.exitCode = 1;
    } else {
        const { queryDatabase, closeDatabaseConnection } = require('../src/db');
        const { _internal } = require('../src/db_schema');
        run(queryDatabase, _internal.applyMigrationFile, { apply: args[0] === '--apply' })
            .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
            .catch(error => { process.stderr.write(`${/^CHROMIUM_MIGRATION_[A-Z_]+$/.test(error?.code || '') ? error.code : 'CHROMIUM_MIGRATION_FAILED'}\n`); process.exitCode = 1; })
            .finally(() => closeDatabaseConnection().catch(() => { process.stderr.write('CHROMIUM_MIGRATION_CLOSE_FAILED\n'); process.exitCode = 1; }));
    }
}
module.exports = { MIGRATIONS, inspect, run };
