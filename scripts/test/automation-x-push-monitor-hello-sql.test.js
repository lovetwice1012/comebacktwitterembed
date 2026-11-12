'use strict';

// Disposable SQL and FakeSocket only; never contacts a push provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { insertSubscription, vault, ownerUserId, FakeSocket } = require('./helpers/x-push-fixture.cjs');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const entitlements = require('../../src/automation/entitlements');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT), owner = { userId: ownerUserId };
const admin = { userId: '444444444444444444', isAdmin: true };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
for (const disableBeforeReply of [true, false]) test(disableBeforeReply
    ? 'disabling the last monitor before a mismatched HELLO does not require reenrollment'
    : 'an active monitor still requires reenrollment after a mismatched HELLO', { timeout: 45000 }, async t => {
    const db = await createTestDatabase(port), hello = deferred();
    let run, socket, sockets = 0;
    t.after(async () => { socket?.terminate(); await run?.catch(() => {}); await db.close(); });
    await grantTestDonor(db, ownerUserId);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin,
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    const subscription = await insertSubscription(db), quota = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'supporters' });
    const monitor = await quota.register(owner, { accountHandle: 'hello_fixture', name: 'fixture', notificationSettings: { subscriptionId: subscription.subscriptionId } });
    const before = (await db.queryDatabase('SELECT pool_kind,notification_settings_json,subscription_state FROM automation_x_monitors WHERE id=?', [monitor.id]))[0];
    const slots = await db.queryDatabase("SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index", [ownerUserId]);
    const stored = (await db.queryDatabase('SELECT sealed_json,revision,owner_user_id FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0];
    const gateway = createXPushGateway(db, { enabled: true, privateWorkerVault: vault, rolloutMode: 'supporters', requestTimeoutMs: 30000, leaseMs: 300000,
        createSocket: () => { sockets++; return socket = new FakeSocket((message, peer) => { if (message.messageType === 'hello') hello.resolve(peer); }); } });
    run = gateway.run({ ...subscription, workerId: 'monitor-hello-race', requireActiveMonitor: true, assertAllowed() {} });
    await hello.promise;
    if (disableBeforeReply) await quota.update(owner, monitor.id, { expectedRevision: monitor.revision, enabled: false });
    socket.reply({ messageType: 'hello', status: 200, uaid: 'ffffffffffffffffffffffffffffffff', use_webpush: true });
    if (disableBeforeReply) assert.deepEqual(await run, { state: 'inactive', reasonCode: null });
    else await assert.rejects(run, { code: 'X_PUSH_UAID_CHANGED' });
    assert.equal(sockets, 1); assert.equal(socket.readyState, 3);
    assert.deepEqual(socket.sent.map(message => message.messageType), ['hello']);
    const status = await gateway.store.status(subscription);
    assert.equal(status.state, disableBeforeReply ? 'stopped' : 'requires_reenrollment');
    assert.equal(status.reasonCode, disableBeforeReply ? null : 'X_PUSH_UAID_CHANGED');
    assert.deepEqual((await db.queryDatabase('SELECT pool_kind,notification_settings_json,subscription_state FROM automation_x_monitors WHERE id=?', [monitor.id]))[0], before);
    assert.deepEqual(await db.queryDatabase("SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index", [ownerUserId]), slots);
    assert.deepEqual((await db.queryDatabase('SELECT sealed_json,revision,owner_user_id FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0], stored);
    if (!disableBeforeReply) {
        const retry = await gateway.run({ ...subscription, workerId: 'monitor-hello-retry', requireActiveMonitor: true, assertAllowed() {} });
        assert.equal(retry.state, 'busy'); assert.equal(sockets, 1);
    }
});
