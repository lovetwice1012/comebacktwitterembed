'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { fixture: transferFixture, insertSubscription, encrypted, vault, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createXEventRouter } = require('../../src/automation/x-event-router');
const { createQueue } = require('../../src/automation/queue');
const { createXProcessingSettings } = require('../../src/automation/x-processing-settings');
const entitlements = require('../../src/automation/entitlements');
const capacity = require('../../src/automation/push-capacity');
const ADMIN = { userId: '666666666666666666', isAdmin: true };

async function setup(t, realtime) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    let now = Date.parse('2026-10-14T03:00:00Z'); const clock = () => now;
    const source = transferFixture(), key = source.push.p256dhPrivateKey;
    const file = { format: source.format, version: 2, provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: source.push.p256dhPublicKey, authenticationSecret: source.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const subscription = await insertSubscription(db, file);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN,
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 3, intervalMinutes: 5 }));
    if (realtime) {
        await db.withDatabaseTransaction(async query => {
            await entitlements.savePlanPolicy(query, ADMIN, { planId: 'ExplicitRealtimePlan', label: 'fixture', slotLimit: 9, minuteLimit: 9, dayLimit: 24, priority: 17, intervalMinutes: 5 });
            const previous = await capacity.getPlanCapacity(query, ADMIN, 'ExplicitRealtimePlan');
            await capacity.savePlanCapacity(query, ADMIN, 'ExplicitRealtimePlan', { eligible: false, specialSlotLimit: 0, realtimeEnabled: true, expectedUpdatedAtMs: previous.updatedAtMs });
            await entitlements.setUserPlan(query, ADMIN, ownerUserId, 'ExplicitRealtimePlan');
        });
        await createXProcessingSettings(db, { rolloutMode: 'public', now: clock }).save({ userId: ownerUserId }, { mode: 'realtime', expectedMode: 'batch' });
    }
    const store = createXPushStore(db, { now: clock, leaseMs: 300000 });
    const lease = await store.claim({ ...subscription, workerId: 'fixture-network' });
    const result = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','fixture',1,'ready','free',?,'bound',1,?,?)",
        [ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, ownerUserId, 'x', String(result.insertId)));
    const queue = createQueue(db, {}, { clock, rolloutMode: 'public' });
    const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, store, privateWorkerVault: vault, now: clock, rolloutMode: 'public' });
    const resources = require('../../src/automation/x-push-offline-resources').createOfflineResources({
        credentials: { host: '127.0.0.1', port: Number(process.env.AUTOMATION_TEST_DB_PORT), user: 'root',
            password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: db.schema, charset: 'utf8mb4' },
        connectionLimit: 2, gatewayOptions: { chromeEnabled: true, privateWorkerVault: vault }, evaluator: {}, clock, rolloutMode: 'public', graphEnabled: true });
    const runtime = createXPushRuntime(db, queue, { enabled: true, gateway, router: createXEventRouter(db, queue, { clock }), clock,
        rolloutMode: 'public', processingPolicy: 'batch', assertAllowed: () => {}, pageSize: 2, listCandidates: async () => [] });
    const offlineRuntime = createXPushRuntime(resources.db, resources.queue, { enabled: true, gateway: resources.gateway, router: resources.router,
        clock, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed: () => {}, pageSize: 2 });
    const controller = new AbortController();
    const leaseManager = require('../../src/automation/x-push-offline-lease').createOfflineLease(resources.db,
        { enabled: true, assertCompatible: () => true, now: clock, leaseMs: 30000 });
    const scheduler = require('../../src/automation/x-push-offline-runtime').createOfflineProcessingScheduler({ db: resources.db,
        leaseManager, workerId: 'offline-test', drain: offlineRuntime.drain, signal: controller.signal, clock, pageSize: 2, concurrency: 2,
        assertAllowed: () => {}, authorize: (query, candidate) => require('../../src/automation/x-rollout-policy').requireXEnrollment(query, { userId: candidate.owner_user_id }, { mode: 'public' }) });
    t.after(async () => { controller.abort(); scheduler.stop(); await Promise.allSettled(scheduler.pending()); await offlineRuntime.stop(); await runtime.stop(); await resources.close(); await db.close(); });
    let sequence = 0;
    const record = async () => {
        const payload = { notificationType: 'tweet', author: { id: '12345', handle: 'example' }, url: `https://x.com/example/status/${1234567890123456700n + BigInt(++sequence)}`, text: 'fixture' };
        const cipher = await encrypted(subscription.file, payload);
        return store.recordFrame(lease, { version: `offline-${sequence}`, data: cipher.data, headers: cipher.headers, status: 'received', ackCode: 100 });
    };
    const count = async () => Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n);
    return { db, store, lease, subscription, runtime, resources, record, count, tick: () => scheduler.tick(), advance: ms => { now += ms; } };
}
async function waitFor(check) {
    for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('synthetic processing did not reach the expected state');
}
for (const realtime of [false, true]) test(`offline scheduler processes durable ${realtime ? 'realtime' : 'batch'} receipts without reconnecting`, { timeout: 60000 }, async t => {
    const f = await setup(t, realtime); await f.record();
    await f.runtime.drain(f.lease); assert.equal(await f.count(), 1);
    f.advance(1000); const second = await f.record();
    await f.store.release(f.lease, { state: 'error', reasonCode: 'X_PUSH_SOCKET_CLOSED' });
    await f.tick();
    if (realtime) await waitFor(async () => await f.count() === 2 && (await f.store.getInbox({ ...f.subscription, id: second.id })).status === 'routed');
    else {
        await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await f.count(), 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: second.id })).status, 'received');
        f.advance(299000); await f.tick();
        await waitFor(async () => await f.count() === 2 && (await f.store.getInbox({ ...f.subscription, id: second.id })).status === 'routed');
    }
    assert.equal((await f.store.getInbox({ ...f.subscription, id: second.id })).status, 'routed');
});

test('network preemption serializes with an in-flight offline queue transaction and deduplicates retry', { timeout: 60000 }, async t => {
    const f = await setup(t, true);
    const mysql = require('mysql');
    const control = mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.AUTOMATION_TEST_DB_PORT), user: 'root',
        password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: f.db.schema });
    const query = (sql, params = []) => new Promise((resolve, reject) => control.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    t.after(() => new Promise(resolve => control.end(resolve)));
    const lockName = `offline-test-${f.db.schema}`;
    assert.equal(Number((await query('SELECT GET_LOCK(?,5) AS held', [lockName]))[0].held), 1);
    t.after(async () => { try { await query('SELECT RELEASE_LOCK(?)', [lockName]); } catch {} });
    await f.db.queryDatabase(`CREATE TRIGGER offline_test_gate BEFORE INSERT ON automation_runs FOR EACH ROW SET @offline_gate=GET_LOCK('${lockName}',10)`);
    const receipt = await f.record(); await f.store.release(f.lease);
    await f.tick();
    // MariaDB reports the currently executing trigger statement (or its
    // user-lock state), rather than the outer INSERT, in PROCESSLIST.
    await waitFor(async () => Number((await f.db.queryDatabase("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND (STATE LIKE '%User lock%' OR INFO LIKE 'SET @offline_gate=%')", [f.db.schema]))[0].n) > 0);
    let claimDone = false;
    const networkPromise = f.store.claim({ ...f.subscription, workerId: 'network-priority' }).then(value => { claimDone = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(claimDone, false);
    await query('SELECT RELEASE_LOCK(?)', [lockName]);
    const network = await networkPromise; assert.ok(network);
    await waitFor(async () => await f.count() === 1);
    // Retry under the network lease after the queue transaction commits.
    for (let i = 0; i < 50 && (await f.store.getInbox({ ...f.subscription, id: receipt.id })).status !== 'routed'; i++) {
        await f.runtime.drain(network, { recoverySignal: new AbortController().signal });
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.id })).status, 'routed');
    assert.equal(await f.count(), 1); await f.store.release(network);
});

test('stalled dedicated offline pool cannot exhaust the normal database pool', { timeout: 60000 }, async t => {
    const f = await setup(t, false), mysql = require('mysql');
    const control = mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.AUTOMATION_TEST_DB_PORT), user: 'root',
        password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: f.db.schema });
    const query = (sql, params = []) => new Promise((resolve, reject) => control.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    const locks = [`offline-a-${f.db.schema}`, `offline-b-${f.db.schema}`];
    let pending = [];
    try {
        for (const name of locks) assert.equal(Number((await query('SELECT GET_LOCK(?,5) AS held', [name]))[0].held), 1);
        pending = locks.map(name => f.resources.db.queryDatabase('SELECT GET_LOCK(?,10) AS acquired', [name]));
        await waitFor(async () => Number((await f.db.queryDatabase("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'SELECT GET_LOCK(%'", [f.db.schema]))[0].n) >= 2);
        const result = await f.db.queryDatabase('SELECT 1 AS normal_pool_operational');
        assert.equal(Number(result[0].normal_pool_operational), 1);
    } finally {
        for (const name of locks) await query('SELECT RELEASE_LOCK(?)', [name]);
        await Promise.allSettled(pending);
        await new Promise(resolve => control.end(resolve));
    }
});
