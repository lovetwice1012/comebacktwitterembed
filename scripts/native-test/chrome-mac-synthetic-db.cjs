'use strict';

// Runs only against the explicit disposable localhost test server. No real
// user, subscription, profile, or production database is used.
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');

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
            await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
                { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
            const now = Date.now();
            const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
                [owner.userId, JSON.stringify({ subscriptionId: saved.subscription.id }), now, now]);
            await db.withDatabaseTransaction(query => entitlements.assignSlot(query, owner.userId, 'x', String(monitor.insertId)));
            const store = createXPushStore(db, { leaseMs: 300000 });
            const lease = await store.claim({ subscriptionId: saved.subscription.id, ownerUserId: owner.userId, workerId: 'mac-synthetic-fixture' });
            assert.ok(lease, 'fixture lease unavailable');
            await work({ db, store, lease });
            const inbox = await db.queryDatabase('SELECT status,data_ciphertext FROM automation_x_push_inbox WHERE subscription_id=?', [saved.subscription.id]);
            assert.ok(inbox.length >= 1, 'encrypted receipt missing');
            assert.ok(inbox.every(row => row.status === 'received' && typeof row.data_ciphertext === 'string' && row.data_ciphertext.length > 0), 'invalid encrypted receipt');
            if (process.env.CBTE_MAC_REAL_ROUTE_FIXTURE === '1') {
                const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, chromeMacEnabled: true,
                    privateWorkerVault: vault, rolloutMode: 'public', leaseMs: 300000 });
                const queue = createQueue(db, {}, { rolloutMode: 'public' });
                const runtime = createXPushRuntime(db, queue, { enabled: true, gateway, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed: () => {} });
                try {
                    // Model the configured five-minute window only inside this
                    // disposable schema; no production timing is changed.
                    await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [Date.now() - 301000, saved.subscription.id]);
                    await runtime.drain(lease);
                    const jobs = await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs');
                    const routed = await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_push_inbox WHERE subscription_id=? AND status='routed'", [saved.subscription.id]);
                    assert.equal(Number(jobs[0].n), 1); assert.equal(Number(routed[0].n), 1);
                } finally { await runtime.stop(); }
            }
        }
    } finally { await db.close(); }
}
module.exports = { verifySyntheticMacDatabaseTransfer };
