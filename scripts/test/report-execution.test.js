'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const execution = loadDashboard('lib/report-execution.ts');
const { refreshReportSnapshot } = loadDashboard('lib/report-cache.ts');
const { loadExactTableCounts, countedTables } = loadDashboard('lib/table-counts.ts');

test('query deadlines apply to the outer SELECT of CTEs without changing quoted text or parameters', () => {
    const sql = "WITH data AS (SELECT 'SELECT ( )' AS text, ? AS id /* SELECT */) SELECT * FROM data WHERE id=?";
    assert.equal(execution.withSelectTimeout(sql, 1000), "WITH data AS (SELECT 'SELECT ( )' AS text, ? AS id /* SELECT */) SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM data WHERE id=?");
    assert.equal(execution.withSelectTimeout('SELECT /*+ NO_ICP(t) */ * FROM t', 50), 'SELECT /*+ MAX_EXECUTION_TIME(50) NO_ICP(t) */ * FROM t');
    assert.equal(execution.withSelectTimeout('SELECT /*+ MAX_EXECUTION_TIME(99999) */ 1', 500), 'SELECT /*+ MAX_EXECUTION_TIME(500) */ 1');
    const scoped = execution.withSelectTimeout("WITH t AS (SELECT 1) SELECT * FROM t", 1000, execution.reportResourceHints);
    assert.match(scoped, /\) SELECT \/\*\+ MAX_EXECUTION_TIME\(1000\) SET_VAR\(tmp_table_size=67108864\)/);
    assert.equal((scoped.match(/SET_VAR\(sort_buffer_size/g) || []).length, 1);
});

test('caught SQL failures cannot publish fallback zeros as a successful report', async () => {
    await assert.rejects(execution.runReportBuild(async () => {
        execution.recordQueryFailure(new Error('SQL timed out'));
        return { count: 0 };
    }), /SQL timed out/);
    assert.deepEqual(await execution.runReportBuild(async () => ({ count: 10 })), { count: 10 });
});

test('failed refresh preserves the complete previous snapshot and retries can replace it', async () => {
    const previous = { sections: ['all', 'sections'], count: 25 };
    const entry = { snapshot: previous, updatedAtMs: 123, refreshPromise: null };
    let persisted = 0;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        await assert.rejects(refreshReportSnapshot(entry, async () => { throw new Error('query timeout'); }, async () => persisted++));
        assert.equal(entry.snapshot, previous);
        assert.equal(entry.updatedAtMs, 123);
        assert.equal(persisted, 0);
        assert.ok(entry.lastError);
        assert.ok(entry.retryAfterMs > Date.now());
        await refreshReportSnapshot(entry, async () => ({ sections: ['all', 'sections'], count: 30 }));
        assert.equal(entry.snapshot.count, 30);
        assert.equal(entry.lastError, null);
    } finally { console.warn = originalWarn; }
});

test('exact counts read all shards once and fail closed for unseeded, missing or invalid counters', async () => {
    const rows = [...countedTables].map(table_name => ({ table_name, row_count: '100', ready: 1, counter_version: 1 }));
    let reads = 0;
    const values = await loadExactTableCounts(async sql => { reads++; assert.doesNotMatch(sql, /COUNT\(\*\)/); return rows; });
    assert.equal(reads, 1);
    assert.equal(values.size, 8);
    for (const row_count of ['-1', '9007199254740992']) {
        await assert.rejects(loadExactTableCounts(async () => [{ ...rows[0], row_count }, ...rows.slice(1)]));
    }
    await assert.rejects(loadExactTableCounts(async () => rows.slice(1)), /missing/);
    await assert.rejects(loadExactTableCounts(async () => [{ ...rows[0], ready: 0 }, ...rows.slice(1)]), /not ready/);
});
