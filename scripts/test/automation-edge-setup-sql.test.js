'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, generateKeyPairSync, createECDH } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { fixture: firefox } = require('./helpers/x-push-fixture.cjs');
const { createXSetup } = require('../../src/automation/x-setup');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createTransferPublicSealer, createTransferPrivateWorkerVault, createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), owner = { userId: '222222222222222222' }, other = { userId: '333333333333333333' };
function fixture() {
    const f = firefox(), k = f.push.p256dhPrivateKey, app = createECDH('prime256v1'); app.generateKeys();
    return { format: f.format, version: 3, provenance: { kind: 'edge-wns', adapterVersion: '1.0.0', browserVersion: '157.0.0.1', readMethod: 'edge-wns-snapshot' },
        push: { scope: 'https://x.com/', siteChannel: 'target', deviceKey: randomBytes(32).toString('base64url'), reconnectToken: 'old-token',
            agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' },
            p256dhPublicKey: f.push.p256dhPublicKey, authenticationSecret: f.push.authenticationSecret,
            p256dhPrivateKey: { kty: k.kty, crv: k.crv, x: k.x, y: k.y, d: k.d }, applicationServerKey: app.getPublicKey().toString('base64url') } };
}
async function payload(service, actor, file) { const session = await service.startSession(actor, { consent: true });
    return { sessionId: session.sessionId, fileText: JSON.stringify(file), consent: true }; }
test('Edge reimport fences old receiver, retains inbox, and replaces rotated token without sharing across owners', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const sealer = createTransferPublicSealer({ activeKeyId: 'test', publicKeys: { test: keys.publicKey } });
        const vault = createTransferPrivateWorkerVault({ activeKeyId: 'test', privateKeys: { test: keys.privateKey } });
        const tokenVault = createWnsTokenWorkerVault({ activeKeyId: 'test', privateKeys: { test: keys.privateKey } });
        const service = createXSetup(db, { sealer, rolloutMode: 'public', receiverEnabled: true, edgeEnabled: true }), file = fixture();
        const disabled = createXSetup(db, { sealer, rolloutMode: 'public', receiverEnabled: true, edgeEnabled: false });
        await assert.rejects(disabled.importFile(owner, await payload(disabled, owner, file)), { code: 'X_SETUP_EDGE_NOT_READY' });
        const body = await payload(service, owner, file), preview = await service.validate(owner, { sessionId: body.sessionId, fileText: body.fileText });
        assert.equal(preview.browserKind, 'edge'); const saved = await service.importFile(owner, body);
        assert.equal(saved.subscription.browserKind, 'edge');
        const identity = { subscriptionId: saved.subscription.id, ownerUserId: owner.userId }, store = createXPushStore(db);
        const settings = JSON.stringify({ subscriptionId: identity.subscriptionId, destination: 'fixture' });
        await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,0,0)", [owner.userId, settings]);
        const lease = await store.claim({ ...identity, workerId: 'old-edge-worker' });
        await store.saveWnsTokenState(lease, { vault: tokenVault, authorize: async () => {}, token: Buffer.from('rotated-token'), expectedGeneration: 0 });
        await store.recordFrame(lease, { version: 'fixture', data: Buffer.from('cipher').toString('base64url'), headers: { encoding: 'aes128gcm' }, status: 'received', ackCode: 100 });
        const fresh = structuredClone(file); fresh.push.reconnectToken = 'fresh-token'; fresh.push.client.clientVersion = '2.3.4.5';
        const failingDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            if (sql.startsWith("UPDATE automation_x_push_receivers SET state='awaiting'")) throw new Error('synthetic database failure');
            return query(sql, params);
        })) };
        const failingService = createXSetup(failingDb, { sealer, rolloutMode: 'public', receiverEnabled: true, edgeEnabled: true });
        await assert.rejects(failingService.importFile(owner, await payload(failingService, owner, fresh)), /synthetic database failure/);
        await store.assertLease(lease);
        const prior = await store.readWnsTokenState(lease, { vault: tokenVault, authorize: async () => {} });
        assert.equal(prior.token.toString(), 'rotated-token'); prior.token.fill(0);
        const before = (await db.queryDatabase('SELECT sealed_json FROM automation_x_subscriptions WHERE id=?', [identity.subscriptionId]))[0];
        assert.deepEqual(vault.open(JSON.parse(before.sealed_json), { subscriptionId: identity.subscriptionId, ownerUserId: owner.userId, revision: 1 }), file);
        const duplicate = await service.importFile(owner, await payload(service, owner, fresh));
        assert.equal(duplicate.duplicate, true); assert.equal(duplicate.subscription.id, saved.subscription.id); assert.equal(duplicate.subscription.revision, 1);
        await assert.rejects(store.assertLease(lease), { code: 'X_PUSH_LEASE_LOST' });
        const rows = await db.queryDatabase('SELECT * FROM automation_x_push_inbox WHERE subscription_id=?', [identity.subscriptionId]); assert.equal(rows.length, 1);
        const monitors = await db.queryDatabase('SELECT notification_settings_json,subscription_state,revision FROM automation_x_monitors WHERE owner_user_id=?', [owner.userId]);
        assert.equal(monitors.length, 1); assert.equal(monitors[0].notification_settings_json, settings); assert.equal(monitors[0].subscription_state, 'bound'); assert.equal(Number(monitors[0].revision), 1);
        const next = await store.claim({ ...identity, workerId: 'new-edge-worker' }); assert(next);
        assert.equal(await store.readWnsTokenState(next, { vault: tokenVault, authorize: async () => {} }), null);
        assert.deepEqual(vault.open(next.sealedEnvelope, { subscriptionId: identity.subscriptionId, ownerUserId: owner.userId, revision: 1 }), fresh);
        await assert.rejects(service.importFile(other, await payload(service, other, fresh)), { code: 'X_SETUP_SUBSCRIPTION_CONFLICT' });
        const changed = structuredClone(fresh); changed.push.authenticationSecret = randomBytes(16).toString('base64url');
        await assert.rejects(service.importFile(owner, await payload(service, owner, changed)), { code: 'X_SETUP_SUBSCRIPTION_CONFLICT' });
        await store.assertLease(next);
        const another = structuredClone(fresh); another.push.reconnectToken = 'another-token';
        const concurrentBody = await payload(service, owner, another);
        const results = await Promise.allSettled([service.importFile(owner, concurrentBody), service.importFile(owner, concurrentBody)]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const rejected = results.find(result => result.status === 'rejected'); assert.equal(rejected.reason.code, 'X_SETUP_SESSION_USED');
        await assert.rejects(store.assertLease(next), { code: 'X_PUSH_LEASE_LOST' });
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox WHERE subscription_id=?', [identity.subscriptionId])).length, 1);
    } finally { await db.close(); }
});
