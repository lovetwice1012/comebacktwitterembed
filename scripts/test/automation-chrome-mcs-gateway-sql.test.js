'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, fixture, encrypted, vault } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { encodeFrame } = require('../../src/automation/chrome-mcs-framing');
function vint(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); }
function bytes(n, v) { const body = Buffer.isBuffer(v) ? v : Buffer.from(v); return Buffer.concat([vint(n * 8 + 2), vint(body.length), body]); }
const pair = (k, v) => bytes(7, Buffer.concat([bytes(1, k), bytes(2, v)]));
function chromeFixture() {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    return { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
}
class FakeSocket extends EventEmitter {
    constructor(db) { super(); this.db = db; this.writes = []; this.destroyed = false; queueMicrotask(() => this.emit('secureConnect')); }
    write(wire, done) {
        this.writes.push(wire);
        if (wire[0] === 41) {
            done(); queueMicrotask(() => this.emit('data', encodeFrame(3, bytes(1, 'ok'), { first: true })));
        } else if (wire[0] === 7) {
            this.db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_push_inbox').then(rows => {
                if (Number(rows[0].n) !== 1) return done(new Error('ACK_BEFORE_COMMIT'));
                done();
            }, done);
        } else done();
    }
    pause() {} resume() {} destroy() { this.destroyed = true; }
}
test('Chrome worker receives, commits and routes encrypted MCS data with the existing lease', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = chromeFixture(), subscription = await insertSubscription(db, file), controller = new AbortController();
        const payload = { notificationType: 'tweet', url: 'https://x.com/synthetic/status/123', author: { handle: 'synthetic', id: '123' }, text: 'fixture' };
        const cipher = await encrypted(file, payload); let socket, received;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, createChromeSocket: () => socket = new FakeSocket(db) });
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, 'mcs-123'),
            bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        const result = await gateway.run({ ...subscription, workerId: 'chrome-worker', signal: controller.signal,
            onSession: () => socket.emit('data', encodeFrame(8, message)),
            onReceived: value => { received = value; controller.abort(); } });
        assert.deepEqual(result, { state: 'stopped', reasonCode: null });
        assert.deepEqual(received.payload, payload); assert.equal(received.inbox.version, 'mcs-123');
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_mcs_pending')).length, 1);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
        assert(socket.destroyed);
    } finally { await db.close(); }
});
test('Chrome worker fences ACK after a committed receipt if its lease is lost', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = chromeFixture(), subscription = await insertSubscription(db, file);
        const cipher = await encrypted(file, { notificationType: 'tweet', text: 'fixture' });
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, 'lease-lost'),
            bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        const base = createXPushStore(db); let failNext = false, socket;
        const store = { ...base,
            recordMcsFrame: async (...args) => { const row = await base.recordMcsFrame(...args); failNext = true; return row; },
            assertLease: async (...args) => { if (failNext) throw Object.assign(new Error('lease lost'), { code: 'X_PUSH_LEASE_LOST' }); return base.assertLease(...args); } };
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault,
            rolloutMode: 'public', requestTimeoutMs: 3000, store, createChromeSocket: () => socket = new FakeSocket(db) });
        await assert.rejects(gateway.run({ ...subscription, workerId: 'chrome-worker',
            onSession: () => socket.emit('data', encodeFrame(8, message)) }), e => e.code === 'X_PUSH_LEASE_LOST');
        assert.equal(socket.writes.filter(wire => wire[0] === 7).length, 0);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_mcs_pending')).length, 1);
    } finally { await db.close(); }
});
test('Chrome worker runs and saves check-in without interrupting the MCS session', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const subscription = await insertSubscription(db, chromeFixture()), controller = new AbortController();
        let clock = 1000000, fire, calls = 0, socket;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock, createChromeSocket: () => socket = new FakeSocket(db),
            chromeCheckinSetTimer: cb => { fire = cb; return 1; }, chromeCheckinClearTimer: () => {},
            chromeCheckin: async credentials => { calls++; assert.equal(credentials.deviceId, '123'); return { intervalSeconds: 50000 }; } });
        const running = gateway.run({ ...subscription, workerId: 'chrome-checkin', signal: controller.signal,
            onSession: () => { clock += 60001; fire(); } });
        try {
            let saved;
            for (let i = 0; i < 100; i++) {
                saved = (await db.queryDatabase('SELECT chrome_checkin_at_ms,chrome_checkin_interval_seconds FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
                if (saved?.chrome_checkin_at_ms != null) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(calls, 1); assert.equal(Number(saved.chrome_checkin_interval_seconds), 50000);
            assert.equal(Number(saved.chrome_checkin_at_ms), clock); assert.equal(socket.destroyed, false);
        } finally { controller.abort(); await running; }
    } finally { await db.close(); }
});
test('invalid Chrome device credentials stop the worker and require re-enrollment without replacing the subscription', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const subscription = await insertSubscription(db, chromeFixture());
        let clock = 1000000, fire;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock, createChromeSocket: () => new FakeSocket(db),
            chromeCheckinSetTimer: cb => { fire = cb; return 1; }, chromeCheckinClearTimer: () => {},
            chromeCheckin: async () => { throw Object.assign(new Error('invalid'), { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' }); } });
        await assert.rejects(gateway.run({ ...subscription, workerId: 'chrome-checkin', onSession: () => { clock += 60001; fire(); } }),
            { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' });
        const rows = await db.queryDatabase('SELECT state,reason_code,chrome_checkin_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]);
        assert.equal(rows[0].state, 'requires_reenrollment'); assert.equal(rows[0].reason_code, 'X_PUSH_CHECKIN_UNAUTHORIZED');
        assert.equal(rows[0].chrome_checkin_at_ms, null);
        assert.equal((await db.queryDatabase('SELECT id FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId])).length, 1);
    } finally { await db.close(); }
});
