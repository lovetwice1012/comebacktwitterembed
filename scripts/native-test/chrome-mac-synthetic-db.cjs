'use strict';

// Runs only against the explicit disposable localhost test server. No real
// user, subscription, profile, or production database is used.
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushStore } = require('../../src/automation/x-push-store');

async function verifySyntheticMacDatabaseTransfer(file, work) {
    if (process.env.CBTE_MAC_DB_FIXTURE !== '1' || process.env.AUTOMATION_TEST_DB_PORT !== '33621') throw new Error('FIXTURE_DB_NOT_ENABLED');
    const db = await createTestDatabase(33621);
    try {
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: keys.publicKey } });
        const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture', privateKeys: { fixture: keys.privateKey } });
        const setup = createXSetup(db, { sealer, chromeEnabled: true, chromeMacEnabled: true, receiverEnabled: true, rolloutMode: 'public' });
        const owner = { userId: '222222222222222222' }, other = { userId: '333333333333333333' };
        const session = await setup.startSession(owner, { consent: true });
        const text = JSON.stringify(file);
        const preview = await setup.validate(owner, { sessionId: session.sessionId, fileText: text });
        assert.equal(preview.valid, true);
        const saved = await setup.importFile(owner, { sessionId: session.sessionId, fileText: text, consent: true });
        const rows = await db.queryDatabase('SELECT id,owner_user_id,revision,sealed_json FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]);
        assert.equal(rows.length, 1); assert.equal(rows[0].owner_user_id, owner.userId);
        assert.ok(!String(rows[0].sealed_json).includes(file.push.securityToken), 'plaintext token found in storage');
        const context = { subscriptionId: rows[0].id, ownerUserId: owner.userId, revision: Number(rows[0].revision) };
        const opened = vault.open(JSON.parse(rows[0].sealed_json), context);
        assert.ok(JSON.stringify(opened) === text, 'worker vault did not recover imported transfer');
        assert.throws(() => vault.open(JSON.parse(rows[0].sealed_json), { ...context, ownerUserId: other.userId }), { code: 'X_SETUP_DECRYPT_FAILED' });
        const foreignSession = await setup.startSession(other, { consent: true });
        await assert.rejects(setup.importFile(other, { sessionId: foreignSession.sessionId, fileText: text, consent: true }), { code: 'X_SETUP_SUBSCRIPTION_CONFLICT' });
        if (typeof work === 'function') {
            for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
            const store = createXPushStore(db, { leaseMs: 300000 });
            const lease = await store.claim({ subscriptionId: saved.subscription.id, ownerUserId: owner.userId, workerId: 'mac-synthetic-fixture' });
            assert.ok(lease, 'fixture lease unavailable');
            await work({ db, store, lease });
            const inbox = await db.queryDatabase('SELECT status,data_ciphertext FROM automation_x_push_inbox WHERE subscription_id=?', [saved.subscription.id]);
            assert.ok(inbox.length >= 1, 'encrypted receipt missing');
            assert.ok(inbox.every(row => row.status === 'received' && typeof row.data_ciphertext === 'string' && row.data_ciphertext.length > 0), 'invalid encrypted receipt');
        }
    } finally { await db.close(); }
}
module.exports = { verifySyntheticMacDatabaseTransfer };
