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
const syntheticCheckin = async () => ({ intervalSeconds: 172800 });

test('Chrome gateway preserves owned queued receipts after disconnect without acknowledging them', { timeout: 5000 }, async () => {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    const file = { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const encryptedFixture = await encrypted(file, { notificationType: 'tweet', text: 'fixture' });
    for (const mode of ['valid', 'ack_fail', 'ack_confirm', 'flood', 'protocol', 'same_chunk', 'invalid_control', 'revoked', 'database']) {
        const saved = [], writes = []; let socket, disconnected = false;
        const lease = { subscriptionId: '11111111-1111-4111-8111-111111111111', ownerUserId: '222222222222222222', revision: 1,
            token: 'a'.repeat(64), expiresAtMs: Date.now() + 60000, sealedEnvelope: { version: 2 } };
        const store = { leaseMs: 60000, claim: async () => lease, renew: async () => lease,
            assertLease: async () => { if (disconnected && mode === 'revoked') throw Object.assign(new Error('revoked'), { code: 'X_PUSH_LEASE_LOST' }); },
            auditUse: async () => {}, chromeCheckinState: async () => ({ checkedAtMs: Date.now(), intervalSeconds: 172800 }),
            recordChromeCheckin: async () => { throw new Error('unexpected checkin'); }, recordMcsControl: async () => {},
            markState: async () => {}, resetRetry: async () => {}, release: async () => {}, pendingMcs: async () => [], confirmMcs: async () => {},
            recordMcsFrame: async (_lease, frame) => { if (mode === 'database') throw new Error('private database details'); saved.push(frame.version); return { ...frame, id: frame.version, duplicate: false }; } };
        store.recordMcsRecoveryFrame = (...args) => store.recordMcsFrame(...args);
        store.recordMcsRecoveryControl = (...args) => store.recordMcsControl(...args);
        class Socket extends EventEmitter {
            constructor() { super(); queueMicrotask(() => this.emit('secureConnect')); }
            write(bytes, done) { writes.push(bytes[0]);
                if (['ack_fail', 'ack_confirm'].includes(mode) && bytes[0] === 7) { disconnected = true; done(new Error('socket failed')); return; }
                done();
                if (bytes[0] === 41) queueMicrotask(() => this.emit('data', encodeFrame(3, field(1, 'ok'), { first: true }))); }
            pause() {} resume() {} destroy() {}
            deliver(id, subtype = file.push.appId) { return encodeFrame(8, Buffer.concat([field(3, file.push.authorizedEntity), field(5, file.push.productCategory),
                pair('subtype', subtype), pair('content-encoding', 'aes128gcm'), field(9, id), field(21, Buffer.from(encryptedFixture.data, 'base64url'))])); }
        }
        const gateway = createXPushGateway({ queryDatabase: async () => [] }, { store, enabled: true, chromeEnabled: true,
            privateWorkerVault: { open: () => file }, rolloutMode: 'public', requestTimeoutMs: 2000, chromeCheckin: syntheticCheckin, createChromeSocket: () => socket = new Socket() });
        await assert.rejects(gateway.run({ ...lease, workerId: 'fixture', signal: new AbortController().signal,
            onSession: () => { const frames = mode === 'flood' ? Array.from({ length: 17 }, (_, i) => socket.deliver(`flood-${i}`))
                : [socket.deliver('own-1'), socket.deliver('foreign', 'other'), ...(mode === 'ack_confirm' ? [encodeFrame(1, Buffer.from([16, 2]))] : []),
                    ...(mode === 'invalid_control' ? [encodeFrame(10, Buffer.alloc(0))] : []), socket.deliver('own-2')];
                socket.emit('data', Buffer.concat(mode === 'same_chunk' ? [...frames, Buffer.from([255])] : frames));
                if (mode === 'protocol') socket.emit('data', Buffer.from([255]));
                else if (!['ack_fail', 'ack_confirm', 'same_chunk'].includes(mode)) { disconnected = true; socket.emit('close'); } } }), error => {
            assert.equal(error.code, mode === 'valid' ? 'X_PUSH_SOCKET_CLOSED' : ['ack_fail', 'ack_confirm'].includes(mode) ? 'X_PUSH_SOCKET_FAILED'
                : mode === 'flood' ? 'X_PUSH_SOCKET_CLOSED' : ['protocol', 'same_chunk'].includes(mode) ? 'X_PUSH_PROTOCOL_INVALID'
                : mode === 'revoked' ? 'X_PUSH_LEASE_LOST' : 'X_PUSH_BUFFERED_RECOVERY_FAILED');
            assert(!error.message.includes('private')); return true;
        });
        assert.deepEqual(saved, mode === 'flood' ? Array.from({ length: 17 }, (_, i) => `flood-${i}`)
            : mode === 'invalid_control' ? ['own-1'] : ['valid', 'ack_fail', 'ack_confirm', 'protocol', 'same_chunk'].includes(mode) ? ['own-1', 'own-2'] : []);
        assert.deepEqual(writes, ['ack_fail', 'ack_confirm'].includes(mode) ? [41, 7] : [41], 'recovery must not acknowledge queued frames');
    }
});

test('Chrome gateway continues a receipt burst while downstream routing is stalled', { timeout: 5000 }, async () => {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    const file = { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const wire = await encrypted(file, { notificationType: 'tweet', text: 'fixture' });
    const controller = new AbortController(), pending = new Set(); let commits = 0, socket, pingAfter, wakeups = 0;
    const lease = { subscriptionId: '11111111-1111-4111-8111-111111111111', ownerUserId: '222222222222222222', revision: 1,
        token: 'a'.repeat(64), expiresAtMs: Date.now() + 60000, sealedEnvelope: { version: 2 } };
    const store = { leaseMs: 60000, claim: async () => lease, renew: async () => lease, assertLease: async () => {}, auditUse: async () => {},
        chromeCheckinState: async () => ({ checkedAtMs: Date.now(), intervalSeconds: 172800 }),
        recordChromeCheckin: async () => { throw new Error('Check-in should not run during this receipt test'); },
        recordMcsControl: async () => { throw new Error('Control notice should not occur during this receipt test'); },
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
        privateWorkerVault: { open: () => file }, rolloutMode: 'public', requestTimeoutMs: 3000, chromeCheckin: syntheticCheckin, createChromeSocket: () => socket = new Socket() });
    const result = await gateway.run({ ...lease, workerId: 'fixture', signal: controller.signal, onSession: () => socket.deliver(1),
        onReceived: () => { wakeups++; return new Promise(() => {}); } });
    assert.deepEqual(result, { state: 'stopped', reasonCode: null });
    assert.equal(commits, 25); assert.equal(pingAfter, 25); assert.equal(pending.size, 25); assert.equal(wakeups, 1);
});

test('one gateway handles simultaneous independent receivers without crossing receipts', { timeout: 15000 }, async () => {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    const file = { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const wire = await encrypted(file, { notificationType: 'tweet', text: 'fixture' });
    const count = 256, sockets = [], commits = new Map(), received = new Map(), controllers = [];
    const store = { leaseMs: 60000, claim: async input => input, renew: async lease => lease, assertLease: async () => {}, auditUse: async () => {},
        chromeCheckinState: async () => ({ checkedAtMs: Date.now(), intervalSeconds: 172800 }),
        recordChromeCheckin: async () => { throw new Error('Unexpected check-in'); },
        recordMcsControl: async () => { throw new Error('Unexpected control notice'); },
        markState: async () => {}, resetRetry: async () => {}, release: async () => {}, pendingMcs: async () => [], confirmMcs: async () => {},
        recordMcsFrame: async (lease, frame) => {
            assert(!commits.has(lease.subscriptionId));
            commits.set(lease.subscriptionId, frame.version);
            return { ...frame, id: frame.version, status: 'received', duplicate: false };
        } };
    class Socket extends EventEmitter {
        constructor() { super(); this.id = sockets.length; sockets.push(this); queueMicrotask(() => this.emit('secureConnect')); }
        write(bytes, done) {
            done();
            if (bytes[0] === 41) queueMicrotask(() => this.emit('data', encodeFrame(3, field(1, 'ok'), { first: true })));
        }
        deliver() { this.emit('data', encodeFrame(8, Buffer.concat([field(3, file.push.authorizedEntity), field(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), field(9, `independent-${this.id}`),
            field(21, Buffer.from(wire.data, 'base64url'))]))); }
        pause() {} resume() {} destroy() {}
    }
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { store, enabled: true, chromeEnabled: true,
        privateWorkerVault: { open: () => file }, rolloutMode: 'public', requestTimeoutMs: 5000, chromeCheckin: syntheticCheckin, createChromeSocket: () => new Socket() });
    let ready = 0;
    try {
        const runs = Array.from({ length: count }, (_, i) => {
            const controller = new AbortController(); controllers.push(controller);
            const subscriptionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
            return gateway.run({ subscriptionId, ownerUserId: String(222222222222222222n + BigInt(i)), revision: 1,
                token: 'a'.repeat(64), expiresAtMs: Date.now() + 60000, sealedEnvelope: { version: 2 }, workerId: 'fixture', signal: controller.signal,
                onSession: () => { if (++ready === count) sockets.forEach(socket => socket.deliver()); },
                onReceived: ({ lease, inbox, payload }) => {
                    assert.equal(lease.subscriptionId, subscriptionId);
                    assert.equal(inbox.version, commits.get(subscriptionId));
                    assert.equal(payload.text, 'fixture');
                    received.set(subscriptionId, inbox.version);
                    controller.abort();
                } });
        });
        const results = await Promise.all(runs);
        assert.equal(ready, count); assert.equal(received.size, count); assert.equal(new Set(received.values()).size, count);
        assert(results.every(result => result.state === 'stopped'));
    } finally { controllers.forEach(controller => controller.abort()); }
});
