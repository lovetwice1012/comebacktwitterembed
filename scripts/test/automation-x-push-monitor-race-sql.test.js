'use strict';

// Disposable DB + synthetic socket only. No browser or provider is contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { insertSubscription, vault, ownerUserId, FakeSocket, encrypted, notification } = require('./helpers/x-push-fixture.cjs');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const entitlements = require('../../src/automation/entitlements');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT), owner = { userId: ownerUserId };
const admin = { userId: '444444444444444444', isAdmin: true }, other = '333333333333333333';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function setup(t, monitorCount = 1) {
    const db = await createTestDatabase(port), entered = deferred(), release = deferred();
    let runtime;
    t.after(async () => { release.resolve(); await runtime?.stop(); await db.close(); });
    await grantTestDonor(db, ownerUserId);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin,
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    const subscription = await insertSubscription(db);
    const quota = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'supporters' });
    const monitors = [];
    for (let index = 0; index < monitorCount; index++) monitors.push(await quota.register(owner, {
        accountHandle: `monitor_${index}`, name: `fixture ${index}`, notificationSettings: { subscriptionId: subscription.subscriptionId },
    }));
    const slots = () => db.queryDatabase("SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index", [ownerUserId]);
    const raw = id => db.queryDatabase('SELECT enabled,state,pool_kind,notification_settings_json,subscription_state,revision FROM automation_x_monitors WHERE id=? AND owner_user_id=?', [id, ownerUserId]).then(rows => rows[0]);
    let delayed = false, sockets = 0, opens = 0;
    const wrapped = { withDatabaseTransaction: db.withDatabaseTransaction, queryDatabase: async (sql, params) => {
        const rows = await db.queryDatabase(sql, params);
        if (!delayed && /^SELECT is_donor FROM users/.test(sql)) { delayed = true; entered.resolve(); await release.promise; }
        return rows;
    } };
    const gateway = createXPushGateway(wrapped, { enabled: true, rolloutMode: 'supporters',
        privateWorkerVault: { open(...args) { opens++; return vault.open(...args); } },
        createSocket: () => { sockets++; return new FakeSocket((message, socket) => {
            if (message.messageType === 'hello') socket.reply({ messageType: 'hello', status: 200, uaid: message.uaid, use_webpush: true });
        }); } });
    runtime = createXPushRuntime(wrapped, {}, { enabled: true, gateway, rolloutMode: 'supporters', processingPolicy: 'batch',
        assertAllowed() {}, pageSize: 1, router: { hasRealtimeTargets: async () => false, hasBatchTargets: async () => false } });
    const tick = runtime.tick(); await entered.promise;
    return { db, quota, gateway, runtime, monitors, subscription, tick, release, slots, raw,
        sockets: () => sockets, opens: () => opens };
}
async function waitStopped(runtime) {
    for (let index = 0; index < 200 && runtime.status().sessions; index++) await delay();
    assert.equal(runtime.status().sessions, 0);
}
async function waitListening(f) {
    let status;
    for (let index = 0; index < 200; index++) {
        status = await f.gateway.store.status(f.subscription);
        if (status?.state === 'listening') break;
        await delay();
    }
    assert.equal(status?.state, 'listening');
}

test('disabling the final monitor during eligibility prevents connection and re-enabling keeps its settings and slots', { timeout: 45000 }, async t => {
    const f = await setup(t), monitor = f.monitors[0], original = await f.raw(monitor.id), slots = await f.slots();
    const disabled = await f.quota.update(owner, monitor.id, { expectedRevision: monitor.revision, enabled: false });
    f.release.resolve(); await f.tick; await waitStopped(f.runtime);
    assert.equal(f.sockets(), 0); assert.equal(f.opens(), 0);
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_receivers WHERE subscription_id=?', [f.subscription.subscriptionId]))[0].n), 0);
    const stopped = await f.raw(monitor.id);
    assert.equal(Number(stopped.enabled), 0); assert.equal(stopped.state, original.state);
    assert.equal(stopped.pool_kind, original.pool_kind); assert.equal(stopped.notification_settings_json, original.notification_settings_json);
    assert.equal(stopped.subscription_state, original.subscription_state); assert.deepEqual(await f.slots(), slots);
    const resumed = await f.quota.update(owner, monitor.id, { expectedRevision: disabled.revision, enabled: true });
    assert.equal(resumed.enabled, true); assert.deepEqual(await f.slots(), slots);
    const restored = await f.raw(monitor.id);
    assert.equal(restored.pool_kind, original.pool_kind); assert.equal(restored.notification_settings_json, original.notification_settings_json);
    for (let attempt = 0; attempt < 4 && !f.sockets(); attempt++) { await f.runtime.tick(); await delay(); }
    await waitListening(f); assert.equal(f.sockets(), 1); assert.equal(f.opens(), 1);
});

test('disabling one of two monitors leaves the shared subscription usable without changing either reservation', { timeout: 45000 }, async t => {
    const f = await setup(t, 2), [first, second] = f.monitors, slots = await f.slots();
    const beforeFirst = await f.raw(first.id), beforeSecond = await f.raw(second.id);
    await f.quota.update(owner, first.id, { expectedRevision: first.revision, enabled: false });
    f.release.resolve(); await f.tick; await waitListening(f);
    assert.equal(f.sockets(), 1); assert.equal(f.opens(), 1); assert.deepEqual(await f.slots(), slots);
    const afterFirst = await f.raw(first.id), afterSecond = await f.raw(second.id);
    assert.equal(Number(afterFirst.enabled), 0); assert.equal(afterFirst.pool_kind, beforeFirst.pool_kind);
    assert.equal(afterFirst.notification_settings_json, beforeFirst.notification_settings_json);
    assert.deepEqual(afterSecond, beforeSecond);
});

for (const kind of ['other-owner', 'suspended', 'invalid-json', 'different-subscription'])
    test(`${kind} monitor cannot authorize another owner's or inactive subscription`, { timeout: 45000 }, async t => {
        const f = await setup(t), monitor = f.monitors[0], before = await f.raw(monitor.id), slots = await f.slots();
        await f.quota.update(owner, monitor.id, { expectedRevision: monitor.revision, enabled: false });
        const rowOwner = kind === 'other-owner' ? other : ownerUserId;
        const state = kind === 'suspended' ? 'suspended' : 'ready';
        const settings = kind === 'invalid-json' ? '{' : JSON.stringify({ subscriptionId: kind === 'different-subscription' ? randomUUID() : f.subscription.subscriptionId });
        await f.db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'98765','invalid fixture',1,?,NULL,?,'bound',1,0,0)", [rowOwner, state, settings]);
        f.release.resolve(); await f.tick; await waitStopped(f.runtime);
        assert.equal(f.sockets(), 0); assert.equal(f.opens(), 0);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_receivers WHERE subscription_id=?', [f.subscription.subscriptionId]))[0].n), 0);
        const after = await f.raw(monitor.id);
        assert.equal(Number(after.enabled), 0); assert.equal(after.pool_kind, before.pool_kind);
        assert.equal(after.notification_settings_json, before.notification_settings_json); assert.deepEqual(await f.slots(), slots);
    });

test('disabling the final monitor after receipt commit prevents ACK while retaining ciphertext and reservations', { timeout: 45000 }, async t => {
    const db = await createTestDatabase(port), committed = deferred(), resume = deferred();
    let run, socket;
    t.after(async () => { resume.resolve(); await run?.catch(() => {}); await db.close(); });
    await grantTestDonor(db, ownerUserId);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin,
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    const subscription = await insertSubscription(db), quota = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'supporters' });
    const monitor = await quota.register(owner, { accountHandle: 'commit_fixture', name: 'fixture', notificationSettings: { subscriptionId: subscription.subscriptionId } });
    const original = (await db.queryDatabase('SELECT pool_kind,notification_settings_json,subscription_state FROM automation_x_monitors WHERE id=?', [monitor.id]))[0];
    const slots = await db.queryDatabase("SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index", [ownerUserId]);
    const payload = { notificationType: 'tweet', text: 'synthetic-monitor-race' };
    const wire = await encrypted(subscription.file, payload);
    const store = createXPushStore(db), recordFrame = store.recordFrame;
    store.recordFrame = async (...args) => {
        const result = await recordFrame(...args);
        committed.resolve(); await resume.promise;
        return result;
    };
    const gateway = createXPushGateway(db, { enabled: true, privateWorkerVault: vault, rolloutMode: 'supporters', store,
        createSocket: () => socket = new FakeSocket((message, peer) => {
            if (message.messageType === 'hello') peer.reply({ messageType: 'hello', status: 200, uaid: message.uaid, use_webpush: true });
        }) });
    run = gateway.run({ ...subscription, workerId: 'monitor-ack-race', requireActiveMonitor: true, assertAllowed() {},
        onSession: () => socket.reply(notification(subscription.file, 'fixture-version', wire)) });
    await committed.promise;
    const saved = await db.queryDatabase('SELECT data_ciphertext,status,ack_code FROM automation_x_push_inbox WHERE subscription_id=?', [subscription.subscriptionId]);
    assert.equal(saved.length, 1); assert.equal(saved[0].data_ciphertext, wire.data); assert.equal(saved[0].status, 'received');
    await quota.update(owner, monitor.id, { expectedRevision: monitor.revision, enabled: false });
    resume.resolve();
    assert.deepEqual(await run, { state: 'inactive', reasonCode: null });
    assert.equal(socket.sent.filter(message => message.messageType === 'ack').length, 0);
    assert.equal(socket.readyState, 3);
    assert.deepEqual(await db.queryDatabase('SELECT data_ciphertext,status,ack_code FROM automation_x_push_inbox WHERE subscription_id=?', [subscription.subscriptionId]), saved);
    const after = (await db.queryDatabase('SELECT pool_kind,notification_settings_json,subscription_state FROM automation_x_monitors WHERE id=?', [monitor.id]))[0];
    assert.deepEqual(after, original);
    assert.deepEqual(await db.queryDatabase("SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index", [ownerUserId]), slots);
    const status = await gateway.store.status(subscription);
    assert.equal(status.state, 'stopped'); assert.equal(status.reasonCode, null);
});
