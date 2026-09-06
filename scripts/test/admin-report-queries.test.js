'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { wrapPrismaForReports, listQueries, cancelQuery } = require('../../src/adminSupport/reportQueries');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let index = 0; index < 100; index++) { const value = await fn(); if (value) return value; await pause(10); } throw new Error('Timed out waiting for query registration'); }
async function fixture(t) {
    const original = process.env.ADMIN_QUERY_REGISTRY_DIR;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-report-query-'));
    process.env.ADMIN_QUERY_REGISTRY_DIR = directory;
    t.after(async () => { if (original === undefined) delete process.env.ADMIN_QUERY_REGISTRY_DIR; else process.env.ADMIN_QUERY_REGISTRY_DIR = original; await fs.rm(directory, { recursive: true, force: true }); });
    let resolve, reject, markedSql, released = false;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const prisma = { $transaction: async callback => {
        try { return await callback({ $queryRawUnsafe: async (sql, ...values) => {
            if (sql.startsWith('SELECT CONNECTION_ID()')) return [{ connection_id: 71, database_user: 'report_owner@localhost', database_name: 'fixture_db' }];
            markedSql = sql;
            assert.deepEqual(values, [3]);
            return pending;
        } }); } finally { released = true; }
    } };
    const wrapped = wrapPrismaForReports(prisma);
    const work = wrapped.$queryRawUnsafe('SELECT /*+ MAX_EXECUTION_TIME(1000) */ ? AS value', 3).catch(error => error);
    const entry = await until(async () => (await listQueries()).queries[0]);
    return { directory, work, entry, resolve, reject, markedSql: () => markedSql, released: () => released };
}

test('report query cancellation verifies registered SQL ownership and retains connection through the kill handshake', async t => {
    const f = await fixture(t);
    const calls = [];
    const result = await cancelQuery({ queryId: f.entry.queryId }, { query: async sql => {
        calls.push(sql);
        if (sql === 'SHOW FULL PROCESSLIST') return [{ Id: 71, User: 'report_owner', db: 'fixture_db', Command: 'Query', Info: f.markedSql() }];
        assert.equal(sql, 'KILL QUERY 71');
        f.reject(Object.assign(new Error('Query interrupted'), { code: 'ER_QUERY_INTERRUPTED' }));
        await pause(50);
        assert.equal(f.released(), false, 'connection cannot return to pool while cancellation owns its lock');
        return [];
    } });
    assert.equal(result.cancelled, true);
    assert.match((await f.work).message, /interrupted/);
    assert.equal(f.released(), true);
    assert.deepEqual(calls, ['SHOW FULL PROCESSLIST', 'KILL QUERY 71']);
    const final = (await listQueries({ includeCompleted: true })).queries[0];
    assert.equal(final.state, 'failed');
    assert.equal(final.cancellation.queryId, f.entry.queryId);
});
test('query cancellation refuses unrelated current SQL and does not accept arbitrary connection IDs', async t => {
    const f = await fixture(t);
    const calls = [];
    const refused = await cancelQuery({ queryId: f.entry.queryId }, { query: async sql => {
        calls.push(sql);
        return [{ Id: 71, User: 'report_owner', db: 'fixture_db', Command: 'Query', Info: 'SELECT unrelated_data' }];
    } });
    assert.equal(refused.cancelled, false);
    assert.deepEqual(calls, ['SHOW FULL PROCESSLIST']);
    await assert.rejects(cancelQuery({ queryId: '71; KILL 1' }), /registered query UUID/);
    f.resolve([{ value: 3 }]);
    assert.deepEqual(await f.work, [{ value: 3 }]);
});
test('automatic cancellation refuses a registered query before its deadline and completed queries remain untouched', async t => {
    const f = await fixture(t);
    const guarded = await cancelQuery({ queryId: f.entry.queryId, onlyIfOverdue: true }, { query: () => { throw new Error('Database must not be touched for a query within budget'); } });
    assert.equal(guarded.reason, 'query_not_overdue');
    f.resolve([{ value: 3 }]);
    await f.work;
    const completed = await cancelQuery({ queryId: f.entry.queryId }, { query: () => { throw new Error('Completed query must not be touched'); } });
    assert.equal(completed.reason, 'query_not_running');
});

test('report ownership comments do not introduce named parameters into positional MySQL statements', async t => {
    const f = await fixture(t);
    assert.match(f.entry.marker, /^\/\*cbte-report-query [0-9a-f-]{36}\*\/$/);
    assert.equal(f.entry.marker.includes(':'), false);
    assert.equal(f.markedSql(), `${f.entry.marker} SELECT /*+ MAX_EXECUTION_TIME(1000) */ ? AS value`);
    assert.equal(f.entry.parameterCount, 1);
    f.resolve([{ value: 3 }]);
    assert.deepEqual(await f.work, [{ value: 3 }]);
});
