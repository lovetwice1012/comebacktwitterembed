'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReservedDbExperiment } = require('../../experiments/chrome-push/reserved-db-experiment.cjs');

function fakePool(handler = (_sql, done) => setImmediate(() => done(null, [])), connectionLimit = 3) {
    let checkouts = 0, releases = 0, destroyed = 0; const statements = [];
    const pool = { config: { connectionLimit }, getConnection(done) {
        checkouts++;
        setImmediate(() => done(null, { query({ sql }, params, callback) { statements.push(sql); handler(sql, callback); },
            release() { releases++; }, destroy() { destroyed++; } }));
    } };
    return { pool, statements, stats: () => ({ checkouts, releases, destroyed }) };
}
const immediate = () => new Promise(resolve => setImmediate(resolve));

test('low-priority checkouts are bounded and cancelled waiters do not take capacity', async () => {
    const blocked = [], f = fakePool((sql, done) => sql === 'WAIT' ? blocked.push(done) : setImmediate(() => done(null, [])));
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3, reservedConnections: 1, maxWaiting: 2 });
    const one = db.runBackground(() => db.queryDatabase('WAIT'));
    const two = db.runBackground(() => db.queryDatabase('WAIT'));
    for (let attempt = 0; attempt < 20 && blocked.length < 2; attempt++) await immediate();
    assert.equal(blocked.length, 2); assert.equal(db.status().active, 2);
    const controller = new AbortController();
    const three = db.runBackground(() => db.queryDatabase('LATE'), { signal: controller.signal });
    const four = db.runBackground(() => db.queryDatabase('AFTER'));
    await assert.rejects(db.runBackground(() => db.queryDatabase('OVER')), { code: 'RESERVED_DB_QUEUE_FULL' });
    controller.abort(); await assert.rejects(three, { code: 'RESERVED_DB_STOPPED' });
    assert.equal(f.stats().checkouts, 2); blocked.shift()(null, []); await one;
    await four; assert.equal(f.stats().checkouts, 3); assert.equal(db.status().active, 1);
    blocked.shift()(null, []); await two; assert.equal(db.status().active, 0); db.stop();
});

test('abort during an executing query retains capacity until its callback, then rolls back', async () => {
    let finish; const f = fakePool((sql, done) => sql === 'WAIT' ? (finish = done) : setImmediate(() => done(null, [])), 2);
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 2, reservedConnections: 1 });
    const controller = new AbortController();
    const task = db.runBackground(() => db.withDatabaseTransaction(async query => { await query('WAIT'); }), { signal: controller.signal });
    while (!finish) await immediate(); controller.abort();
    const next = db.runBackground(() => db.queryDatabase('AFTER'));
    await immediate(); assert.equal(db.status().active, 1); assert.equal(db.status().waiting, 1);
    finish(null, []); await assert.rejects(task, { code: 'RESERVED_DB_STOPPED' }); await next;
    assert.deepEqual(f.statements, ['START TRANSACTION', 'WAIT', 'ROLLBACK', 'AFTER']);
    assert.equal(db.status().poisoned, 0); db.stop();
});

test('uncertain protocol failure consumes its reservation rather than starting more work', async () => {
    const f = fakePool((sql, done) => setImmediate(() => done(Object.assign(new Error('fixture'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT', fatal: true }))), 2);
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 2, reservedConnections: 1 });
    await assert.rejects(db.runBackground(() => db.queryDatabase('WAIT')), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    assert.deepEqual(f.stats(), { checkouts: 1, releases: 0, destroyed: 1 });
    assert.equal(db.status().poisoned, 1);
    const controller = new AbortController(), later = db.runBackground(() => db.queryDatabase('AFTER'), { signal: controller.signal });
    await immediate(); assert.equal(db.status().waiting, 1); assert.equal(f.stats().checkouts, 1);
    controller.abort(); await assert.rejects(later, { code: 'RESERVED_DB_STOPPED' }); db.stop();
});

test('nested caught errors force rollback and the shared context cannot write after its owner returns', async () => {
    const f = fakePool((sql, done) => setImmediate(() => sql === 'FAIL' ? done(new Error('fixture')) : done(null, [])));
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3, reservedConnections: 1 });
    let late;
    await assert.rejects(db.runBackground(async () => db.withDatabaseTransaction(async () => {
        try { await db.withDatabaseTransaction(async query => query('FAIL')); } catch {}
    })), { code: 'RESERVED_DB_ROLLBACK_ONLY' });
    await db.runBackground(async () => { late = new Promise(resolve => setImmediate(() => resolve(db.queryDatabase('LATE')))); });
    await assert.rejects(late, { code: 'RESERVED_DB_STOPPED' });
    assert.deepEqual(f.statements, ['START TRANSACTION', 'FAIL', 'ROLLBACK']); db.stop();
});

test('a failed COMMIT poisons a slot because the database result is uncertain', async () => {
    const f = fakePool((sql, done) => setImmediate(() => sql === 'COMMIT' ? done(new Error('fixture')) : done(null, [])));
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3, reservedConnections: 1 });
    await assert.rejects(db.runBackground(() => db.withDatabaseTransaction(async query => { await query('WORK'); })),
        { code: 'RESERVED_DB_COMMIT_UNCERTAIN' });
    assert.equal(db.status().poisoned, 1); assert.equal(f.stats().destroyed, 1); db.stop();
});

test('a timed-out caller does not release the reservation of a still-running SQL operation', async () => {
    let finish; const f = fakePool((sql, done) => sql === 'WAIT' ? (finish = done) : setImmediate(() => done(null, [])), 2);
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 2, reservedConnections: 1 });
    let lateError;
    await db.runBackground(async () => {
        const sql = db.queryDatabase('WAIT');
        sql.catch(error => { lateError = error.code; });
        while (!finish) await immediate();
        // Models an outer gateway deadline which returns before the database.
        await Promise.race([sql, new Promise(resolve => setTimeout(resolve, 10))]);
    });
    assert.equal(db.status().active, 1);
    const controller = new AbortController();
    const next = db.runBackground(() => db.queryDatabase('AFTER'), { signal: controller.signal });
    await immediate(); assert.equal(db.status().waiting, 1); assert.equal(f.stats().checkouts, 1);
    finish(null, []); for (let i = 0; i < 20 && !lateError; i++) await immediate();
    assert.equal(lateError, 'RESERVED_DB_STOPPED'); await next;
    assert.equal(db.status().active, 0); db.stop();
});

test('the reservation refuses an incorrect pool limit or access outside a workload', async () => {
    const f = fakePool();
    assert.throws(() => createReservedDbExperiment({ pool: f.pool, connectionLimit: 4 }), { code: 'RESERVED_DB_CONFIG_INVALID' });
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 });
    await assert.rejects(db.queryDatabase('SELECT 1'), { code: 'RESERVED_DB_CONTEXT_REQUIRED' });
    db.stop();
});

test('a pool has one shared reservation, and a cleanly stopped reservation can be replaced', async () => {
    const f = fakePool();
    assert.throws(() => createReservedDbExperiment({ pool: f.pool, connectionLimit: 4 }), { code: 'RESERVED_DB_CONFIG_INVALID' });
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 });
    assert.throws(() => createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 }), { code: 'RESERVED_DB_POOL_IN_USE' });
    await Promise.all([db.runBackground(() => db.queryDatabase('FIRST')), db.runBackground(() => db.queryDatabase('SECOND'))]);
    assert.equal(db.status().active, 0);
    db.stop();
    const replacement = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 });
    await replacement.runBackground(() => replacement.queryDatabase('AFTER'));
    replacement.stop();
});

test('stopping an active reservation prevents replacement until its connection is returned', async () => {
    let finish; const f = fakePool((sql, done) => sql === 'WAIT' ? (finish = done) : setImmediate(() => done(null, [])));
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 });
    const pending = db.runBackground(() => db.queryDatabase('WAIT'));
    const rejected = assert.rejects(pending, { code: 'RESERVED_DB_STOPPED' });
    while (!finish) await immediate();
    db.stop();
    assert.throws(() => createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 }), { code: 'RESERVED_DB_POOL_IN_USE' });
    finish(null, []); await rejected;
    assert.equal(f.stats().releases, 1);
    const replacement = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 });
    replacement.stop();
});

test('an uncertain reservation cannot be bypassed by stopping and recreating it on the same pool', async () => {
    const f = fakePool((_sql, done) => setImmediate(() => done(Object.assign(new Error('fixture'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT', fatal: true }))));
    const db = createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 });
    await assert.rejects(db.runBackground(() => db.queryDatabase('WAIT')), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    assert.equal(db.status().poisoned, 1); db.stop();
    assert.throws(() => createReservedDbExperiment({ pool: f.pool, connectionLimit: 3 }), { code: 'RESERVED_DB_POOL_IN_USE' });
    const fresh = fakePool(), replacement = createReservedDbExperiment({ pool: fresh.pool, connectionLimit: 3 });
    await replacement.runBackground(() => replacement.queryDatabase('OK')); replacement.stop();
});
