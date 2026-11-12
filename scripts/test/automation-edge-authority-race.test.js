'use strict';

// Synthetic gateway and transport only. No browser, database or provider is contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, randomBytes } = require('node:crypto');
const { fixture } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');

const id = '33333333-3333-4333-8333-333333333333', owner = '222222222222222222';
function edgeFile() {
    const original = fixture(), key = original.push.p256dhPrivateKey, application = createECDH('prime256v1');
    application.generateKeys();
    return { format: original.format, version: 3,
        provenance: { kind: 'edge-wns', adapterVersion: '1.0.0', browserVersion: '157.0.0.1', readMethod: 'edge-wns-snapshot' },
        push: { scope: 'https://x.com/', siteChannel: 'target', deviceKey: randomBytes(32).toString('base64url'), reconnectToken: 'synthetic-token',
            agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' },
            p256dhPublicKey: original.push.p256dhPublicKey, authenticationSecret: original.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d },
            applicationServerKey: application.getPublicKey().toString('base64url') } };
}

for (const phase of ['connect', 'send']) test(`Edge rechecks guardian after an authorized DB read before transport ${phase}`, async () => {
    let allowed = true, transportCreated = false, edgeGuards = 0, authorized = 0, connects = 0, sends = 0, closed = 0, released;
    const lease = { subscriptionId: id, ownerUserId: owner, revision: 1, token: 'a'.repeat(64), expiresAtMs: Date.now() + 30000, sealedEnvelope: { version: 2 } };
    const store = { leaseMs: 30000,
        claim: async (_input, options) => { await options.authorize(async () => []); return lease; },
        assertLease: async (_lease, options) => {
            await options.authorize(async () => []); authorized++;
            if (transportCreated && ++edgeGuards === (phase === 'connect' ? 1 : 2)) queueMicrotask(() => { allowed = false; });
        },
        auditUse: async (_lease, _outcome, options) => { await options.authorize(async () => []); },
        readWnsTokenState: async (_lease, options) => { await options.authorize(async () => []); return null; },
        saveWnsTokenState: async () => { throw new Error('unexpected token update'); },
        recordFrame: async () => { throw new Error('unexpected receipt'); }, getInbox: async () => null,
        release: async (_lease, state) => { released = state; },
    };
    const gateway = createXPushGateway({ queryDatabase: async () => [] }, { enabled: true, rolloutMode: 'public', edgeEnabled: true, store,
        privateWorkerVault: { open: () => edgeFile() }, edgeTokenVault: { seal() {}, open() {} },
        createEdgeTransport: () => { transportCreated = true; return {
            async connect() { connects++; }, async send() { sends++; }, async next() { throw new Error('unexpected read'); }, close() { closed++; },
        }; } });
    const result = await gateway.run({ subscriptionId: id, ownerUserId: owner, workerId: 'edge-authority-fixture',
        assertAllowed() { if (!allowed) throw new Error('synthetic guardian revoked'); } });
    assert.equal(result.state, 'authority_unavailable');
    assert.equal(allowed, false); assert(authorized >= (phase === 'connect' ? 3 : 4));
    assert.equal(connects, phase === 'connect' ? 0 : 1); assert.equal(sends, 0); assert(closed >= 1);
    assert.deepEqual(released, { state: 'stopped', reasonCode: null });
});
