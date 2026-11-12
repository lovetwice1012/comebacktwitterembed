'use strict';
// Isolated database experiment only; this does not enable a product scheduler.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, encrypted, vault, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const capacity = require('../../src/automation/push-capacity');
const { createXProcessingSettings } = require('../../src/automation/x-processing-settings');
const { createBoundedReceiptScheduler, createFairLeaseScanner } = require('../../experiments/chrome-push/bounded-receipt-scheduler.cjs');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), admin = { userId: '666666666666666666', isAdmin: true };
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('experimental concurrency bound leaves fixture DB connections free while two SQL calls stall', { skip: !port, timeout: 30000 }, async t => {
    const db = await createTestDatabase(port), mysql = require('mysql');
    const control = mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: db.schema });
    const query = (sql, args = []) => new Promise((resolve, reject) => control.query(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
    const names = [`bounded-a-${db.schema}`, `bounded-b-${db.schema}`]; let scheduler, jobs = [];
    t.after(async () => {
        scheduler?.stop();
        for (const name of names) { try { await query('SELECT RELEASE_LOCK(?)', [name]); } catch {} }
        await Promise.allSettled(jobs); await new Promise(resolve => control.end(resolve)); await db.close();
    });
    for (const name of names) assert.equal(Number((await query('SELECT GET_LOCK(?,5) AS held', [name]))[0].held), 1);
    scheduler = createBoundedReceiptScheduler({ concurrency: 2, maxPending: 2, executionTimeoutMs: 250, isCurrent: () => true, execute: async job => {
        await db.queryDatabase('SELECT GET_LOCK(?,5) AS acquired', [names[Number(job.key)]]);
        return job.signal.aborted ? { state: 'stopped' } : { state: 'processed' };
    } });
    jobs = ['0', '1'].map(key => scheduler.enqueue({ key, token: key, received: true }));
    let waiting = 0;
    for (let attempt = 0; attempt < 150 && waiting < 2; attempt++) {
        waiting = Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'SELECT GET_LOCK(%'", [db.schema]))[0].n);
        if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 2, 'both synthetic SQL calls should be waiting');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(scheduler.status().timedOut, 2); assert.equal(scheduler.status().active, 2);
    assert.equal(Number((await db.queryDatabase('SELECT 42 AS n'))[0].n), 42);
    for (const name of names) await query('SELECT RELEASE_LOCK(?)', [name]);
    assert((await Promise.all(jobs)).every(result => result.state === 'cancelled_uncertain'));
});

test('full experimental scheduler retains encrypted realtime receipts until a fair later scan', { skip: !port, timeout: 60000 }, async t => {
    const db = await createTestDatabase(port); let runtime, scheduler; const hold = pending();
    t.after(async () => { hold.resolve(); scheduler?.stop(); await runtime?.stop(); await db.close(); });
    const now = Date.parse('2026-10-14T03:00:00Z'), clock = () => now;
    await db.withDatabaseTransaction(async query => {
        await entitlements.savePlanPolicy(query, admin, { planId: 'SchedulerFixture', label: 'fixture', slotLimit: 9,
            minuteLimit: 9, dayLimit: 50, priority: 17, intervalMinutes: 15 });
        const old = await capacity.getPlanCapacity(query, admin, 'SchedulerFixture');
        await capacity.savePlanCapacity(query, admin, 'SchedulerFixture', { eligible: false, specialSlotLimit: 0,
            realtimeEnabled: true, expectedUpdatedAtMs: old.updatedAtMs });
        await entitlements.setUserPlan(query, admin, ownerUserId, 'SchedulerFixture');
    });
    await createXProcessingSettings(db, { rolloutMode: 'public', now: clock }).save({ userId: ownerUserId }, { mode: 'realtime', expectedMode: 'batch' });
    const store = createXPushStore(db, { now: clock, leaseMs: 300000 }), items = [];
    for (let i = 0; i < 3; i++) {
        const subscription = await insertSubscription(db), accountId = String(12345 + i);
        const lease = await store.claim({ ...subscription, workerId: `scheduler-fixture-${i}` });
        const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,?, 'example','fixture',1,'ready','free',?,'bound',1,?,?)",
            [ownerUserId, accountId, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
        await db.withDatabaseTransaction(query => entitlements.assignSlot(query, ownerUserId, 'x', String(monitor.insertId)));
        const payload = { notificationType: 'tweet', author: { id: accountId, handle: 'example' },
            url: `https://x.com/example/status/${1234567890123456700n + BigInt(i)}`, text: 'synthetic' };
        const wire = await encrypted(subscription.file, payload);
        const inbox = await store.recordFrame(lease, { version: `test-${i}`, data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 });
        items.push({ lease, inbox });
    }
    const queue = createQueue(db, {}, { clock, rolloutMode: 'public' });
    const gateway = createXPushGateway(db, { enabled: true, store, privateWorkerVault: vault, now: clock, rolloutMode: 'public' });
    runtime = createXPushRuntime(db, queue, { enabled: true, gateway, clock, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed() {} });
    const entered = pending();
    scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1,
        isCurrent: ({ key, token }) => items.some(item => item.lease.subscriptionId === key && item.lease.token === token), execute: async job => {
        if (job.key === items[0].lease.subscriptionId) { entered.resolve(); await hold.promise; }
        const item = items.find(candidate => candidate.lease.subscriptionId === job.key);
        return runtime.drain(item.lease, { ...(job.periodic ? {} : { received: true, inbox: item.inbox }), recoverySignal: job.signal });
    } });
    const submit = item => scheduler.enqueue({ key: item.lease.subscriptionId, token: item.lease.token, received: true });
    const first = submit(items[0]); await entered.promise;
    const second = submit(items[1]);
    assert.equal((await submit(items[2])).state, 'deferred');
    assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_x_push_inbox WHERE status='received'"))[0].n), 3);
    assert.equal(Number((await db.queryDatabase('SELECT 1 AS n'))[0].n), 1);
    // A recovery callback must wait for space or its lease deadline. Once the
    // deadline aborts, a delayed old callback cannot use the released lease.
    const previousLease = items[2].lease, recoveryController = new AbortController();
    const recovery = scheduler.enqueue({ key: previousLease.subscriptionId, token: previousLease.token,
        recovery: true, signal: recoveryController.signal });
    assert.equal(scheduler.status().recoveryWaiting, 1);
    recoveryController.abort(); assert.equal((await recovery).state, 'stopped');
    await store.release(previousLease);
    items[2].lease = await store.claim({ subscriptionId: previousLease.subscriptionId, ownerUserId, workerId: 'scheduler-successor' });
    assert.ok(items[2].lease); assert.notEqual(items[2].lease.token, previousLease.token);
    assert.equal((await runtime.drain(previousLease, { received: true, inbox: items[2].inbox, recoverySignal: recoveryController.signal })).state, 'stopped');
    await assert.rejects(runtime.drain(previousLease, { received: true, inbox: items[2].inbox,
        recoverySignal: new AbortController().signal }), { code: 'X_PUSH_LEASE_LOST' });
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
    hold.resolve(); assert.equal((await first).processed, 1); assert.equal((await second).processed, 1);
    // Scan the same owned leases repeatedly. The rotating cursor resumes at
    // the first unadmitted key rather than assuming the hint was accepted.
    const scanner = createFairLeaseScanner(scheduler), sessions = items.map(item => ({ key: item.lease.subscriptionId, token: item.lease.token }));
    let routed = 0;
    for (let attempts = 0; attempts < 100 && routed < 3; attempts++) {
        scanner.scan(sessions);
        routed = Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_x_push_inbox WHERE status='routed'"))[0].n);
        if (routed < 3) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(routed, 3);
    for (let attempts = 0; attempts < 100 && (scheduler.status().active || scheduler.status().pending); attempts++)
        await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(scheduler.status().active + scheduler.status().pending, 0);
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 3);
    assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_x_push_inbox WHERE status='routed'"))[0].n), 3);
    assert.equal((await submit(items[2])).processed, 0);
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 3);
});
