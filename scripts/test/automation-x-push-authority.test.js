'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createChromeMcsStoreAdapter } = require('../../src/automation/chrome-mcs-store-adapter');
const { fixture, FakeSocket } = require('./helpers/x-push-fixture.cjs');
const { EventEmitter } = require('node:events');
const id = '33333333-3333-4333-8333-333333333333', owner = '222222222222222222';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('guardian revocation during rollout lookup prevents claim and provider access', async () => {
    const entered = deferred(), release = deferred(); let allowed = true, claims = 0, sockets = 0, opens = 0;
    const gateway = createXPushGateway({ queryDatabase: async () => { entered.resolve(); await release.promise; return [{ is_donor: 1 }]; } }, {
        enabled: true, rolloutMode: 'supporters', store: { claim: async () => { claims++; } },
        privateWorkerVault: { open: () => { opens++; } }, createSocket: () => { sockets++; },
    });
    const run = gateway.run({ subscriptionId: id, ownerUserId: owner, workerId: 'test',
        assertAllowed() { if (!allowed) throw new Error('guardian lost'); } });
    await entered.promise; allowed = false; release.resolve();
    await assert.rejects(run, { code: 'X_PUSH_AUTHORITY_UNAVAILABLE' });
    assert.deepEqual([claims, sockets, opens], [0, 0, 0]);
});

test('guardian revocation after claim stops before vault access and releases the owned lease', async () => {
    let allowed = true, sockets = 0, opens = 0, released;
    const lease = { subscriptionId: id, ownerUserId: owner, revision: 1, token: 'a'.repeat(64), expiresAtMs: Date.now() + 30000, sealedEnvelope: { version: 2 } };
    const store = { leaseMs: 30000,
        claim: async (_input, options) => { await options.authorize(async () => []); allowed = false; return lease; },
        assertLease: async (_lease, options) => { await options.authorize(async () => []); },
        release: async (_lease, state) => { released = state; },
    };
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { enabled: true, rolloutMode: 'public', store,
        privateWorkerVault: { open: () => { opens++; } }, createSocket: () => { sockets++; } });
    const result = await gateway.run({ subscriptionId: id, ownerUserId: owner, workerId: 'test',
        assertAllowed() { if (!allowed) throw new Error('guardian lost'); } });
    assert.equal(result.state, 'authority_unavailable'); assert.equal(opens, 0); assert.equal(sockets, 0);
    assert.deepEqual(released, { state: 'stopped', reasonCode: null });
});

test('guard must be synchronous and its rejection never permits a claim', async () => {
    let claims = 0;
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { enabled: true, rolloutMode: 'public',
        store: { claim: async () => { claims++; } }, privateWorkerVault: { open() {} } });
    await assert.rejects(gateway.run({ subscriptionId: id, ownerUserId: owner, workerId: 'test',
        assertAllowed: () => Promise.reject(new Error('synthetic rejected guard')) }), { code: 'X_PUSH_AUTHORITY_UNAVAILABLE' });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(claims, 0);
});

test('gateway and supervisor guards are both enforced without repeating the same guard', async () => {
    for (const denied of ['gateway', 'supervisor']) {
        let claims = 0, gatewayCalls = 0, supervisorCalls = 0;
        const gateway = createXPushGateway({ queryDatabase: async () => [] }, { enabled: true, rolloutMode: 'public',
            assertAllowed() { gatewayCalls++; if (denied === 'gateway') throw new Error('denied'); },
            store: { claim: async () => { claims++; } }, privateWorkerVault: { open() {} } });
        await assert.rejects(gateway.run({ subscriptionId: id, ownerUserId: owner, workerId: 'test',
            assertAllowed() { supervisorCalls++; if (denied === 'supervisor') throw new Error('denied'); } }), { code: 'X_PUSH_AUTHORITY_UNAVAILABLE' });
        assert.equal(claims, 0); assert.equal(gatewayCalls, 1); assert.equal(supervisorCalls, denied === 'gateway' ? 0 : 1);
    }
    let guardCalls = 0;
    const shared = () => { guardCalls++; };
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { enabled: true, rolloutMode: 'public', assertAllowed: shared,
        store: { claim: async (_input, options) => { await options.authorize(async () => []); return null; } }, privateWorkerVault: { open() {} } });
    assert.equal((await gateway.run({ subscriptionId: id, ownerUserId: owner, workerId: 'test', assertAllowed: shared })).state, 'busy');
    // Two outer checks plus pre-claim's before/after checks: no duplicate call
    // merely because the same trusted function was supplied twice.
    assert.equal(guardCalls, 4);
});

test('MCS guardian failure before decrypt is not converted into a bad-payload ACK', async () => {
    let decryptions = 0, writes = 0;
    const store = { pendingMcs() {}, confirmMcs() {}, recordMcsControl() {},
        recordMcsFrame() { writes++; }, recordMcsRecoveryFrame() { writes++; } };
    const adapter = createChromeMcsStoreAdapter({ store, lease: {}, authorize: async () => {},
        decrypt() { decryptions++; }, assertAllowed() { throw Object.assign(new Error('stopped'), { code: 'X_PUSH_AUTHORITY_UNAVAILABLE' }); } });
    const message = { persistentId: 'synthetic', encrypted: { data: Buffer.from('ciphertext'), headers: {} } };
    await assert.rejects(adapter.commit(message), { code: 'X_PUSH_AUTHORITY_UNAVAILABLE' });
    await assert.rejects(adapter.recover(message), { code: 'X_PUSH_AUTHORITY_UNAVAILABLE' });
    assert.equal(decryptions, 0); assert.equal(writes, 0);
});

for (const kind of ['firefox', 'chrome']) test(`${kind} rechecks guardian immediately before the first authentication write`, async () => {
    let allowed = true, socket, released;
    const original = fixture(), key = original.push.p256dhPrivateKey;
    const file = kind === 'firefox' ? original : { format: original.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: original.push.p256dhPublicKey, authenticationSecret: original.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const lease = { subscriptionId: id, ownerUserId: owner, revision: 1, token: 'a'.repeat(64), expiresAtMs: Date.now() + 30000, sealedEnvelope: { version: 2 } };
    const store = { leaseMs: 30000,
        claim: async (_input, options) => { await options.authorize(async () => []); return lease; },
        assertLease: async (_lease, options) => { await options.authorize(async () => []); if (socket) allowed = false; },
        auditUse: async () => {}, release: async (_lease, state) => { released = state; },
        pendingMcs: async (_lease, options) => { await options.authorize(async () => []); return []; },
        confirmMcs() {}, recordMcsFrame() {}, recordMcsControl() {},
    };
    class SyntheticMcsSocket extends EventEmitter {
        constructor() { super(); this.writes = []; queueMicrotask(() => this.emit('secureConnect')); }
        write(value, done) { this.writes.push(value); done(); }
        pause() {} resume() {} destroy() {}
    }
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { enabled: true, rolloutMode: 'public', chromeEnabled: true, store,
        privateWorkerVault: { open: () => file },
        createSocket: () => socket = new FakeSocket(() => {}), createChromeSocket: () => socket = new SyntheticMcsSocket() });
    const result = await gateway.run({ subscriptionId: id, ownerUserId: owner, workerId: 'test',
        assertAllowed() { if (!allowed) throw new Error('guardian lost'); } });
    assert.equal(result.state, 'authority_unavailable');
    assert.equal(kind === 'firefox' ? socket.sent.length : socket.writes.length, 0);
    assert.deepEqual(released, { state: 'stopped', reasonCode: null });
});
