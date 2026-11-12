'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { fixture: transferFixture, insertSubscription, encrypted, vault, ownerUserId: OWNER } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createXEventRouter } = require('../../src/automation/x-event-router');
const { createQueue } = require('../../src/automation/queue');
const { createXProcessingSettings } = require('../../src/automation/x-processing-settings');
const entitlements = require('../../src/automation/entitlements');
const capacity = require('../../src/automation/push-capacity');
const ADMIN = { userId: '666666666666666666', isAdmin: true };
const START = Date.parse('2026-10-14T03:00:00Z');
const post = id => ({ notificationType: 'tweet', author: { id: '12345', handle: 'example' },
    url: `https://x.com/example/status/${1234567890123456700n + BigInt(id)}`, text: `synthetic ${id}` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { realtime = false, rolloutMode = 'public', wrapQueueDb, wrapRoute, simulateSession = false } = {}) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    const runtimes = [];
    t.after(async () => { for (const runtime of runtimes) await runtime.stop(); await db.close(); });
    for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
    let now = START, sequence = 0; const clock = () => now;
    const source = transferFixture(), key = source.push.p256dhPrivateKey;
    const file = { format: source.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: source.push.p256dhPublicKey, authenticationSecret: source.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const subscription = await insertSubscription(db, file);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN,
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 3, intervalMinutes: 5 }));
    if (rolloutMode === 'supporters') {
        await grantTestDonor(db, OWNER);
        // The donor flag selects the existing supporter plan. Give that plan
        // an explicit interval so the test reaches the routing race rather
        // than stopping earlier at an unconfigured processing window.
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN,
            { planId: 'supporter', label: 'fixture supporter', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 3, intervalMinutes: 5 }));
    }
    if (realtime) {
        await db.withDatabaseTransaction(async query => {
            await entitlements.savePlanPolicy(query, ADMIN, { planId: 'ExplicitRealtimePlan', label: 'fixture', slotLimit: 9,
                minuteLimit: 9, dayLimit: 24, priority: 17, intervalMinutes: 5 });
            const previous = await capacity.getPlanCapacity(query, ADMIN, 'ExplicitRealtimePlan');
            await capacity.savePlanCapacity(query, ADMIN, 'ExplicitRealtimePlan', { eligible: false, specialSlotLimit: 0,
                realtimeEnabled: true, expectedUpdatedAtMs: previous.updatedAtMs });
            await entitlements.setUserPlan(query, ADMIN, OWNER, 'ExplicitRealtimePlan');
        });
        await createXProcessingSettings(db, { rolloutMode, now: clock }).save({ userId: OWNER }, { mode: 'realtime', expectedMode: 'batch' });
    }
    const store = createXPushStore(db, { now: clock, leaseMs: 300000 });
    let lease = await store.claim({ ...subscription, workerId: 'recovery-routing' });
    await store.markState(lease, 'listening');
    const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','fixture',1,'ready','free',?,'bound',1,?,?)",
        [OWNER, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, OWNER, 'x', String(monitor.insertId)));
    const queueDb = wrapQueueDb ? wrapQueueDb(db) : db;
    const queue = createQueue(queueDb, {}, { clock, rolloutMode });
    const usedQueue = wrapRoute ? { ...queue, routeX: input => wrapRoute(input, queue, db) } : queue;
    const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, store, privateWorkerVault: vault, now: clock, rolloutMode });
    let callbacks;
    const runtimeGateway = simulateSession ? { ...gateway, run: input => {
        callbacks = input; input.onSession({ lease });
        return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }));
    } } : gateway;
    const router = createXEventRouter(db, usedQueue, { clock });
    const runtime = createXPushRuntime(db, usedQueue, { enabled: true, gateway: runtimeGateway, router, clock, rolloutMode,
        processingPolicy: 'batch', assertAllowed: () => {}, pageSize: 2, ...(simulateSession ? {
            listCandidates: async () => [{ id: subscription.subscriptionId, owner_user_id: OWNER, revision: 1, updated_at_ms: 0 }],
            listActiveSessions: async () => [{ id: subscription.subscriptionId, owner_user_id: OWNER, revision: 1, updated_at_ms: 0 }],
        } : {}) });
    runtimes.push(runtime);
    async function record() {
        const payload = post(++sequence), cipher = await encrypted(subscription.file, payload);
        return { payload, inbox: await store.recordMcsRecoveryFrame(lease, { version: `recovery-${sequence}`,
            data: cipher.data, headers: cipher.headers, status: 'received', ackCode: 100 }) };
    }
    return { db, store, gateway, queue, runtime, subscription, monitorId: String(monitor.insertId), clock,
        lease: () => lease, callbacks: () => callbacks, advance: ms => { now += ms; }, renew: async () => { lease = await store.renew(lease); }, record,
        count: async table => Number((await db.queryDatabase(`SELECT COUNT(*) AS n FROM ${table}`))[0].n),
        receiver: async () => (await db.queryDatabase('SELECT last_process_at_ms,process_window_at_ms,process_cursor_id FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0] };
}

for (const realtime of [false, true]) test(`recovery drain preserves ${realtime ? 'realtime' : 'batch'} plan behavior`, { timeout: 60000 }, async t => {
    const f = await fixture(t, { realtime }), controller = new AbortController();
    const planBefore = await entitlements.resolveNotificationEntitlement(f.db, { ownerUserId: OWNER, targetKind: 'x', targetId: f.monitorId });
    const first = await f.record();
    assert.equal((await f.runtime.drain(f.lease(), { recoverySignal: controller.signal })).processed, 1);
    assert.equal(await f.count('automation_jobs'), 1); assert.equal((await f.store.getInbox({ ...f.subscription, id: first.inbox.id })).status, 'routed');
    assert.equal((await f.receiver()).last_process_at_ms == null, realtime);
    f.advance(1000); const second = await f.record();
    const next = await f.runtime.drain(f.lease(), { recoverySignal: controller.signal });
    if (realtime) { assert.equal(next.processed, 1); assert.equal(await f.count('automation_jobs'), 2); }
    else {
        assert.equal(next.state, 'pending'); assert.equal(await f.count('automation_jobs'), 1);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: second.inbox.id })).status, 'received');
        f.advance(298999); await f.renew(); f.advance(1);
        assert.equal((await f.runtime.drain(f.lease(), { recoverySignal: controller.signal })).processed, 1);
        assert.equal(await f.count('automation_jobs'), 2);
    }
    const planAfter = await entitlements.resolveNotificationEntitlement(f.db, { ownerUserId: OWNER, targetKind: 'x', targetId: f.monitorId });
    assert.equal(planAfter.priority, planBefore.priority); assert.equal(planAfter.minuteLimit, planBefore.minuteLimit);
});

test('late recovery callback after cancellation and lease release creates no job or cursor advance', { timeout: 60000 }, async t => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const f = await fixture(t, { wrapRoute: async (input, queue) => { entered.resolve(); await release.promise; return queue.routeX(input); } });
    const receipt = await f.record();
    const work = f.runtime.drain(f.lease(), { recoverySignal: controller.signal });
    await entered.promise; const before = await f.receiver(); controller.abort(); await f.store.release(f.lease()); release.resolve();
    assert.equal((await work).state, 'stopped'); assert.equal(await f.count('automation_jobs'), 0);
    assert.deepEqual(await f.receiver(), before);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'received');
});

test('session shutdown fences a normal receipt drain that began before recovery', { timeout: 60000 }, async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { realtime: true, simulateSession: true,
        wrapRoute: async (input, queue) => { entered.resolve(); await release.promise; return queue.routeX(input); } });
    await f.runtime.tick();
    for (let i = 0; !f.callbacks() && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.callbacks(), 'synthetic session did not start');
    const receipt = await f.record();
    const work = f.callbacks().onReceived({ lease: f.lease(), inbox: receipt.inbox });
    await entered.promise; const before = await f.receiver();
    f.callbacks().onStopping(); await f.store.release(f.lease()); release.resolve(); await work;
    assert.equal(await f.count('automation_jobs'), 0); assert.deepEqual(await f.receiver(), before);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'received');
});

test('session shutdown rolls back an earlier normal drain inside the queue transaction', { timeout: 60000 }, async t => {
    const entered = deferred(), finish = deferred(); let releaseDone = false;
    const f = await fixture(t, { realtime: true, simulateSession: true, wrapQueueDb: db => ({ ...db,
        withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            const value = await query(sql, params);
            if (sql.startsWith('INSERT INTO automation_runs')) { entered.resolve(); await finish.promise; }
            return value;
        })) }) });
    await f.runtime.tick();
    for (let i = 0; !f.callbacks() && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.callbacks(), 'synthetic session did not start');
    const receipt = await f.record();
    const work = f.callbacks().onReceived({ lease: f.lease(), inbox: receipt.inbox });
    await entered.promise; const before = await f.receiver();
    f.callbacks().onStopping();
    const releasing = f.store.release(f.lease()).then(() => { releaseDone = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); const releasedEarly = releaseDone;
    finish.resolve(); const outcomes = await Promise.allSettled([work, releasing]);
    assert.equal(releasedEarly, false); assert.equal(outcomes[1].status, 'fulfilled');
    assert.equal(await f.count('automation_runs'), 0); assert.equal(await f.count('automation_jobs'), 0);
    assert.deepEqual(await f.receiver(), before);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'received');
});

test('recovery queue transaction rolls back when cancellation occurs after a run insert', { timeout: 60000 }, async t => {
    const controller = new AbortController(); let triggered = false;
    const f = await fixture(t, { wrapQueueDb: db => ({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('INSERT INTO automation_runs')) { triggered = true; controller.abort(); }
        return result;
    })) }) });
    const receipt = await f.record();
    assert.equal((await f.runtime.drain(f.lease(), { recoverySignal: controller.signal })).state, 'stopped');
    assert.equal(triggered, true); assert.equal(await f.count('automation_runs'), 0); assert.equal(await f.count('automation_jobs'), 0);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'received');
    const receiver = await f.receiver(); assert.equal(Number(receiver.process_cursor_id), 0); assert.equal(receiver.last_process_at_ms, null);
});

test('an in-flight COMMIT after cancellation remains deduplicated on the next drain', { timeout: 60000 }, async t => {
    const controller = new AbortController(); let armed = false, cancelled = false;
    const f = await fixture(t, { wrapQueueDb: db => ({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(async query => {
        const result = await work(async (sql, params) => {
            const value = await query(sql, params); if (sql.startsWith('INSERT INTO automation_runs')) armed = true; return value;
        });
        // This models cancellation after the final application check but
        // before the driver's COMMIT. A sent/in-flight COMMIT cannot be
        // claimed to be cancelled; the owner/receiver locks serialize it.
        if (armed && !cancelled) { cancelled = true; controller.abort(); }
        return result;
    }) }) });
    const receipt = await f.record();
    assert.equal((await f.runtime.drain(f.lease(), { recoverySignal: controller.signal })).state, 'stopped');
    assert.equal(cancelled, true); assert.equal(await f.count('automation_jobs'), 1);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'received');
    const next = new AbortController();
    assert.equal((await f.runtime.drain(f.lease(), { recoverySignal: next.signal })).processed, 1);
    assert.equal(await f.count('automation_jobs'), 1);
    assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'routed');
});

test('lease release waits for a fenced in-flight routing transaction', { timeout: 60000 }, async t => {
    const entered = deferred(), finish = deferred(); let releaseDone = false;
    const f = await fixture(t, { wrapQueueDb: db => ({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const value = await query(sql, params);
        if (sql.startsWith('INSERT INTO automation_runs')) { entered.resolve(); await finish.promise; }
        return value;
    })) }) });
    await f.record(); const controller = new AbortController();
    const work = f.runtime.drain(f.lease(), { recoverySignal: controller.signal });
    await entered.promise;
    const releasing = f.store.release(f.lease()).then(() => { releaseDone = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(releaseDone, false);
    finish.resolve(); const outcomes = await Promise.allSettled([work, releasing]);
    assert.equal(outcomes[1].status, 'fulfilled'); assert.equal(releaseDone, true);
    assert.equal(await f.count('automation_jobs'), 1);
});

test('recovery is fenced after lease loss and after supporter permission is withdrawn', { timeout: 60000 }, async t => {
    await t.test('lease loss', async child => {
        const f = await fixture(child), receipt = await f.record(), controller = new AbortController();
        await f.store.release(f.lease());
        await assert.rejects(f.runtime.drain(f.lease(), { recoverySignal: controller.signal }), { code: 'X_PUSH_LEASE_LOST' });
        assert.equal(await f.count('automation_jobs'), 0);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'received');
    });
    await t.test('permission change during route', async child => {
        let revoked = false;
        const f = await fixture(child, { rolloutMode: 'supporters', wrapRoute: async (input, queue, db) => {
            if (!revoked) { revoked = true; await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [OWNER]); }
            return queue.routeX(input);
        } });
        const receipt = await f.record(), controller = new AbortController();
        await assert.rejects(f.runtime.drain(f.lease(), { recoverySignal: controller.signal }));
        assert.equal(revoked, true); assert.equal(await f.count('automation_jobs'), 0);
        assert.equal((await f.store.getInbox({ ...f.subscription, id: receipt.inbox.id })).status, 'received');
    });
    await t.test('subscription removal before queue admission', async child => {
        const entered = deferred(), continueRoute = deferred();
        const f = await fixture(child, { wrapRoute: async (input, queue) => { entered.resolve(); await continueRoute.promise; return queue.routeX(input); } });
        await f.record(); const controller = new AbortController();
        const work = f.runtime.drain(f.lease(), { recoverySignal: controller.signal });
        await entered.promise;
        await f.db.queryDatabase('DELETE FROM automation_x_subscriptions WHERE id=? AND owner_user_id=?', [f.subscription.subscriptionId, OWNER]);
        continueRoute.resolve();
        await assert.rejects(work);
        assert.equal(await f.count('automation_jobs'), 0);
        assert.equal((await f.db.queryDatabase('SELECT id FROM automation_x_subscriptions WHERE id=?', [f.subscription.subscriptionId])).length, 0);
    });
});
