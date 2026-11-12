'use strict';
// Research-only local disposable DB experiment, not a runtime entry point.
// Requires the 4a6d082 git object and an explicit non-production loopback DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire, Module } = require('node:module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = process.cwd();
const projectRequire = createRequire(path.join(root, 'package.json'));
const { createTestDatabase } = projectRequire('./scripts/lib/automation-test-db');
const { insertSubscription } = projectRequire('./scripts/test/helpers/x-push-fixture.cjs');
const { lockOwner } = projectRequire('./src/automation/entitlements');
const current = projectRequire('./src/automation/x-push-store');
const oldFilename = path.join(root, 'src/automation/x-push-store-legacy-synthetic.cjs');
const oldModule = new Module(oldFilename, module);
oldModule.filename = oldFilename;
oldModule.paths = Module._nodeModulePaths(path.dirname(oldFilename));
oldModule._compile(execFileSync('git', ['show', '4a6d082:src/automation/x-push-store.js'], { cwd: root, encoding: 'utf8' }), oldFilename);
const old = oldModule.exports;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    t.after(() => db.close());
    const subscription = await insertSubscription(db);
    let clock = 1000;
    const options = { now: () => clock, leaseMs: 30000 };
    const legacy = old.createXPushStore(db, options), store = current.createXPushStore(db, options);
    const network = await legacy.claim({ ...subscription, workerId: 'legacy-network' });
    const receipt = await legacy.recordFrame(network, { version: 'fixture', data: 'AA', headers: { encoding: 'aes128gcm' }, status: 'received', ackCode: 100 });
    await legacy.release(network, { state: 'error', reasonCode: 'X_PUSH_SOCKET_CLOSED' });
    return { db, subscription, store, legacy, network, receipt, now: () => clock };
}

// Illustrates mutual exclusion only; not the complete production algorithm.
async function runAtomic(f, inside, fail = false) {
    const execute = f.atomicDb ? f.atomicDb.run : f.db.withDatabaseTransaction;
    return execute(async query => {
        const { ownerUserId, subscriptionId } = f.subscription;
        await lockOwner(query, ownerUserId);
        const subscription = (await query('SELECT * FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE', [subscriptionId, ownerUserId]))[0];
        const receiver = (await query('SELECT * FROM automation_x_push_receivers WHERE subscription_id=? FOR UPDATE', [subscriptionId]))[0];
        assert.ok(!receiver.lease_token || Number(receiver.lease_expires_at_ms) <= f.now());
        const token = randomBytes(32).toString('hex'), lease = { ...f.subscription, revision: Number(subscription.revision), token, expiresAtMs: f.now() + 5000, sealedEnvelope: JSON.parse(subscription.sealed_json) };
        await query('UPDATE automation_x_push_receivers SET lease_token=?,worker_id=?,lease_expires_at_ms=? WHERE subscription_id=?', [token, 'atomic-test', lease.expiresAtMs, subscriptionId]);
        assert.equal(await f.store.assertLease(lease), true);
        await inside(lease);
        if (fail) throw new Error('synthetic transaction failure');
        const update = await query('UPDATE automation_x_push_receivers SET lease_token=NULL,worker_id=NULL,lease_expires_at_ms=NULL WHERE subscription_id=? AND lease_token=?', [subscriptionId, token]);
        assert.equal(update.affectedRows, 1);
    });
}

test('atomic transient token makes legacy retry wait and preserves its update', { timeout: 30000 }, async t => {
    const f = await setup(t);
    let begin; const gate = new Promise(resolve => { begin = resolve; });
    let finished = false;
    const lateRetry = gate.then(() => f.legacy.recordRetry({ ...f.subscription, revision: f.network.revision }, 'X_PUSH_SOCKET_CLOSED', 5000))
        .then(value => { finished = true; return value; });
    await runAtomic(f, async lease => {
        begin(); await delay(100); assert.equal(finished, false, 'legacy retry must wait on the owner/receiver lock');
        assert.equal(await f.store.markRouted(lease, f.receipt.id), true);
    });
    const retry = await lateRetry;
    assert.equal(retry.recorded, true); assert.equal(retry.retryAtMs, 6000);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: f.receipt.id })).status, 'routed');
    const status = await f.legacy.status(f.subscription); assert.equal(status.state, 'error'); assert.equal(status.retryAtMs, 6000);
});

test('legacy connection waits for commit and sees no uncommitted token or false listening', { timeout: 30000 }, async t => {
    const f = await setup(t);
    await f.db.queryDatabase("UPDATE automation_x_push_receivers SET state='listening',lease_token=NULL,lease_expires_at_ms=0 WHERE subscription_id=?", [f.subscription.subscriptionId]);
    let beginClaim, beginStatus;
    const claimGate = new Promise(resolve => { beginClaim = resolve; });
    const statusGate = new Promise(resolve => { beginStatus = resolve; });
    let finished = false;
    const claim = claimGate.then(() => f.legacy.claim({ ...f.subscription, workerId: 'legacy-next' })).then(value => { finished = true; return value; });
    const status = statusGate.then(() => f.legacy.status(f.subscription));
    await runAtomic(f, async () => {
        beginStatus(); beginClaim(); await delay(100);
        assert.equal(finished, false); assert.equal((await status).state, 'stopped');
    });
    const lease = await claim; assert.ok(lease); await f.legacy.release(lease);
});

test('failed atomic work rolls back the transient token and inbox mutation', { timeout: 30000 }, async t => {
    const f = await setup(t);
    await assert.rejects(runAtomic(f, lease => f.store.markRouted(lease, f.receipt.id), true), /synthetic transaction failure/);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: f.receipt.id })).status, 'received');
    const lease = await f.legacy.claim({ ...f.subscription, workerId: 'legacy-successor' }); assert.ok(lease); await f.legacy.release(lease);
});

async function actualRuntimeFixture(t, failureMode = '', transactionTimeoutMs = 5000) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    const { insertSubscription, encrypted, vault, ownerUserId } = projectRequire('./scripts/test/helpers/x-push-fixture.cjs');
    const { createXPushGateway } = projectRequire('./src/automation/x-push-gateway');
    const { createXPushRuntime } = projectRequire('./src/automation/x-push-runtime');
    const { createXEventRouter } = projectRequire('./src/automation/x-event-router');
    const { createQueue } = projectRequire('./src/automation/queue');
    const entitlement = projectRequire('./src/automation/entitlements');
    const now = Date.parse('2026-10-14T03:00:00Z'), clock = () => now;
    const subscription = await insertSubscription(db);
    await db.withDatabaseTransaction(query => entitlement.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 3, intervalMinutes: 5 }));
    const mysql = projectRequire('mysql');
    const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.AUTOMATION_TEST_DB_PORT), user: 'root',
        password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: db.schema, connectionLimit: 1, supportBigNumbers: true, bigNumberStrings: true });
    const atomicDb = projectRequire('./experiments/chrome-push/atomic-push-db-experiment.cjs').createAtomicPushDatabase(pool, { transactionTimeoutMs });
    const legacy = old.createXPushStore(db, { now: clock, leaseMs: 30000 });
    const store = current.createXPushStore(atomicDb, { now: clock, leaseMs: 30000 });
    const network = await legacy.claim({ ...subscription, workerId: 'legacy-network' });
    const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','fixture',1,'ready','free',?,'bound',1,?,?)", [ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
    await db.withDatabaseTransaction(query => entitlement.assignSlot(query, ownerUserId, 'x', String(monitor.insertId)));
    const payload = { notificationType: 'tweet', author: { id: '12345', handle: 'example' }, url: 'https://x.com/example/status/1234567890123456789', text: 'fixture' };
    const cipher = await encrypted(subscription.file, payload);
    const receipt = await legacy.recordFrame(network, { version: 'encrypted-fixture', data: cipher.data, headers: cipher.headers, status: 'received', ackCode: 100 });
    await legacy.release(network, { state: 'error', reasonCode: 'X_PUSH_SOCKET_CLOSED' });
    const realQueue = createQueue(atomicDb, {}, { clock, rolloutMode: 'public' });
    const queue = failureMode === 'throw' ? { ...realQueue, routeX: async input => { await realQueue.routeX(input); throw new Error('synthetic failure after queue insertion'); } }
        : failureMode === 'caught' ? { ...realQueue, routeX: async input => {
            const value = await realQueue.routeX(input);
            try { await atomicDb.withDatabaseTransaction(async () => { throw new Error('synthetic nested failure'); }); } catch {}
            return value;
        } } : realQueue;
    const gateway = createXPushGateway(atomicDb, { enabled: true, store, privateWorkerVault: vault, now: clock, rolloutMode: 'public' });
    const realRouter = createXEventRouter(atomicDb, queue, { clock });
    let unblock, reached, completed;
    const gate = new Promise(resolve => { unblock = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    const lateCompleted = new Promise(resolve => { completed = resolve; });
    const router = failureMode === 'stall' ? { ...realRouter, routeReceived: async input => {
        reached(); await gate; try { return await realRouter.routeReceived(input); } finally { completed(); }
    } } : realRouter;
    const runtime = createXPushRuntime(atomicDb, queue, { enabled: true, gateway, router, clock,
        rolloutMode: 'public', processingPolicy: 'batch', assertAllowed: () => {}, pageSize: 1, listCandidates: async () => [] });
    t.after(async () => { await runtime.stop(); await new Promise(resolve => pool.end(resolve)); await db.close(); });
    return { db, atomicDb, subscription, store, legacy, network, receipt, runtime, now: clock, unblock, entered, lateCompleted };
}

test('transaction-scoped transient token runs real encrypted batch routing with legacy retry pending', { timeout: 30000 }, async t => {
    const f = await actualRuntimeFixture(t);
    let begin; const gate = new Promise(resolve => { begin = resolve; });
    let finished = false;
    const retry = gate.then(() => f.legacy.recordRetry({ ...f.subscription, revision: f.network.revision }, 'X_PUSH_SOCKET_CLOSED', 5000)).then(v => { finished = true; return v; });
    await runAtomic(f, async lease => {
        const result = await f.runtime.drain(lease, { recoverySignal: new AbortController().signal });
        assert.equal(result.state, 'processed'); assert.equal(result.processed, 1);
        begin(); await delay(100); assert.equal(finished, false);
    });
    assert.equal((await retry).recorded, true);
    assert.equal((await f.legacy.getInbox({ ...f.subscription, id: f.receipt.id })).status, 'routed');
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
});

test('actual queue insert rolls back when routing fails inside the same transaction', { timeout: 30000 }, async t => {
    const f = await actualRuntimeFixture(t, 'throw');
    await assert.rejects(runAtomic(f, lease => f.runtime.drain(lease, { recoverySignal: new AbortController().signal })), /synthetic failure after queue insertion/);
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 0);
    assert.equal((await f.legacy.getInbox({ ...f.subscription, id: f.receipt.id })).status, 'received');
    const lease = await f.legacy.claim({ ...f.subscription, workerId: 'legacy-successor' }); assert.ok(lease); await f.legacy.release(lease);
});

test('caught nested routing failure marks the real database transaction rollback-only', { timeout: 30000 }, async t => {
    const f = await actualRuntimeFixture(t, 'caught');
    await assert.rejects(runAtomic(f, lease => f.runtime.drain(lease, { recoverySignal: new AbortController().signal })), { code: 'X_PUSH_ATOMIC_ROLLBACK_ONLY' });
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 0);
    assert.equal((await f.legacy.getInbox({ ...f.subscription, id: f.receipt.id })).status, 'received');
});

test('timed-out real drain destroys its connection and cannot write after legacy takeover', { timeout: 30000 }, async t => {
    const f = await actualRuntimeFixture(t, 'stall', 250);
    const attempt = runAtomic(f, lease => f.runtime.drain(lease, { recoverySignal: new AbortController().signal }));
    await f.entered;
    await assert.rejects(attempt, { code: 'X_PUSH_ATOMIC_TIMEOUT' });
    const lease = await f.legacy.claim({ ...f.subscription, workerId: 'legacy-successor' });
    assert.ok(lease); await f.legacy.release(lease);
    f.unblock(); await f.lateCompleted;
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 0);
    assert.equal((await f.legacy.getInbox({ ...f.subscription, id: f.receipt.id })).status, 'received');
});

test('documents that an already-running MariaDB query can retain locks after the client deadline', { timeout: 30000 }, async t => {
    const f = await actualRuntimeFixture(t, '', 250);
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const attempt = runAtomic(f, async () => { entered(); await f.atomicDb.queryDatabase('SELECT SLEEP(4)'); });
    await started;
    await assert.rejects(attempt, { code: 'X_PUSH_ATOMIC_TIMEOUT' });
    let claimed = false;
    const start = Date.now();
    const successor = f.legacy.claim({ ...f.subscription, workerId: 'legacy-after-slow-sql' }).then(value => { claimed = true; return value; });
    try {
        await delay(1000);
        assert.equal(claimed, false, 'recheck this experiment if the server now cancels its running query on client disconnect');
    } finally {
        const lease = await successor;
        if (lease) await f.legacy.release(lease);
        t.diagnostic(`synthetic successor claim completed after ${Date.now() - start} ms`);
    }
});

test('MariaDB statement time limit interrupts this synthetic sleep, without proving a universal bound', { timeout: 30000 }, async t => {
    const f = await actualRuntimeFixture(t, '', 250);
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const attempt = runAtomic(f, async () => {
        await f.atomicDb.queryDatabase('SET SESSION max_statement_time=0.5');
        entered(); await f.atomicDb.queryDatabase('SELECT SLEEP(4)');
    });
    await started;
    await assert.rejects(attempt, { code: 'X_PUSH_ATOMIC_TIMEOUT' });
    let claimed = false;
    const start = Date.now();
    const successor = f.legacy.claim({ ...f.subscription, workerId: 'legacy-server-limit' }).then(value => { claimed = true; return value; });
    try {
        await delay(2000);
        assert.equal(claimed, true, 'this synthetic sleep remained locked despite the MariaDB statement setting');
    } finally {
        const lease = await successor;
        if (lease) await f.legacy.release(lease);
        t.diagnostic(`synthetic successor claim completed within ${Date.now() - start} ms`);
    }
});

test('MariaDB session statement setting survives commit on a reused connection', { timeout: 30000 }, async t => {
    const f = await actualRuntimeFixture(t);
    await f.atomicDb.run(query => query('SET SESSION max_statement_time=0.5'));
    const value = await f.atomicDb.run(async query => Number((await query('SELECT @@max_statement_time AS n'))[0].n));
    assert.equal(value, 0.5, 'a production implementation must not leak session settings to a shared pool');
});
