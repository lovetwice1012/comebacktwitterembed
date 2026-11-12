'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { fixture, insertSubscription, vault, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const entitlements = require('../../src/automation/entitlements');
const { encodeFrame } = require('../../src/automation/chrome-mcs-framing');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), owner = { userId: ownerUserId };
const admin = { userId: '444444444444444444', isAdmin: true };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function chromeFile() {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    return { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
}
class Socket extends EventEmitter {
    constructor() { super(); this.destroyed = false; queueMicrotask(() => this.emit('secureConnect')); }
    write(wire, done) { done(); if (wire[0] === 41) queueMicrotask(() => this.emit('data', encodeFrame(3, Buffer.from([10, 2, 111, 107]), { first: true }))); }
    pause() {} resume() {} destroy() { this.destroyed = true; }
}
for (const mode of ['valid-unauthorized', 'monitor-disabled', 'guardian-revoked'])
    test(`Chrome check-in ${mode} only requires reenrollment while still authorized`, { timeout: 45000 }, async t => {
        const db = await createTestDatabase(port), entered = deferred(), reply = deferred(), state = { allowed: true };
        let running;
        t.after(async () => { reply.reject(Object.assign(new Error('stopped'), { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' })); await running?.catch(() => {}); await db.close(); });
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        await grantTestDonor(db, ownerUserId);
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin,
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        const subscription = await insertSubscription(db, chromeFile());
        const quota = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'supporters' });
        const monitor = await quota.register(owner, { accountHandle: 'checkin_fixture', name: 'fixture', notificationSettings: { subscriptionId: subscription.subscriptionId } });
        const before = (await db.queryDatabase('SELECT pool_kind,notification_settings_json,subscription_state FROM automation_x_monitors WHERE id=?', [monitor.id]))[0];
        const slots = await db.queryDatabase('SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [ownerUserId]);
        let fire, clock = Date.now(), socket;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, rolloutMode: 'supporters', privateWorkerVault: vault,
            requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock, createChromeSocket: () => socket = new Socket(),
            chromeCheckinSetTimer: callback => { fire = callback; return 1; }, chromeCheckinClearTimer() {},
            chromeCheckin: async () => { entered.resolve(); return reply.promise; } });
        running = gateway.run({ ...subscription, workerId: 'checkin-race', requireActiveMonitor: true,
            assertAllowed() { if (!state.allowed) throw new Error('synthetic guardian denied'); },
            onSession: () => { clock += 60001; fire(); } });
        await entered.promise;
        if (mode === 'monitor-disabled') await quota.update(owner, monitor.id, { expectedRevision: monitor.revision, enabled: false });
        if (mode === 'guardian-revoked') state.allowed = false;
        reply.reject(Object.assign(new Error('synthetic rejection'), { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' }));
        if (mode === 'valid-unauthorized') await assert.rejects(running, { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' });
        else assert.equal((await running).state, mode === 'monitor-disabled' ? 'inactive' : 'authority_unavailable');
        assert.equal(socket.destroyed, true);
        const receiver = (await db.queryDatabase('SELECT state,reason_code,lease_token FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
        assert.equal(receiver.state, mode === 'valid-unauthorized' ? 'requires_reenrollment' : 'stopped');
        assert.equal(receiver.reason_code, mode === 'valid-unauthorized' ? 'X_PUSH_CHECKIN_UNAUTHORIZED' : null);
        assert.equal(receiver.lease_token, null);
        assert.deepEqual((await db.queryDatabase('SELECT pool_kind,notification_settings_json,subscription_state FROM automation_x_monitors WHERE id=?', [monitor.id]))[0], before);
        assert.deepEqual(await db.queryDatabase('SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [ownerUserId]), slots);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0].n), 1);
    });
