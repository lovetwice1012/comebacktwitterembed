'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./lib/counter-database');
const counts = require('../src/tableCounts');
const { SCHEMA_STATEMENTS } = require('../src/db_schema');
const loadDashboard = require('./test/helpers/load-dashboard.cjs');

async function main() {
    const name = `cbte_counter_test_${process.pid}_${Date.now()}`;
    const admin = await connect(undefined);
    let db;
    let concurrent;
    try {
        await admin.query(`CREATE DATABASE \`${name}\``);
        db = await connect(name);
        concurrent = await connect(name);
        const query = db.query;
        for (const { table } of counts.TABLES) {
            const definition = SCHEMA_STATEMENTS.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
            assert.ok(definition, table);
            await query(definition);
        }
        const metric = `INSERT INTO bot_metric_buckets (bucket_start_ms,bucket_size_seconds,metric_name)
            VALUES (?,60,'counter-test') ON DUPLICATE KEY UPDATE count=count+1`;
        await query(metric, [1]); // Existing data before triggers.
        await counts.install(query);
        await counts.install(query); // Idempotent and never clears deltas.
        await query(metric, [2]);
        await counts.seed(query, 'bot_metric_buckets', { afterCount: async () => {
            await concurrent.query(metric, [3]); // Commits between count and delta reads.
            await concurrent.query('DELETE FROM bot_metric_buckets WHERE bucket_start_ms=1');
        } });
        assert.equal(await counts.observedCount(query, 'bot_metric_buckets'), 2n);
        for (const { table } of counts.TABLES) await counts.seed(query, table);
        await query(metric, [2]); // UPSERT existing row must not increment row count.
        assert.equal(await counts.observedCount(query, 'bot_metric_buckets'), 2n);
        await query('START TRANSACTION');
        await query(metric, [4]);
        await query('ROLLBACK');
        assert.equal(await counts.observedCount(query, 'bot_metric_buckets'), 2n);
        await query('DELETE FROM bot_metric_buckets WHERE bucket_start_ms=2');
        assert.equal(await counts.observedCount(query, 'bot_metric_buckets'), 1n);
        await query(`INSERT INTO bot_provider_content_events (occurred_at_ms,provider_id) VALUES (1,'test')`);
        await query(`INSERT INTO bot_provider_content_facets (content_event_id,provider_id,facet_key,occurred_at_ms)
            VALUES (1,'test','one',1),(1,'test','two',1),(1,'test','three',1)`);
        assert.equal(await counts.observedCount(query, 'bot_provider_content_facets'), 3n);
        await query('START TRANSACTION');
        await query('DELETE FROM bot_provider_content_events WHERE content_event_id=1');
        assert.equal(await counts.observedCount(query, 'bot_provider_content_facets'), 0n);
        await query('ROLLBACK');
        assert.equal(await counts.observedCount(query, 'bot_provider_content_facets'), 3n);
        await query('DELETE FROM bot_provider_content_facets WHERE facet_id=1');
        await query('DELETE FROM bot_provider_content_events WHERE content_event_id=1');
        assert.equal(await counts.observedCount(query, 'bot_provider_content_facets'), 0n);
        const unique = `INSERT IGNORE INTO bot_provider_hourly_unique_keys (bucket_start_ms,key_type,key_hash)
            VALUES (1,'author_user','test')`;
        await query(unique);
        await query(unique);
        assert.equal(await counts.observedCount(query, 'bot_provider_hourly_unique_keys'), 1n);
        await query("INSERT INTO bot_provider_hourly_aggregates (bucket_start_ms) VALUES (1) ON DUPLICATE KEY UPDATE content_events=content_events+1");
        await query("INSERT INTO bot_provider_hourly_aggregates (bucket_start_ms) VALUES (1) ON DUPLICATE KEY UPDATE content_events=content_events+1");
        assert.equal(await counts.observedCount(query, 'bot_provider_hourly_aggregates'), 1n);
        await query("INSERT INTO bot_error_events (occurred_at_ms,error_type) VALUES (1,'test')");
        await query("INSERT INTO bot_error_buckets (bucket_start_ms,bucket_size_seconds,error_type,severity) VALUES (1,60,'test','error')");
        await query("INSERT INTO bot_analytics_events (occurred_at_ms,event_type) VALUES (1,'test')");
        // Each writer owns one counter shard for a transaction. A bulk insert
        // must not hold all 16 shards and block another unrelated bulk insert.
        const [firstId] = await query('SELECT MOD(CONNECTION_ID(),16) AS shard');
        const [secondId] = await concurrent.query('SELECT MOD(CONNECTION_ID(),16) AS shard');
        assert.notEqual(firstId.shard, secondId.shard, 'validation connections need distinct shards');
        await query('START TRANSACTION');
        await concurrent.query('START TRANSACTION');
        const bulk = `INSERT INTO bot_error_events (occurred_at_ms,error_type) VALUES ${Array(50).fill("(1,'parallel')").join(',')}`;
        await Promise.all([query(bulk), concurrent.query(bulk)]);
        await Promise.all([query('ROLLBACK'), concurrent.query('ROLLBACK')]);
        assert.equal(await counts.observedCount(query, 'bot_error_events'), 1n);
        await query('CREATE INDEX idx_analytics_event_time ON bot_analytics_events(event_type,occurred_at_ms)');
        for (let guild = 0; guild < 10; guild++) {
            await query(`INSERT INTO bot_analytics_events (occurred_at_ms,event_type,author_user_id,provider_id,account_key,guild_id,endpoint_key)
                VALUES (100,'provider_extract','u','twitter','a',?,'/a'),(100,'provider_extract','u','twitter','a',?,'/a')`, [String(guild), String(guild)]);
        }
        for (let i = 0; i < 5; i++) await query(`INSERT INTO bot_analytics_events
            (occurred_at_ms,event_type,author_user_id,provider_id,account_key,guild_id,endpoint_key)
            VALUES (100,'provider_extract','u','youtube','b','g','/b')`);
        const { audienceInterestQuery } = loadDashboard('lib/audience-interest-query.ts');
        const audience = await query(audienceInterestQuery, [50, 50]);
        assert.equal(audience.length, 2);
        for (const row of audience) {
            assert.equal(BigInt(row.co_activity), 100n);
            assert.equal(BigInt(row.shared_users), 1n);
            assert.equal(BigInt(row.shared_guilds), row.target_provider_id === 'twitter' ? 10n : 1n);
        }
        const verified = [];
        for (const { table } of counts.TABLES) verified.push(await counts.verify(query, table));
        await counts.seed(query, 'bot_metric_buckets', { reseed: true });
        assert.equal(await counts.observedCount(query, 'bot_metric_buckets'), 1n);
        console.log(JSON.stringify({ mysqlCounterTests: 'passed', verified }, null, 2));
    } finally {
        if (concurrent) await concurrent.close();
        if (db) await db.close();
        // This script can drop only the fresh validation database it created.
        if (!/^cbte_counter_test_\d+_\d+$/.test(name)) throw new Error('Invalid validation database name');
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await admin.close();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
