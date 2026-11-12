'use strict';
// This disposable fixture deliberately exercises the public rollout stage.
process.env.X_NOTIFICATION_ROLLOUT = 'public';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { createTestDatabase, applyTestMigration } = require('../lib/automation-test-db');
const { createXSetup, sealerFromEnvironment, SESSION_TTL_MS } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { dispatch } = require('../../src/automation/api');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const A = { userId: '222222222222222222' }, B = { userId: '333333333333333333', isAdmin: true };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const vaultConfig = { activeKeyId: 'fixture1', publicKeys: { fixture1: publicKey } };
const sealer = createTransferPublicSealer(vaultConfig);
function fixture() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0a1', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: randomUUID(), channelID: randomUUID(), pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/fixture-secret-endpoint', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
            authenticationSecret: randomBytes(16).toString('base64url'), p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true, key_ops: ['deriveBits'] } } };
}
async function setup(t, work) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try { await work(db); } finally { await db.close(); }
}
async function payload(service, actor, file = fixture()) {
    const session = await service.startSession(actor, { consent: true });
    return { sessionId: session.sessionId, fileText: JSON.stringify(file), consent: true };
}
const code = expected => error => error.code === expected;

function chromeFixture() {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    return { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123456', securityToken: '987654', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
}
function braveFixture() {
    const file = chromeFixture();
    file.provenance = { kind: 'brave-gcm', adapterVersion: '1.0.0', browserVersion: '157.1.99.55', engineVersion: '157.0.8103.39', readMethod: 'brave-gcm-snapshot' };
    file.push.productCategory = 'com.brave.windows';
    return file;
}
test('Mac Brave intake is separately gated and encrypted without affecting Windows Brave', async t => setup(t, async db => {
    const file = braveFixture(); file.push.productCategory = 'com.brave.macosx';
    const macSealer = createTransferPublicSealer({ ...vaultConfig, allowBraveMac: true });
    for (const flags of [
        { chromeEnabled: true, braveEnabled: true, braveMacEnabled: false, receiverEnabled: true },
        { chromeEnabled: true, braveEnabled: false, braveMacEnabled: true, receiverEnabled: true },
        { chromeEnabled: false, braveEnabled: true, braveMacEnabled: true, receiverEnabled: true },
    ]) {
        const disabled = createXSetup(db, { sealer: macSealer, ...flags });
        const rejected = await payload(disabled, A, file);
        await assert.rejects(disabled.validate(A, { sessionId: rejected.sessionId, fileText: rejected.fileText }), code('X_SETUP_INVALID_FILE'));
        await assert.rejects(disabled.importFile(A, rejected), code('X_SETUP_INVALID_FILE'));
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    }
    const service = createXSetup(db, { sealer: macSealer, chromeEnabled: true, braveEnabled: true, braveMacEnabled: true, receiverEnabled: true });
    const body = await payload(service, A, file);
    assert.equal((await service.validate(A, { sessionId: body.sessionId, fileText: body.fileText })).browserKind, 'brave');
    const saved = await service.importFile(A, body);
    const row = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]))[0];
    assert(!JSON.stringify(row).includes(file.push.securityToken));
    const worker = createTransferPrivateWorkerVault({ activeKeyId: 'fixture1', privateKeys: { fixture1: privateKey }, allowBraveMac: true });
    assert.deepEqual(worker.open(JSON.parse(row.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), file);
    await assert.rejects(service.importFile(B, await payload(service, B, file)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
    const repeated = await service.importFile(A, await payload(service, A, file));
    assert.equal(repeated.duplicate, true); assert.equal(repeated.subscription.id, saved.subscription.id);
}));
test('Mac Chrome intake is separately gated and the enabled transfer stays owner-bound', async t => setup(t, async db => {
    const file = chromeFixture(); file.push.productCategory = 'com.chrome.macosx';
    const disabled = createXSetup(db, { sealer, chromeEnabled: true, chromeMacEnabled: false, receiverEnabled: true });
    const rejected = await payload(disabled, A, file);
    await assert.rejects(disabled.validate(A, { sessionId: rejected.sessionId, fileText: rejected.fileText }), code('X_SETUP_CHROME_MAC_NOT_READY'));
    await assert.rejects(disabled.importFile(A, rejected), code('X_SETUP_CHROME_MAC_NOT_READY'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    const enabled = createXSetup(db, { sealer, chromeEnabled: true, chromeMacEnabled: true, receiverEnabled: true });
    const body = await payload(enabled, A, file);
    assert.equal((await enabled.validate(A, { sessionId: body.sessionId, fileText: body.fileText })).formatVersion, 2);
    const saved = await enabled.importFile(A, body);
    const row = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]))[0];
    const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture1', privateKeys: { fixture1: privateKey } });
    assert.deepEqual(vault.open(JSON.parse(row.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), file);
    await assert.rejects(enabled.importFile(B, await payload(enabled, B, file)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
}));
test('Brave intake is gated, owner-bound and retains distinct browser and engine versions', async t => setup(t, async db => {
    const file = braveFixture(), disabled = createXSetup(db, { sealer, chromeEnabled: false, receiverEnabled: true });
    const rejected = await payload(disabled, A, file);
    await assert.rejects(disabled.importFile(A, rejected), code('X_SETUP_CHROME_NOT_READY'));
    const chromeOnly = createXSetup(db, { sealer, chromeEnabled: true, braveEnabled: false, receiverEnabled: true });
    const notEnabled = await payload(chromeOnly, A, file);
    await assert.rejects(chromeOnly.importFile(A, notEnabled), code('X_SETUP_BRAVE_NOT_READY'));
    const service = createXSetup(db, { sealer, chromeEnabled: true, braveEnabled: true, receiverEnabled: true });
    const body = await payload(service, A, file);
    const preview = await service.validate(A, { sessionId: body.sessionId, fileText: body.fileText });
    assert.equal(preview.browserKind, 'brave'); assert.equal(preview.browserVersion, file.provenance.browserVersion);
    const saved = await service.importFile(A, body); assert.equal(saved.subscription.browserKind, 'brave');
    const row = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]))[0];
    const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture1', privateKeys: { fixture1: privateKey } });
    assert.deepEqual(vault.open(JSON.parse(row.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), file);
    await assert.rejects(service.importFile(B, await payload(service, B, file)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
    const updated = structuredClone(file); updated.provenance.engineVersion = '157.0.8103.40';
    const repeated = await service.importFile(A, await payload(service, A, updated));
    assert.equal(repeated.duplicate, true); assert.equal(repeated.subscription.id, saved.subscription.id);
    const refreshed = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [row.id]))[0];
    assert.equal(Number(refreshed.revision), Number(row.revision));
    assert.deepEqual(vault.open(JSON.parse(refreshed.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), updated);
}));
test('Chrome transfers stay unavailable until the complete receiver is enabled', async t => setup(t, async db => {
    const chrome = chromeFixture();
    const service = createXSetup(db, { sealer }), body = await payload(service, A, chrome);
    await assert.rejects(service.validate(A, { sessionId: body.sessionId, fileText: body.fileText }), code('X_SETUP_CHROME_NOT_READY'));
    await assert.rejects(service.importFile(A, body), code('X_SETUP_CHROME_NOT_READY'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    assert.equal((await db.queryDatabase('SELECT consumed_at_ms FROM automation_x_setup_sessions'))[0].consumed_at_ms, null);
}));
test('enabled Chrome intake encrypts the transfer, binds ownership and preserves existing subscriptions', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer, chromeEnabled: true, receiverEnabled: true });
    const file = chromeFixture(), body = await payload(service, A, file);
    assert.equal((await service.status(A)).chromeEnabled, true);
    assert.equal((await service.validate(A, { sessionId: body.sessionId, fileText: body.fileText })).formatVersion, 2);
    const saved = await service.importFile(A, body); assert.equal(saved.duplicate, false);
    assert.equal(saved.subscription.browserKind, 'chrome');
    const row = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions'))[0];
    assert(!JSON.stringify(row).includes(file.push.securityToken));
    const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture1', privateKeys: { fixture1: privateKey } });
    assert.deepEqual(vault.open(JSON.parse(row.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), file);
    const receiver = require('../../src/automation/x-push-store').createXPushStore(db);
    const lease = await receiver.claim({ subscriptionId: row.id, ownerUserId: A.userId, workerId: 'refresh-test' });
    await receiver.markState(lease, 'listening');
    const repeated = await service.importFile(A, await payload(service, A, file));
    const after = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [row.id]))[0];
    assert.equal(repeated.duplicate, true); assert.equal(repeated.subscription.id, saved.subscription.id);
    assert.equal(repeated.subscription.receiverState, 'connecting');
    assert(Number(after.updated_at_ms) > Number(row.updated_at_ms));
    assert.equal(after.sealed_json, row.sealed_json); assert.equal(Number(after.revision), Number(row.revision));
    const updatedFile = structuredClone(file); updatedFile.provenance.browserVersion = '141.0.0.1';
    const updated = await service.importFile(A, await payload(service, A, updatedFile));
    const updatedRow = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [row.id]))[0];
    assert.equal(updated.duplicate, true); assert.equal(updated.subscription.browserVersion, '141.0.0.1');
    assert.equal(Number(updatedRow.revision), Number(row.revision));
    assert.deepEqual(vault.open(JSON.parse(updatedRow.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), updatedFile);
    const other = await payload(service, B, file);
    await assert.rejects(service.importFile(B, other), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
    assert.equal(Number((await db.queryDatabase('SELECT updated_at_ms FROM automation_x_subscriptions WHERE id=?', [row.id]))[0].updated_at_ms), Number(updatedRow.updated_at_ms));
    const changedSecret = structuredClone(file); changedSecret.push.securityToken = '987655';
    await assert.rejects(service.importFile(A, await payload(service, A, changedSecret)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 1);
}));
test('browser metadata migration preserves older Firefox records and is repeatable', async t => setup(t, async db => {
    assert.match(db.schema, /^cbte_automation_test_[0-9a-f]{20}$/);
    const service = createXSetup(db, { sealer }), initial = await service.importFile(A, await payload(service, A));
    assert.equal(initial.subscription.browserKind, 'firefox');
    await db.queryDatabase('ALTER TABLE automation_x_subscriptions DROP COLUMN browser_kind');
    await applyTestMigration(db, '20261110_add_x_subscription_browser_kind.sql');
    await applyTestMigration(db, '20261110_add_x_subscription_browser_kind.sql');
    const status = await service.status(A);
    assert.equal(status.subscriptions.length, 1); assert.equal(status.subscriptions[0].browserKind, 'firefox');
    assert.equal(status.subscriptions[0].id, initial.subscription.id);
}));
test('Chrome refresh and version change roll back when its audit fails', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer, chromeEnabled: true, receiverEnabled: true });
    const file = chromeFixture(), saved = await service.importFile(A, await payload(service, A, file));
    const before = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]))[0];
    const changed = structuredClone(file); changed.provenance.browserVersion = '141.0.0.1';
    const next = await payload(service, A, changed);
    const failingDb = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (/INSERT INTO automation_audit/i.test(sql)) throw new Error('synthetic audit failure');
        return query(sql, params);
    })) };
    const failingService = createXSetup(failingDb, { sealer, chromeEnabled: true, receiverEnabled: true });
    await assert.rejects(failingService.importFile(A, next));
    const after = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]))[0];
    assert.equal(after.sealed_json, before.sealed_json); assert.equal(after.browser_version, before.browser_version);
    assert.equal(String(after.updated_at_ms), String(before.updated_at_ms));
    assert.equal((await db.queryDatabase('SELECT consumed_at_ms FROM automation_x_setup_sessions WHERE owner_user_id=?', [A.userId]))[0].consumed_at_ms, null);
}));

test('file intake requires explicit config, consent, ownership and bounded one-time sessions', async t => setup(t, async db => {
    let clock = 10000;
    const service = createXSetup(db, { sealer, now: () => clock });
    const disabled = createXSetup(db, { sealer: null });
    assert.equal((await disabled.status(A)).available, false);
    await assert.rejects(disabled.startSession(A, { consent: true }), code('X_SETUP_NOT_CONFIGURED'));
    assert.equal(sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '1', X_NOTIFICATION_INTAKE_KEY_ID: 'k', X_NOTIFICATION_INTAKE_PUBLIC_KEY: 'bad' }), null);
    assert.equal(sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '0' }), null);
    assert.equal(typeof sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '1', X_NOTIFICATION_INTAKE_KEY_ID: 'k', X_NOTIFICATION_INTAKE_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }).seal, 'function');
    assert.equal(sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '1', X_NOTIFICATION_INTAKE_KEY_ID: 'k', X_NOTIFICATION_INTAKE_PUBLIC_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }), null);
    await assert.rejects(service.startSession(A, { consent: false }), code('X_SETUP_CONSENT_REQUIRED'));
    await assert.rejects(service.startSession(A, { consent: true, ownerUserId: B.userId }), code('X_SETUP_INVALID_INPUT'));
    await assert.rejects(service.status({ userId: '' }), code('AUTH_REQUIRED'));
    const file = fixture(), body = await payload(service, A, file);
    const preview = { sessionId: body.sessionId, fileText: body.fileText };
    assert.equal((await service.validate(A, preview)).valid, true);
    assert.equal((await service.validate(A, preview)).valid, true, 'preview does not consume token');
    await assert.rejects(service.validate(B, preview), code('X_SETUP_SESSION_INVALID'));
    const rows = await db.queryDatabase('SELECT * FROM automation_x_setup_sessions');
    assert.equal(rows.length, 1); assert(!JSON.stringify(rows).includes(body.sessionId));
    clock += SESSION_TTL_MS;
    await assert.rejects(service.importFile(A, body), code('X_SETUP_SESSION_EXPIRED'));
    const next = await payload(service, A, file);
    await assert.rejects(service.importFile(A, body), code('X_SETUP_SESSION_INVALID'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_setup_sessions')).length, 1);
    await service.importFile(A, next);
    await assert.rejects(service.importFile(A, next), code('X_SETUP_SESSION_USED'));
}));

test('encrypted import survives service restart, never returns or audits secrets, and shares no quota', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer }), file = fixture();
    file.provenance.browserVersion = '1'.repeat(64);
    const body = await payload(service, A, file);
    const imported = await service.importFile(A, body);
    assert.equal(imported.duplicate, false); assert.equal(imported.subscription.state, 'stored');
    const restarted = createXSetup(db, { sealer: createTransferPublicSealer(vaultConfig) });
    const result = await restarted.status(A);
    assert.deepEqual(result.subscriptions, [imported.subscription]); assert.equal(result.receiverEnabled, false);
    assert.equal((await restarted.status(B)).subscriptions.length, 0);
    const row = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions'))[0];
    assert(!row.sealed_json.includes(file.push.uaid));
    const worker = createTransferPrivateWorkerVault({ activeKeyId: 'fixture1', privateKeys: { fixture1: privateKey } });
    assert.deepEqual(worker.open(JSON.parse(row.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), file);
    const exposed = JSON.stringify({ result, imported, rows: await db.queryDatabase('SELECT * FROM automation_audit'), sessions: await db.queryDatabase('SELECT * FROM automation_x_setup_sessions') });
    for (const secret of [file.push.uaid, file.push.channelID, file.push.pushEndpoint, file.push.authenticationSecret, file.push.p256dhPrivateKey.d, body.sessionId]) assert(!exposed.includes(secret));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_notification_slots')).length, 0);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_monitors')).length, 0);
    const duplicate = await restarted.importFile(A, await payload(restarted, A, file));
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.subscription.id, row.id);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 1);
    await assert.rejects(restarted.importFile(B, await payload(restarted, B, file)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
    const changed = structuredClone(file); changed.push.authenticationSecret = randomBytes(16).toString('base64url');
    await assert.rejects(restarted.importFile(A, await payload(restarted, A, changed)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
}));

test('concurrent same-session, same-owner and cross-owner imports cannot duplicate or steal registration', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer }), file = fixture();
    const body = await payload(service, A, file);
    const same = await Promise.allSettled([service.importFile(A, body), service.importFile(A, body)]);
    assert.equal(same.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(same.find(row => row.status === 'rejected').reason.code, 'X_SETUP_SESSION_USED');
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 1);
    const another = fixture();
    const bodies = await Promise.all([payload(service, A, another), payload(service, B, another)]);
    const crossed = await Promise.allSettled([service.importFile(A, bodies[0]), service.importFile(B, bodies[1])]);
    assert.equal(crossed.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(crossed.find(row => row.status === 'rejected').reason.code, 'X_SETUP_SUBSCRIPTION_CONFLICT');
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 2);
}));

test('scheduled Chrome reconnect is shown only for an active, current owner subscription', async t => setup(t, async db => {
    let clock = 1000000;
    const service = createXSetup(db, { sealer, chromeEnabled: true, receiverEnabled: true, rolloutMode: 'public', now: () => clock });
    const file = chromeFixture(), saved = (await service.importFile(A, await payload(service, A, file))).subscription;
    await db.queryDatabase("INSERT INTO automation_x_push_receivers (subscription_id,state,reason_code,subscription_revision,retry_at_ms,retry_attempt,updated_at_ms) VALUES (?,'error','X_PUSH_CHROME_LOGIN_FAILED',1,?,1,?)", [saved.id, clock + 5000, clock]);
    const get = async () => (await service.status(A)).subscriptions[0];
    assert.equal((await get()).receiverRetryPending, undefined, 'a missing active monitor is not retryable');
    const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
        [A.userId, JSON.stringify({ subscriptionId: saved.id }), clock, clock]);
    const pending = await get(); assert.equal(pending.receiverRetryPending, true);
    assert(!JSON.stringify(pending).includes('X_PUSH_CHROME_LOGIN_FAILED'));
    assert.equal((await service.status(B)).subscriptions.length, 0);
    await db.queryDatabase('UPDATE automation_x_monitors SET enabled=0 WHERE id=?', [monitor.insertId]);
    assert.equal((await get()).receiverRetryPending, undefined);
    await db.queryDatabase('UPDATE automation_x_monitors SET enabled=1 WHERE id=?', [monitor.insertId]);
    await db.queryDatabase('UPDATE automation_x_push_receivers SET subscription_revision=2 WHERE subscription_id=?', [saved.id]);
    assert.equal((await get()).receiverRetryPending, undefined);
    await db.queryDatabase('UPDATE automation_x_push_receivers SET subscription_revision=1 WHERE subscription_id=?', [saved.id]);
    clock += 5000; assert.equal((await get()).receiverRetryPending, undefined);
    const disabled = createXSetup(db, { sealer, chromeEnabled: true, receiverEnabled: false, rolloutMode: 'public', now: () => clock - 1 });
    assert.equal((await disabled.status(A)).subscriptions[0].receiverRetryPending, undefined);
}));

test('receipt status counts stay scoped to each owned subscription and expose no encrypted material', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    const first = (await service.importFile(A, await payload(service, A))).subscription;
    const second = (await service.importFile(A, await payload(service, A))).subscription;
    const foreign = (await service.importFile(B, await payload(service, B))).subscription;
    const empty = { received: 0, routed: 0, unsupported: 0, decryptionFailed: 0, unmatched: 0 };
    assert.deepEqual(first.receiptCounts, empty);
    const ciphertext = 'SYNTHETIC_PRIVATE_RECEIPT_CIPHERTEXT', header = 'SYNTHETIC_PRIVATE_RECEIPT_HEADER';
    async function record(subscription, state, receivedAtMs) {
        await db.queryDatabase(`INSERT INTO automation_x_push_inbox
            (subscription_id,subscription_revision,version,data_ciphertext,headers_json,ack_code,status,received_at_ms)
            VALUES (?,1,?,?,?,?,?,?)`, [subscription.id, randomUUID(), ciphertext, JSON.stringify({ encryption: header }),
            state === 'decryption_failed' ? 101 : 100, state, receivedAtMs]);
    }
    await record(first, 'received', 1000); await record(first, 'received', 2000);
    await record(first, 'routed', 3000); await record(first, 'unsupported', 4000); await record(first, 'decryption_failed', 5000);
    await record(first, 'unmatched', 5000); await record(first, 'unmatched', 5000);
    await record(second, 'routed', 6000);
    for (let index = 0; index < 7; index++) await record(foreign, 'unsupported', 7000 + index);
    for (let index = 0; index < 3; index++) await record(foreign, 'unmatched', 7100 + index);
    const before = await db.queryDatabase('SELECT id,status,received_at_ms,routed_at_ms FROM automation_x_push_inbox ORDER BY id');
    const own = await service.status(A), other = await service.status(B);
    assert.equal(own.subscriptions.length, 2);
    const one = own.subscriptions.find(item => item.id === first.id), two = own.subscriptions.find(item => item.id === second.id);
    assert.deepEqual(one.receiptCounts, { received: 2, routed: 1, unsupported: 1, decryptionFailed: 1, unmatched: 2 });
    assert.deepEqual(two.receiptCounts, { ...empty, routed: 1 });
    assert.equal(one.lastReceivedAtMs, 5000); assert.equal(two.lastReceivedAtMs, 6000);
    assert.deepEqual(other.subscriptions.map(item => item.id), [foreign.id]);
    assert.deepEqual(other.subscriptions[0].receiptCounts, { ...empty, unsupported: 7, unmatched: 3 });
    assert.equal(own.subscriptions.some(item => item.id === foreign.id), false);
    for (const secret of [ciphertext, header, foreign.id, B.userId]) assert(!JSON.stringify(own).includes(secret));
    assert.deepEqual(await db.queryDatabase('SELECT id,status,received_at_ms,routed_at_ms FROM automation_x_push_inbox ORDER BY id'), before,
        'status reads do not alter receipt state or delivery admission');
    await db.queryDatabase("UPDATE automation_x_push_inbox SET status='routed',routed_at_ms=8000 WHERE subscription_id=? AND status='received'", [first.id]);
    const updated = (await service.status(A)).subscriptions.find(item => item.id === first.id);
    assert.deepEqual(updated.receiptCounts, { received: 0, routed: 3, unsupported: 1, decryptionFailed: 1, unmatched: 2 });
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
}));

test('receipt status query failure propagates instead of reporting misleading zero counts', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    await service.importFile(A, await payload(service, A));
    const broken = createXSetup({ ...db, queryDatabase: async (sql, params) => {
        if (sql.includes('AS unsupported_count')) throw Object.assign(new Error('fixture receipt query failure'), { code: 'ER_FIXTURE_READ' });
        return db.queryDatabase(sql, params);
    } }, { sealer });
    await assert.rejects(broken.status(A), { code: 'ER_FIXTURE_READ' });
    assert.deepEqual((await service.status(A)).subscriptions[0].receiptCounts, { received: 0, routed: 0, unsupported: 0, decryptionFailed: 0, unmatched: 0 });
}));

test('DB/audit failure rolls back encrypted material, token consumption and deletion atomically', async t => setup(t, async db => {
    let broken = true;
    const faulty = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (broken && sql.startsWith('INSERT INTO automation_audit')) throw new Error('fixture DB failure');
        return query(sql, params);
    })) };
    const service = createXSetup(faulty, { sealer }), body = await payload(service, A);
    await assert.rejects(service.importFile(A, body), /fixture DB failure/);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_setup_sessions'))[0].consumed_at_ms, null);
    broken = false;
    const imported = await service.importFile(A, body), item = imported.subscription;
    const stalePreview = await payload(service, A, fixture());
    broken = true;
    await assert.rejects(service.remove(A, item.id, { expectedRevision: item.revision }), /fixture DB failure/);
    assert.equal((await service.status(A)).subscriptions.length, 1);
    broken = false;
    const disabled = createXSetup(db, { sealer: null });
    await assert.rejects(disabled.remove(B, item.id, { expectedRevision: item.revision }), code('NOT_FOUND'));
    await assert.rejects(disabled.remove(A, item.id, { expectedRevision: item.revision + 1 }), code('REVISION_CONFLICT'));
    assert.deepEqual(await disabled.remove(A, item.id, { expectedRevision: item.revision }), { deleted: true });
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    await assert.rejects(service.importFile(A, stalePreview), code('X_SETUP_SESSION_INVALID'));
    await assert.rejects(disabled.remove(A, item.id, { expectedRevision: item.revision }), code('NOT_FOUND'));
}));

test('dispatcher keeps setup private, server-owned and rate-limited with safe invalid input recovery', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    let operations = 0;
    const services = { db, xSetup: service, service: { withOperation: async (actor, group, work) => { operations++; return work(); } } };
    const request = (method, route, body) => ({ method, path: route.split('/'), body });
    await assert.rejects(dispatch(request('GET', 'x-setup'), { ...A, guildId: '111111111111111111' }, services), code('X_SETUP_PRIVATE_ONLY'));
    const { sessionId } = await dispatch(request('POST', 'x-setup/sessions', { consent: true }), A, services);
    await assert.rejects(dispatch(request('POST', 'x-setup/validate', { sessionId, fileText: '{"cookies":[]}' }), A, services), code('X_SETUP_INVALID_FILE'));
    const valid = await dispatch(request('POST', 'x-setup/validate', { sessionId, fileText: JSON.stringify(fixture()) }), A, services);
    assert.equal(valid.valid, true); assert.equal(operations, 3);
    await assert.rejects(dispatch(request('POST', 'x-setup/sessions', { consent: true }), A, { db, xSetup: service }), code('AUTOMATION_RATE_LIMIT_UNAVAILABLE'));
}));

test('owner list cursor is bounded and never exposes vault fields', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    // Metadata-only fixtures deliberately do not claim encrypted imports. They
    // exercise pagination without weakening the production importer or limits.
    for (let index = 1; index <= 101; index++) {
        const suffix = index.toString(16).padStart(12, '0'), fingerprint = index.toString(16).padStart(64, '0');
        await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,0,0)',
            [`00000000-0000-0000-0000-${suffix}`, A.userId, fingerprint, fingerprint, fingerprint, 'opaque fixture', 'fixture1', '160.0a1']);
    }
    const first = await service.status(A);
    assert.equal(first.subscriptions.length, 100); assert.equal(typeof first.nextCursor, 'string');
    const second = await service.status(A, { afterId: first.nextCursor });
    assert.equal(second.subscriptions.length, 1); assert.equal(second.nextCursor, null);
    assert(!JSON.stringify(first).includes('opaque fixture'));
    await assert.rejects(service.status(A, { afterId: 'other query' }), code('INVALID_CURSOR'));
}));

test('intake status shares the default batch policy and never enables the receiver flag implicitly', async t => setup(t, async db => {
    const keys = ['X_NOTIFICATION_RECEIVER_ENABLED', 'X_NOTIFICATION_PROCESSING_POLICY'];
    const previous = keys.map(key => process.env[key]);
    try {
        delete process.env.X_NOTIFICATION_PROCESSING_POLICY;
        delete process.env.X_NOTIFICATION_RECEIVER_ENABLED;
        assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, false);
        process.env.X_NOTIFICATION_RECEIVER_ENABLED = '1';
        assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, true, 'an explicit receiver flag uses the approved batch default');
        for (const mode of ['realtime', 'per-event', 'unknown']) {
            process.env.X_NOTIFICATION_PROCESSING_POLICY = mode;
            assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, false);
        }
        process.env.X_NOTIFICATION_PROCESSING_POLICY = 'batch';
        process.env.X_NOTIFICATION_RECEIVER_ENABLED = '0';
        assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, false);
    } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
}));

test('additive SQL migration is repeatable and disabling intake preserves existing subscriptions and ordinary data', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    const imported = await service.importFile(A, await payload(service, A));
    const before = await db.queryDatabase('SELECT user_id,additional_auto_extract_slots,is_donor FROM users');
    const migration = readFileSync(path.resolve(__dirname, '../../migrations/20261014_add_x_notification_intake.sql'), 'utf8');
    const statements = migration.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    // Git may check JS templates and SQL files out with different line endings.
    // Preserve the exact SQL text check while treating CRLF and LF alike.
    const canonicalSql = value => value.replace(/\r\n/g, '\n').trim();
    // This historical migration predates browser_kind. The later additive
    // migration is tested separately and must not rewrite migration history.
    const expected = require('../../src/automation/x-setup-schema.sql').SCHEMA
        .map(sql => sql.replace(/^\s*browser_kind VARCHAR\(16\).*\n/m, ''))
        .map(canonicalSql);
    assert.deepEqual(statements.map(canonicalSql), expected);
    for (const ending of ['\n', '\r\n']) {
        const variant = migration.replace(/\r\n/g, '\n').replace(/\n/g, ending);
        const parsed = variant.replace(/^--.*$/gm, '').split(';').map(canonicalSql).filter(Boolean);
        assert.deepEqual(parsed, expected, `migration SQL stays identical with ${JSON.stringify(ending)} lines`);
    }
    for (let repeat = 0; repeat < 2; repeat++) for (const statement of statements) await db.queryDatabase(statement);
    assert.deepEqual(await db.queryDatabase('SELECT user_id,additional_auto_extract_slots,is_donor FROM users'), before);
    const rolledBack = createXSetup(db, { sealer: null });
    assert.deepEqual((await rolledBack.status(A)).subscriptions, [imported.subscription]);
    assert.equal((await rolledBack.status(A)).available, false);
    await rolledBack.remove(A, imported.subscription.id, { expectedRevision: 1 });
    assert.equal((await rolledBack.status(A)).subscriptions.length, 0);
}));
