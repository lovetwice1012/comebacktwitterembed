'use strict';
// Upgrade and feature-disable exercise against a disposable SQL database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema');
const chromiumMigration = require('../migrate-chromium-schema.cjs');
const { fixture, insertSubscription, encrypted, vault: legacyVault } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');

function chromiumFile(kind, deviceId) {
    const firefox = fixture(), key = firefox.push.p256dhPrivateKey;
    return { format: firefox.format, version: 2,
        provenance: { kind: `${kind}-gcm`, adapterVersion: '1.0.0', browserVersion: kind === 'brave' ? '157.1.99.55' : '157.0.8103.39',
            ...(kind === 'brave' ? { engineVersion: '157.0.8103.39' } : {}), readMethod: `${kind}-gcm-snapshot` },
        push: { deviceId, securityToken: '987654', appId: `wp:https://x.com/#${randomUUID().toUpperCase().slice(0, -3)}-V2`,
            productCategory: kind === 'brave' ? 'com.brave.windows' : 'com.chrome.windows', authorizedEntity: 'synthetic_sender', scope: 'https://x.com/',
            p256dhPublicKey: firefox.push.p256dhPublicKey, authenticationSecret: firefox.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
}
async function save(setup, actor, file) {
    const session = await setup.startSession(actor, { consent: true });
    return setup.importFile(actor, { sessionId: session.sessionId, fileText: JSON.stringify(file), consent: true });
}

test('complete Chromium upgrade and feature-disable retain Firefox receipts and all encrypted registrations', { timeout: 45000 }, async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        assert.match(db.schema, /^cbte_automation_test_[0-9a-f]{20}$/);
        await db.queryDatabase('DROP TABLE automation_x_mcs_pending');
        await db.queryDatabase(schema.SCHEMA_STATEMENTS.find(sql => /^CREATE TABLE IF NOT EXISTS schema_migrations\s*\(/.test(sql)));
        await db.queryDatabase('ALTER TABLE automation_x_subscriptions DROP COLUMN browser_kind');
        // An underscore is a wildcard in SQL LIKE; this unrelated name must
        // never cause the real migration to be skipped.
        await db.queryDatabase('ALTER TABLE automation_x_subscriptions ADD COLUMN browserXkind VARCHAR(16) NULL');
        await db.queryDatabase('ALTER TABLE automation_x_push_receivers DROP COLUMN chrome_checkin_at_ms, DROP COLUMN chrome_checkin_interval_seconds, DROP COLUMN chrome_checkin_revision');
        await db.queryDatabase('ALTER TABLE automation_x_push_receivers DROP COLUMN wns_token_sealed_json, DROP COLUMN wns_token_revision, DROP COLUMN wns_token_generation');
        const legacy = await insertSubscription(db), store = createXPushStore(db), oldLease = await store.claim({ ...legacy, workerId: 'old-firefox' });
        const event = { notificationType: 'tweet', text: 'synthetic-retained' }, wire = await encrypted(legacy.file, event);
        const oldInbox = await store.recordFrame(oldLease, { version: 'legacy-1', data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 });
        await store.release(oldLease);
        const before = (await db.queryDatabase('SELECT sealed_json,revision FROM automation_x_subscriptions WHERE id=?', [legacy.subscriptionId]))[0];
        assert.equal((await chromiumMigration.run(db.queryDatabase, schema._internal.applyMigrationFile)).state, 'checked');
        assert.equal((await chromiumMigration.run(db.queryDatabase, schema._internal.applyMigrationFile, { apply: true })).state, 'applied');
        const after = (await db.queryDatabase('SELECT browser_kind,sealed_json,revision FROM automation_x_subscriptions WHERE id=?', [legacy.subscriptionId]))[0];
        assert.equal(after.browser_kind, 'firefox'); assert.equal(after.sealed_json, before.sealed_json); assert.equal(Number(after.revision), Number(before.revision));
        const lease = await store.claim({ ...legacy, workerId: 'new-firefox' });
        const gateway = createXPushGateway(db, { enabled: true, privateWorkerVault: legacyVault, rolloutMode: 'public' });
        assert.deepEqual(await gateway.decryptInbox(lease, await store.getInbox({ ...lease, id: oldInbox.id })), event);
        await store.release(lease);
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const sealer = createTransferPublicSealer({ activeKeyId: 'new-fixture', publicKeys: { 'new-fixture': keys.publicKey } });
        const newVault = createTransferPrivateWorkerVault({ activeKeyId: 'new-fixture', privateKeys: { 'new-fixture': keys.privateKey } });
        const enabled = createXSetup(db, { sealer, chromeEnabled: true, braveEnabled: true, receiverEnabled: true, rolloutMode: 'public' });
        const chromeOwner = { userId: '333333333333333333' }, braveOwner = { userId: '444444444444444444' };
        const chrome = chromiumFile('chrome', '123456'), brave = chromiumFile('brave', '123457');
        const chromeSaved = await save(enabled, chromeOwner, chrome), braveSaved = await save(enabled, braveOwner, brave);
        const chromeLease = await store.claim({ subscriptionId: chromeSaved.subscription.id, ownerUserId: chromeOwner.userId, workerId: 'chrome' });
        await store.recordMcsControl(chromeLease, { kind: 'deleted_messages', persistentId: 'control-1' });
        await store.release(chromeLease);
        assert.equal((await chromiumMigration.run(db.queryDatabase, schema._internal.applyMigrationFile, { apply: true })).state, 'applied');
        const pending = await db.queryDatabase('SELECT inbox_id,persistent_id FROM automation_x_mcs_pending WHERE subscription_id=?', [chromeSaved.subscription.id]);
        assert.equal(pending.length, 1); assert.equal(pending[0].inbox_id, null); assert.equal(pending[0].persistent_id, 'control-1');
        const chromeOnly = createXSetup(db, { sealer, chromeEnabled: true, braveEnabled: false, receiverEnabled: true, rolloutMode: 'public' });
        const chromeSession = await chromeOnly.startSession(chromeOwner, { consent: true });
        assert.equal((await chromeOnly.validate(chromeOwner, { sessionId: chromeSession.sessionId, fileText: JSON.stringify(chrome) })).valid, true);
        const braveSession = await chromeOnly.startSession(braveOwner, { consent: true });
        await assert.rejects(chromeOnly.validate(braveOwner, { sessionId: braveSession.sessionId, fileText: JSON.stringify(brave) }), { code: 'X_SETUP_BRAVE_NOT_READY' });
        const disabled = createXSetup(db, { sealer, chromeEnabled: false, braveEnabled: false, receiverEnabled: true, rolloutMode: 'public' });
        for (const [actor, file, saved, kind] of [[chromeOwner, chrome, chromeSaved, 'chrome'], [braveOwner, brave, braveSaved, 'brave']]) {
            const status = await disabled.status(actor); assert(status.subscriptions.some(row => row.id === saved.subscription.id && row.browserKind === kind));
            const session = await disabled.startSession(actor, { consent: true });
            await assert.rejects(disabled.validate(actor, { sessionId: session.sessionId, fileText: JSON.stringify(file) }), { code: 'X_SETUP_CHROME_NOT_READY' });
            const stored = (await db.queryDatabase('SELECT sealed_json,revision FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]))[0];
            assert.deepEqual(newVault.open(JSON.parse(stored.sealed_json), { subscriptionId: saved.subscription.id, ownerUserId: actor.userId, revision: Number(stored.revision) }), file);
        }
        const restoredLegacy = await store.claim({ ...legacy, workerId: 'post-disable-firefox' });
        assert.deepEqual(await gateway.decryptInbox(restoredLegacy, await store.getInbox({ ...restoredLegacy, id: oldInbox.id })), event);
        await store.release(restoredLegacy);
        assert.equal((await db.queryDatabase('SELECT id FROM automation_x_push_inbox WHERE id=?', [oldInbox.id])).length, 1);
    } finally { await db.close(); }
});
test('preflight rejects incompatible existing columns before writing migrations', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        await db.queryDatabase(schema.SCHEMA_STATEMENTS.find(sql => /^CREATE TABLE IF NOT EXISTS schema_migrations\s*\(/.test(sql)));
        await db.queryDatabase('DROP TABLE automation_x_mcs_pending');
        await db.queryDatabase('ALTER TABLE automation_x_subscriptions MODIFY COLUMN browser_kind INT NULL');
        await assert.rejects(chromiumMigration.run(db.queryDatabase, schema._internal.applyMigrationFile, { apply: true }), { code: 'CHROMIUM_MIGRATION_SCHEMA_INVALID' });
        await db.queryDatabase("ALTER TABLE automation_x_subscriptions MODIFY COLUMN browser_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'firefox'");
        await db.queryDatabase('ALTER TABLE automation_x_push_receivers MODIFY COLUMN chrome_checkin_at_ms BIGINT NULL DEFAULT 1');
        await assert.rejects(chromiumMigration.run(db.queryDatabase, schema._internal.applyMigrationFile, { apply: true }), { code: 'CHROMIUM_MIGRATION_SCHEMA_INVALID' });
        const rows = await db.queryDatabase('SELECT migration_id FROM schema_migrations');
        assert.equal(rows.length, 0);
        const tables = await db.queryDatabase("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='automation_x_mcs_pending'");
        assert.equal(tables.length, 0);
    } finally { await db.close(); }
});
test('interrupted DDL can be reviewed and resumed without losing the Firefox receipt', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        await db.queryDatabase(schema.SCHEMA_STATEMENTS.find(sql => /^CREATE TABLE IF NOT EXISTS schema_migrations\s*\(/.test(sql)));
        await db.queryDatabase('DROP TABLE automation_x_mcs_pending');
        await db.queryDatabase('ALTER TABLE automation_x_subscriptions DROP COLUMN browser_kind');
        await db.queryDatabase('ALTER TABLE automation_x_push_receivers DROP COLUMN chrome_checkin_at_ms, DROP COLUMN chrome_checkin_interval_seconds, DROP COLUMN chrome_checkin_revision');
        await db.queryDatabase('ALTER TABLE automation_x_push_receivers DROP COLUMN wns_token_sealed_json, DROP COLUMN wns_token_revision, DROP COLUMN wns_token_generation');
        const sub = await insertSubscription(db), store = createXPushStore(db), lease = await store.claim({ ...sub, workerId: 'ddl-resume' });
        const receipt = await store.recordFrame(lease, { version: 'preserved', data: 'AA', headers: {}, status: 'received', ackCode: 100 });
        let applied = 0;
        await assert.rejects(chromiumMigration.run(db.queryDatabase, async (query, file) => {
            if (applied++ === 2) throw new Error('synthetic interruption');
            return schema._internal.applyMigrationFile(query, file);
        }, { apply: true }), /synthetic interruption/);
        assert.equal((await db.queryDatabase('SELECT migration_id FROM schema_migrations')).length, 2);
        assert.equal((await chromiumMigration.run(db.queryDatabase, schema._internal.applyMigrationFile)).state, 'checked');
        assert.equal((await chromiumMigration.run(db.queryDatabase, schema._internal.applyMigrationFile, { apply: true })).state, 'applied');
        assert.equal((await store.getInbox({ ...sub, id: receipt.id })).version, 'preserved');
    } finally { await db.close(); }
});
