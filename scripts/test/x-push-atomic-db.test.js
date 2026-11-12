'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAtomicPushDatabase } = require('../../experiments/chrome-push/atomic-push-db-experiment.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(handler) {
    const commands = [];
    let released = 0, destroyed = 0;
    const connection = {
        query({ sql }, params, callback) {
            commands.push(sql);
            if (handler?.(sql, callback)) return;
            setImmediate(() => callback(null, []));
        },
        release() { released++; },
        destroy() { destroyed++; },
    };
    const pool = { getConnection: callback => setImmediate(() => callback(null, connection)) };
    return { pool, commands, counts: () => ({ released, destroyed }) };
}

test('experimental adapter requires an active transaction context', async () => {
    const f = fixture(), db = createAtomicPushDatabase(f.pool);
    await assert.rejects(db.queryDatabase('SELECT 1'), { code: 'X_PUSH_ATOMIC_CONTEXT_REQUIRED' });
    await assert.rejects(db.withDatabaseTransaction(() => {}), { code: 'X_PUSH_ATOMIC_CONTEXT_REQUIRED' });
    await db.run(async () => { await db.withDatabaseTransaction(async query => { await query('SELECT 1'); }); });
    assert.deepEqual(f.commands, ['START TRANSACTION', 'SELECT 1', 'COMMIT']);
    assert.deepEqual(f.counts(), { released: 1, destroyed: 0 });
});

test('caught nested errors or query failures force outer rollback', async () => {
    for (const mode of ['nested', 'query']) {
        const f = fixture((sql, callback) => { if (sql === 'FAIL') { setImmediate(() => callback(new Error('synthetic SQL failure'))); return true; } });
        const db = createAtomicPushDatabase(f.pool);
        await assert.rejects(db.run(async () => {
            try { await db.withDatabaseTransaction(async query => { if (mode === 'query') await query('FAIL'); else throw new Error('nested failure'); }); } catch {}
            await db.queryDatabase('OTHER');
        }), { code: 'X_PUSH_ATOMIC_ROLLBACK_ONLY' });
        assert.equal(f.commands.at(-1), 'ROLLBACK'); assert.equal(f.commands.includes('COMMIT'), false);
        assert.deepEqual(f.counts(), { released: 1, destroyed: 0 });
    }
});

test('deadline destroys the connection and late callbacks cannot issue SQL', async () => {
    const f = fixture(), db = createAtomicPushDatabase(f.pool, { transactionTimeoutMs: 20 });
    let unblock, lateError;
    const gate = new Promise(resolve => { unblock = resolve; });
    await assert.rejects(db.run(async () => {
        await gate;
        try { await db.queryDatabase('LATE WRITE'); } catch (error) { lateError = error; }
    }), { code: 'X_PUSH_ATOMIC_TIMEOUT' });
    unblock(); await delay(20);
    assert.equal(lateError?.code, 'X_PUSH_ATOMIC_STOPPED');
    assert.equal(f.commands.includes('LATE WRITE'), false);
    assert.deepEqual(f.counts(), { released: 0, destroyed: 1 });
});

test('abort destroys a running connection and rejects later nested work', async () => {
    const f = fixture(), db = createAtomicPushDatabase(f.pool), controller = new AbortController();
    let unblock, lateError;
    const gate = new Promise(resolve => { unblock = resolve; });
    const running = db.run(async () => { await gate; try { await db.withDatabaseTransaction(query => query('LATE WRITE')); } catch (error) { lateError = error; } }, { signal: controller.signal });
    await delay(10); controller.abort();
    await assert.rejects(running, { code: 'X_PUSH_ATOMIC_STOPPED' });
    unblock(); await delay(10);
    assert.equal(lateError?.code, 'X_PUSH_ATOMIC_STOPPED'); assert.equal(f.commands.includes('LATE WRITE'), false);
    assert.deepEqual(f.counts(), { released: 0, destroyed: 1 });
});

test('timeout after COMMIT submission reports an uncertain commit and never reuses the connection', async () => {
    const f = fixture((sql) => sql === 'COMMIT'), db = createAtomicPushDatabase(f.pool, { transactionTimeoutMs: 20 });
    await assert.rejects(db.run(async () => {}), { code: 'X_PUSH_ATOMIC_COMMIT_UNCERTAIN' });
    assert.deepEqual(f.commands, ['START TRANSACTION', 'COMMIT']);
    assert.deepEqual(f.counts(), { released: 0, destroyed: 1 });
});

test('a stalled acquisition stays single-flight and its late connection is released', async () => {
    let callback, released = 0;
    const db = createAtomicPushDatabase({ getConnection: cb => { callback = cb; } }, { acquireTimeoutMs: 10 });
    await assert.rejects(db.run(async () => {}), { code: 'X_PUSH_ATOMIC_ACQUIRE_TIMEOUT' });
    await assert.rejects(db.run(async () => {}), { code: 'X_PUSH_ATOMIC_BUSY' });
    callback(null, { release() { released++; } });
    assert.equal(released, 1);
});
