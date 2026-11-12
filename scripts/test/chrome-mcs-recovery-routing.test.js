'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fixture, encrypted } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { encodeFrame } = require('../../src/automation/chrome-mcs-framing');
function v(n) { const bytes = []; do { let value = n % 128; n = Math.floor(n / 128); if (n) value |= 128; bytes.push(value); } while (n); return Buffer.from(bytes); }
function field(n, value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([v(n * 8 + 2), v(bytes.length), bytes]); }
const pair = (key, value) => field(7, Buffer.concat([field(1, key), field(2, value)]));

async function runFixture({ delayCallback = false, revoke = false, failSecond = false } = {}) {
    const source = fixture(), key = source.push.p256dhPrivateKey;
    const file = { format: source.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: source.push.p256dhPublicKey, authenticationSecret: source.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const cipher = await encrypted(file, { notificationType: 'tweet', text: 'synthetic' });
    const lease = { subscriptionId: '11111111-1111-4111-8111-111111111111', ownerUserId: '222222222222222222', revision: 1,
        token: 'a'.repeat(64), expiresAtMs: Date.now() + 60000, sealedEnvelope: { version: 2 } };
    const saved = [], writes = []; let socket, disconnected = false, released = false, stoppingBeforeRelease = false, callbacks = 0, callbackSignal, lateWrite = false, finishLate;
    const late = new Promise(resolve => { finishLate = resolve; });
    const store = { leaseMs: 60000, claim: async () => lease, renew: async () => lease,
        assertLease: async () => { if (disconnected && revoke) throw Object.assign(new Error('revoked'), { code: 'X_PUSH_LEASE_LOST' }); },
        auditUse: async () => {}, chromeCheckinState: async () => ({ checkedAtMs: Date.now(), intervalSeconds: 172800 }),
        recordChromeCheckin: async () => {}, recordMcsControl: async () => {}, recordMcsRecoveryControl: async () => {},
        markState: async () => {}, resetRetry: async () => {}, release: async () => { released = true; }, pendingMcs: async () => [], confirmMcs: async () => {},
        recordMcsFrame: async () => { throw new Error('unexpected normal receipt'); },
        recordMcsRecoveryFrame: async (_lease, row) => { if (failSecond && saved.length) throw new Error('private DB detail');
            saved.push(row.version); return { ...row, id: String(saved.length), duplicate: false }; } };
    class Socket extends EventEmitter {
        constructor() { super(); queueMicrotask(() => this.emit('secureConnect')); }
        write(bytes, done) { writes.push(bytes[0]); done(); if (bytes[0] === 41) queueMicrotask(() => this.emit('data', encodeFrame(3, field(1, 'ok'), { first: true }))); }
        pause() {} resume() {} destroy() {}
        frame(id) { return encodeFrame(8, Buffer.concat([field(3, file.push.authorizedEntity), field(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), field(9, id), field(21, Buffer.from(cipher.data, 'base64url'))])); }
    }
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { store, enabled: true, chromeEnabled: true,
        privateWorkerVault: { open: () => file }, rolloutMode: 'public', requestTimeoutMs: 60,
        chromeCheckin: async () => ({ intervalSeconds: 172800 }), createChromeSocket: () => socket = new Socket() });
    let error;
    try {
        await gateway.run({ ...lease, workerId: 'fixture', signal: new AbortController().signal,
            onStopping: () => { stoppingBeforeRelease = !released; },
            onSession: () => { socket.emit('data', Buffer.concat([socket.frame('first'), socket.frame('second')])); disconnected = true; socket.emit('close'); },
            onRecovery: async value => {
                callbacks++; callbackSignal = value.signal; assert.equal(value.lease.subscriptionId, lease.subscriptionId);
                assert.equal(released, false); assert.equal(value.signal.aborted, false);
                if (delayCallback) { await new Promise(resolve => setTimeout(resolve, 100)); lateWrite = !value.signal.aborted; finishLate(); }
            } });
    } catch (cause) { error = cause; }
    if (delayCallback) await late;
    return { error, saved, writes, callbacks, callbackSignal, released, stoppingBeforeRelease, lateWrite };
}

test('recovered receipts wake routing while the lease remains held without ACK', { timeout: 5000 }, async () => {
    const result = await runFixture();
    assert.equal(result.error.code, 'X_PUSH_SOCKET_CLOSED'); assert.deepEqual(result.saved, ['first', 'second']);
    assert.equal(result.callbacks, 1); assert.equal(result.released, true); assert.equal(result.stoppingBeforeRelease, true); assert.equal(result.callbackSignal.aborted, true);
    assert.deepEqual(result.writes, [41]);
});
test('a timed-out recovery callback receives cancellation before any later action', { timeout: 5000 }, async () => {
    const result = await runFixture({ delayCallback: true });
    assert.equal(result.error.code, 'X_PUSH_SOCKET_CLOSED'); assert.equal(result.callbacks, 1);
    assert.equal(result.callbackSignal.aborted, true); assert.equal(result.lateWrite, false); assert.equal(result.released, true);
});
test('revocation prevents the wake and a partial DB failure wakes only saved data', { timeout: 5000 }, async () => {
    const revoked = await runFixture({ revoke: true });
    assert.equal(revoked.error.code, 'X_PUSH_LEASE_LOST'); assert.deepEqual(revoked.saved, []); assert.equal(revoked.callbacks, 0);
    const partial = await runFixture({ failSecond: true });
    assert.equal(partial.error.code, 'X_PUSH_BUFFERED_RECOVERY_FAILED'); assert.deepEqual(partial.saved, ['first']);
    assert.equal(partial.callbacks, 1); assert.deepEqual(partial.writes, [41]);
});
