'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, randomBytes } = require('node:crypto');
const { normalizeEdgeTransfer, identifyEdgeTransfer } = require('../../src/automation/edge-wns-transfer');
const enc = value => value.toString('base64url');
function fixture() {
    const key = createECDH('prime256v1'); key.generateKeys(); const pub = key.getPublicKey();
    const app = createECDH('prime256v1'); app.generateKeys();
    return { format: 'x-notification-subscription', version: 3,
        provenance: { kind: 'edge-wns', adapterVersion: '1.0.0', browserVersion: '157.0.1.2', readMethod: 'edge-wns-snapshot' },
        push: { scope: 'https://x.com/', siteChannel: 'site-1', deviceKey: enc(randomBytes(32)), reconnectToken: 'synthetic-token',
            agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' },
            p256dhPublicKey: enc(pub), authenticationSecret: enc(randomBytes(16)),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: enc(pub.subarray(1, 33)), y: enc(pub.subarray(33)), d: enc(key.getPrivateKey()) },
            applicationServerKey: enc(app.getPublicKey()) } };
}
test('normalizes a valid bound Edge file and generates stable device and site identities', () => {
    const file = fixture(), copy = normalizeEdgeTransfer(file), identity = identifyEdgeTransfer(file);
    assert.deepEqual(copy, file); assert.notEqual(copy.push, file.push);
    const other = structuredClone(file); other.push.siteChannel = 'site-2';
    const changed = identifyEdgeTransfer(other);
    assert.equal(identity.deviceHash, changed.deviceHash); assert.notEqual(identity.channelHash, changed.channelHash);
    assert.notEqual(identity.contentHash, changed.contentHash);
});
test('rejects malformed and unsafe transfer data', () => {
    const mutations = [
        f => { f.version = 2; }, f => { f.push.scope = 'https://example.com/'; }, f => { f.push.siteChannel = ''; },
        f => { f.push.deviceKey = enc(randomBytes(31)); }, f => { f.push.reconnectToken = '<bad>'; },
        f => { f.push.client.channel = 'no space'; }, f => { f.push.agent.locale = '<bad>'; },
        f => { f.push.authenticationSecret = enc(randomBytes(15)); }, f => { f.push.p256dhPrivateKey.d = enc(randomBytes(32)); },
        f => { f.push.applicationServerKey = enc(Buffer.alloc(65)); }, f => { f.push.extra = true; },
    ];
    for (const mutate of mutations) { const file = fixture(); mutate(file); assert.throws(() => normalizeEdgeTransfer(file), { code: 'X_EDGE_TRANSFER_INVALID' }); }
});
test('does not invoke accessors in untrusted data', () => {
    const file = fixture(); let invoked = false;
    Object.defineProperty(file.push.client, 'clientName', { enumerable: true, get() { invoked = true; throw new Error(); } });
    assert.throws(() => normalizeEdgeTransfer(file), { code: 'X_EDGE_TRANSFER_INVALID' }); assert.equal(invoked, false);
});
