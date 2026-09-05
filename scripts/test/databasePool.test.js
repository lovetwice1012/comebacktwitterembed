'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabasePool } = require('../../src/databasePool');

function harness(fail = () => false) {
    const calls = [];
    let nextId = 0;
    let config;
    const target = id => ({
        query: (options, params, callback) => {
            calls.push({ id, sql: options.sql, timeout: options.timeout, params });
            setImmediate(() => fail(options.sql) ? callback(new Error(options.sql)) : callback(null, [id]));
        },
        release: () => calls.push({ id, release: true }),
        destroy: () => calls.push({ id, destroy: true }),
    });
    const pool = {
        ...target('pool'),
        getConnection: callback => callback(null, target(++nextId)),
        end: callback => callback(),
    };
    const db = createDatabasePool({ createPool: options => { config = options; return pool; }, credentials: {}, env: {} });
    return { db, calls, config };
}

test('database uses bounded connection and wait queues with finite query timeouts', async () => {
    const { db, calls, config } = harness();
    assert.equal(config.connectionLimit, 8);
    assert.equal(config.queueLimit, 512);
    await db.query('SELECT ?', [1]);
    assert.deepEqual(calls[0], { id: 'pool', sql: 'SELECT ?', params: [1], timeout: 30000 });
    await db.close();
});

test('concurrent transactions keep each statement on its own connection and isolate ordinary reads', async () => {
    const { db, calls } = harness();
    await Promise.all([
        db.withTransaction(async query => { await query('A1'); await query('A2'); }),
        db.withTransaction(async query => { await query('B1'); await query('B2'); }),
        db.query('READ'),
    ]);
    assert.deepEqual(calls.filter(call => call.id === 1 && call.sql).map(call => call.sql), ['START TRANSACTION', 'A1', 'A2', 'COMMIT']);
    assert.deepEqual(calls.filter(call => call.id === 2 && call.sql).map(call => call.sql), ['START TRANSACTION', 'B1', 'B2', 'COMMIT']);
    assert.equal(calls.find(call => call.sql === 'READ').id, 'pool');
    assert.equal(calls.filter(call => call.release).length, 2);
});

test('failed transactions roll back before reuse; failed rollback discards the connection', async () => {
    for (const failRollback of [false, true]) {
        const { db, calls } = harness(sql => sql === 'WRITE' || (failRollback && sql === 'ROLLBACK'));
        await assert.rejects(db.withTransaction(query => query('WRITE')), /WRITE/);
        assert.deepEqual(calls.filter(call => call.sql).map(call => call.sql), ['START TRANSACTION', 'WRITE', 'ROLLBACK']);
        assert.equal(calls.at(-1)[failRollback ? 'destroy' : 'release'], true);
    }
});

test('connection acquisition failure rejects work without running the transaction', async () => {
    const db = createDatabasePool({ credentials: {}, env: {}, createPool: () => ({
        getConnection: callback => callback(new Error('POOL_ENQUEUELIMIT')),
    }) });
    await assert.rejects(db.withTransaction(() => assert.fail()), /POOL_ENQUEUELIMIT/);
});
