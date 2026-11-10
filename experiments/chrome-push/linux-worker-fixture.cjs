'use strict';
// Local-only integration probe: a synthetic profile enters an isolated MariaDB
// via stdin, is encrypted and received by the real Linux worker, then deleted.
const { generateKeyPairSync } = require('node:crypto');
const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const { checkin } = require('../../src/automation/chrome-checkin');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 32768) throw new Error('FIXTURE_INPUT_INVALID'); chunks.push(chunk); }
    const file = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const db = await createTestDatabase(33621); let runtime;
    try {
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: keys.publicKey } });
        const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture', privateKeys: { fixture: keys.privateKey } });
        const actor = { userId: '222222222222222222' }, admin = { userId: '666666666666666666', isAdmin: true };
        const setup = createXSetup(db, { sealer, chromeEnabled: true, receiverEnabled: true, rolloutMode: 'public' });
        const session = await setup.startSession(actor, { consent: true });
        const saved = await setup.importFile(actor, { sessionId: session.sessionId, fileText: JSON.stringify(file), consent: true });
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin,
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        const now = Date.now();
        const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
            [actor.userId, JSON.stringify({ subscriptionId: saved.subscription.id }), now, now]);
        await db.withDatabaseTransaction(query => entitlements.assignSlot(query, actor.userId, 'x', String(monitor.insertId)));
        await checkin({ deviceId: file.push.deviceId, securityToken: file.push.securityToken, browserVersion: file.provenance.browserVersion });
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault,
            rolloutMode: 'public', requestTimeoutMs: 15000, leaseMs: 300000 });
        const queue = createQueue(db, {}, { rolloutMode: 'public' });
        runtime = createXPushRuntime(db, queue, { enabled: true, gateway, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed: () => {} });
        let ready = false;
        for (let i = 0; i < 120 && !ready; i++) {
            await runtime.tick();
            const rows = await db.queryDatabase('SELECT state FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]);
            ready = rows[0]?.state === 'listening'; if (!ready) await pause(250);
        }
        if (!ready) throw new Error('FIXTURE_LOGIN_FAILED');
        process.stdout.write('{"ready":true,"checkin":true}\n');
        let jobs = 0, advanced = false;
        for (let i = 0; i < 120 && !jobs; i++) {
            if (!advanced) {
                const received = await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_push_inbox WHERE status='received'");
                if (Number(received[0].n)) {
                    // The disposable fixture models the configured five-minute
                    // batch window without changing production timing policy.
                    await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?',
                        [Date.now() - 301000, saved.subscription.id]);
                    advanced = true;
                }
            }
            await runtime.tick();
            const rows = await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs');
            jobs = Number(rows[0].n); if (!jobs) await pause(250);
        }
        const inbox = await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_push_inbox WHERE status='routed'");
        if (jobs !== 1 || Number(inbox[0].n) !== 1) throw new Error('FIXTURE_RECEIPT_TIMEOUT');
        process.stdout.write('{"encryptedReceipt":true,"queuedJobs":1}\n');
    } finally { await runtime?.stop(); await db.close(); }
}
main().catch(error => {
    const code = /^FIXTURE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'FIXTURE_LINUX_WORKER_FAILED';
    process.stderr.write(code + '\n'); process.exitCode = 1;
});
