'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fixture, encrypted } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { encodeFrame } = require('../../src/automation/chrome-mcs-framing');
function v(n) { const a = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n, x) { const b = Buffer.isBuffer(x) ? x : Buffer.from(x); return Buffer.concat([v(n * 8 + 2), v(b.length), b]); }
const pair = (k, x) => field(7, Buffer.concat([field(1, k), field(2, x)]));

test('Chrome gateway requests server confirmation during a sustained receipt burst', async () => {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    const file = { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const wire = await encrypted(file, { notificationType: 'tweet', text: 'fixture' });
    const controller = new AbortController(), pending = new Set(); let commits = 0, socket, pingAfter;
    const lease = { subscriptionId: '11111111-1111-4111-8111-111111111111', ownerUserId: '222222222222222222', revision: 1,
        token: 'a'.repeat(64), expiresAtMs: Date.now() + 60000, sealedEnvelope: { version: 2 } };
    const store = { leaseMs: 60000, claim: async () => lease, renew: async () => lease, assertLease: async () => {}, auditUse: async () => {},
        chromeCheckinState: async () => ({ checkedAtMs: Date.now(), intervalSeconds: 172800 }),
        recordChromeCheckin: async () => { throw new Error('Check-in should not run during this receipt test'); },
        markState: async () => {}, resetRetry: async () => {}, release: async () => {}, pendingMcs: async () => [...pending],
        confirmMcs: async (_lease, ids) => ids.forEach(id => pending.delete(id)),
        recordMcsFrame: async (_lease, frame) => { commits++; pending.add(frame.version); return { ...frame, id: String(commits), duplicate: false }; } };
    class Socket extends EventEmitter {
        constructor() { super(); this.writes = []; queueMicrotask(() => this.emit('secureConnect')); }
        write(bytes, done) {
            this.writes.push(bytes); done();
            if (bytes[0] === 41) queueMicrotask(() => this.emit('data', encodeFrame(3, field(1, 'ok'), { first: true })));
            else if (bytes[0] === 7 && commits < 25) queueMicrotask(() => this.deliver(commits + 1));
            else if (bytes[0] === 0) { pingAfter = commits; queueMicrotask(() => controller.abort()); }
        }
        deliver(i) { this.emit('data', encodeFrame(8, Buffer.concat([field(3, file.push.authorizedEntity), field(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), field(9, `id-${i}`), field(21, Buffer.from(wire.data, 'base64url'))]))); }
        pause() {} resume() {} destroy() {}
    }
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { store, enabled: true, chromeEnabled: true,
        privateWorkerVault: { open: () => file }, rolloutMode: 'public', requestTimeoutMs: 3000, createChromeSocket: () => socket = new Socket() });
    const result = await gateway.run({ ...lease, workerId: 'fixture', signal: controller.signal, onSession: () => socket.deliver(1) });
    assert.deepEqual(result, { state: 'stopped', reasonCode: null });
    assert.equal(commits, 25); assert.equal(pingAfter, 25); assert.equal(pending.size, 25);
});
