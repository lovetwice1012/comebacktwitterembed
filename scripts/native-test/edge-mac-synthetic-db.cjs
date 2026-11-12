'use strict';

// Disposable hosted DB and synthetic subscription only. No real X account or
// Discord destination is used; credentials and payloads never enter logs.
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const webpush = require('web-push');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault, createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');

async function verifySyntheticMacEdgeDatabase(file, subscription, vapid) {
    if (process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_DB_FIXTURE !== '1'
        || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || process.env.AUTOMATION_TEST_DB_PORT !== '33621') throw new Error('FIXTURE_DB_NOT_ENABLED');
    const db = await createTestDatabase(33621), controller = new AbortController(); let runtime, timer;
    try {
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 }), config = { activeKeyId: 'fixture', privateKeys: { fixture: keys.privateKey } };
        const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: keys.publicKey } });
        const vault = createTransferPrivateWorkerVault(config), tokenVault = createWnsTokenWorkerVault(config);
        const setup = createXSetup(db, { sealer, edgeEnabled: true, edgeConnectV2Enabled: true, receiverEnabled: true, rolloutMode: 'public' });
        const owner = { userId: '222222222222222222' }, registration = await setup.startSession(owner, { consent: true });
        const saved = await setup.importFile(owner, { sessionId: registration.sessionId, fileText: JSON.stringify(file), consent: true });
        const rows = await db.queryDatabase('SELECT id,owner_user_id,revision,sealed_json FROM automation_x_subscriptions WHERE id=?', [saved.subscription.id]);
        assert.equal(rows.length, 1); assert.equal(rows[0].owner_user_id, owner.userId);
        assert(!String(rows[0].sealed_json).includes(file.push.reconnectToken), 'token must not be stored in plaintext');
        const opened = vault.open(JSON.parse(rows[0].sealed_json), { subscriptionId: rows[0].id, ownerUserId: owner.userId, revision: Number(rows[0].revision) });
        assert.equal(opened.push.connectVersion || '1', file.push.connectVersion || '1');
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        const now = Date.now();
        const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
            [owner.userId, JSON.stringify({ subscriptionId: saved.subscription.id }), now, now]);
        await db.withDatabaseTransaction(query => entitlements.assignSlot(query, owner.userId, 'x', String(monitor.insertId)));
        const gateway = createXPushGateway(db, { enabled: true, edgeEnabled: true, edgeConnectV2Enabled: true, edgeTokenVault: tokenVault,
            privateWorkerVault: vault, rolloutMode: 'public', leaseMs: 300000, requestTimeoutMs: 15000 });
        const queue = createQueue(db, {}, { rolloutMode: 'public' });
        runtime = createXPushRuntime(db, queue, { enabled: true, gateway, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed() {} });
        let sent = false, received = false, callbackFailed = false;
        webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
        timer = setTimeout(() => controller.abort(), 60000);
        await gateway.run({ subscriptionId: saved.subscription.id, ownerUserId: owner.userId, workerId: 'mac-edge-synthetic', signal: controller.signal,
            onSession: async () => {
                try {
                    await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [Date.now() - 301000, saved.subscription.id]);
                    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify({ notificationType: 'tweet', text: 'mac-edge-synthetic',
                        url: 'https://x.com/synthetic/status/1234567890123456789', author: { handle: 'synthetic', id: '12345' } }), { TTL: 60, timeout: 15000 });
                    sent = true;
                } catch { callbackFailed = true; controller.abort(); }
            },
            onReceived: async ({ lease, payload }) => {
                try { assert.equal(payload.text, 'mac-edge-synthetic'); await runtime.drain(lease); received = true; }
                catch { callbackFailed = true; } finally { controller.abort(); }
            } });
        assert(sent && received && !callbackFailed, 'synthetic gateway did not complete');
        const inbox = await db.queryDatabase('SELECT status,data_ciphertext FROM automation_x_push_inbox WHERE subscription_id=?', [saved.subscription.id]);
        assert.equal(inbox.length, 1); assert.equal(inbox[0].status, 'routed');
        assert(!String(inbox[0].data_ciphertext).includes('mac-edge-synthetic'));
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
        assert(Number((await db.queryDatabase('SELECT wns_token_generation FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]))[0].wns_token_generation) >= 1);
    } finally { clearTimeout(timer); controller.abort(); if (runtime) await runtime.stop(); await db.close(); }
}
module.exports = { verifySyntheticMacEdgeDatabase };
