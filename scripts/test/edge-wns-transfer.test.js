'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, randomBytes, generateKeyPairSync, createHash } = require('node:crypto');
const { normalizeEdgeTransfer, identifyEdgeTransfer } = require('../../src/automation/edge-wns-transfer');
const { parseTransferFile, identifyTransfer, createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXSetup } = require('../../src/automation/x-setup');
const { withEdgeWnsCredentials } = require('../../src/automation/edge-wns-credentials');
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
    const rotated = structuredClone(file); rotated.push.reconnectToken = 'fresh-token'; rotated.push.client.clientVersion = '2.3.4.5';
    assert.deepEqual(identifyEdgeTransfer(rotated), identity);
    rotated.push.authenticationSecret = randomBytes(16).toString('base64url');
    assert.notEqual(identifyEdgeTransfer(rotated).contentHash, identity.contentHash);
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
test('Edge transfer uses owner-bound hybrid vault and distinct identities', () => {
    const file = fixture(), parsed = parseTransferFile(JSON.stringify(file));
    assert.deepEqual(parsed, file);
    assert.deepEqual(identifyTransfer(parsed), { uaidHash: identifyEdgeTransfer(file).deviceHash,
        channelHash: identifyEdgeTransfer(file).channelHash, contentHash: identifyEdgeTransfer(file).contentHash });
    const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const sealer = createTransferPublicSealer({ activeKeyId: 'test', publicKeys: { test: keys.publicKey } });
    const vault = createTransferPrivateWorkerVault({ activeKeyId: 'test', privateKeys: { test: keys.privateKey } });
    const context = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
    const envelope = sealer.seal(file, context);
    assert(!JSON.stringify(envelope).includes(file.push.reconnectToken));
    assert.deepEqual(vault.open(envelope, context), file);
    assert.throws(() => vault.open(envelope, { ...context, ownerUserId: '987654321' }), { code: 'X_SETUP_DECRYPT_FAILED' });
});
test('Edge enrollment stays closed unless independently enabled', async () => {
    const token = 'a'.repeat(64), tokenHash = createHash('sha256').update(token).digest('hex'); let writes = 0;
    const db = { queryDatabase: async sql => {
        assert.match(sql, /automation_x_setup_sessions/);
        return [{ token_hash: tokenHash, consent_version: 1, consumed_at_ms: null, expires_at_ms: Date.now() + 60000 }];
    }, withDatabaseTransaction: async () => { writes++; throw new Error('unexpected write'); } };
    const service = createXSetup(db, { rolloutMode: 'public', sealer: { seal() { throw new Error('unexpected seal'); } },
        receiverEnabled: true, chromeEnabled: true, braveEnabled: true, edgeEnabled: false });
    const input = { sessionId: token, fileText: JSON.stringify(fixture()) };
    await assert.rejects(service.validate({ userId: '123456789' }, input), { code: 'X_SETUP_EDGE_NOT_READY' });
    await assert.rejects(service.importFile({ userId: '123456789' }, { ...input, consent: true }), { code: 'X_SETUP_EDGE_NOT_READY' });
    assert.equal(writes, 0);
});
test('worker borrows only bound credentials and wipes buffers after success or failure', async () => {
    const file = fixture(); let saved;
    assert.equal(await withEdgeWnsCredentials(file, async credentials => {
        saved = credentials; assert.equal(credentials.authenticationMode, 'bound');
        assert.equal(credentials.reconnectToken.toString('ascii'), file.push.reconnectToken);
        assert.equal(credentials.siteChannel.toString('ascii'), file.push.siteChannel);
        assert.equal(credentials.deviceKey.toString('base64url'), file.push.deviceKey);
        assert.equal(Object.hasOwn(credentials, 'productKey'), false); return 'ok';
    }), 'ok');
    for (const key of ['siteChannel', 'deviceKey', 'reconnectToken']) assert(saved[key].every(byte => byte === 0));
    await assert.rejects(withEdgeWnsCredentials(file, async credentials => { saved = credentials; throw new Error('fixture failure'); }), /fixture failure/);
    for (const key of ['siteChannel', 'deviceKey', 'reconnectToken']) assert(saved[key].every(byte => byte === 0));
    file.push.scope = 'https://example.com/'; let called = false;
    await assert.rejects(withEdgeWnsCredentials(file, async () => { called = true; }), { code: 'X_EDGE_WNS_CREDENTIALS_INVALID' });
    assert.equal(called, false);
});
