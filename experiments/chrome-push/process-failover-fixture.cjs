'use strict';
// Synthetic FCM subscription; disposable loopback MariaDB and child workers.
// No real X account, user profile or Discord endpoint is used.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const path = require('node:path');
const webpush = require('web-push');
const { createSyntheticSubscription } = require('./synthetic-subscription-ipc.cjs');
const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer } = require('../../src/automation/x-setup-transfer');
const { createXPushStore } = require('../../src/automation/x-push-store');
const entitlements = require('../../src/automation/entitlements');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startWorker(input) {
    const child = fork(path.join(__dirname, 'failover-worker-fixture.cjs'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const events = []; let exited = false;
    child.on('message', message => events.push(message));
    child.on('exit', () => { exited = true; });
    child.send(input);
    return {
        child,
        async wait(event, label, timeout = 30000) {
            const end = Date.now() + timeout;
            while (Date.now() < end) {
                const failure = events.find(item => item.event === 'failure'); if (failure) throw new Error('FIXTURE_CHILD_FAILURE');
                const match = events.find(item => item.event === event && (label === undefined || item.label === label || item.state === label));
                if (match) return match;
                if (exited) throw new Error('FIXTURE_CHILD_EXITED');
                await delay(50);
            }
            throw new Error('FIXTURE_CHILD_TIMEOUT');
        },
        async waitExit() { for (let i = 0; i < 200 && !exited; i++) await delay(50); if (!exited) throw new Error('FIXTURE_CHILD_STOP_TIMEOUT'); },
    };
}

async function main() {
    assert.equal(Number(process.env.AUTOMATION_TEST_DB_PORT), 33631, 'Use isolated fixture DB port 33631');
    const browser = process.env.CHROMIUM_PROBE_BROWSER === 'brave' ? 'brave' : 'chrome';
    const fixture = await createSyntheticSubscription(browser), db = await createTestDatabase(33631); const workers = [];
    try {
        const supervisor = process.env.CBTE_FIXTURE_SUPERVISOR === '1';
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: keys.publicKey } });
        const setup = createXSetup(db, { sealer, chromeEnabled: true, braveEnabled: browser === 'brave', receiverEnabled: true, rolloutMode: 'public' });
        const actor = { userId: '222222222222222222' }, session = await setup.startSession(actor, { consent: true });
        const saved = await setup.importFile(actor, { sessionId: session.sessionId, fileText: JSON.stringify(fixture.transfer), consent: true });
        if (supervisor) {
            await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
                { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
            const now = Date.now(), monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
                [actor.userId, JSON.stringify({ subscriptionId: saved.subscription.id }), now, now]);
            await db.withDatabaseTransaction(query => entitlements.assignSlot(query, actor.userId, 'x', String(monitor.insertId)));
        }
        const input = { schema: db.schema, subscriptionId: saved.subscription.id, ownerUserId: actor.userId,
            privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), supervisor };
        const first = startWorker({ ...input, worker: 'first' }); workers.push(first); await first.wait('ready');
        const row = (await db.queryDatabase('SELECT lease_token,subscription_revision FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]))[0];
        const stale = { subscriptionId: saved.subscription.id, ownerUserId: actor.userId, revision: Number(row.subscription_revision), token: row.lease_token };
        const contender = startWorker({ ...input, worker: 'contender' }); workers.push(contender);
        if (supervisor) await contender.wait('busy');
        else { await contender.wait('done', 'busy'); await contender.waitExit(); }
        const send = text => webpush.sendNotification(fixture.subscription, JSON.stringify({ notificationType: 'tweet', text,
            url: text === 'synthetic-before-crash' ? 'https://x.com/synthetic/status/1234567890123456789' : 'https://x.com/synthetic/status/1234567890123456790',
            author: { handle: 'synthetic', id: '12345' } }),
        { TTL: 120, vapidDetails: { subject: 'mailto:test@example.com', publicKey: fixture.vapid.publicKey, privateKey: fixture.vapid.privateKey } });
        await send('synthetic-before-crash'); await first.wait('received', 'before');
        first.child.kill(); await first.waitExit();
        const expiry = Number((await db.queryDatabase('SELECT lease_expires_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]))[0].lease_expires_at_ms);
        if (Date.now() >= expiry) throw new Error('FIXTURE_OFFLINE_WINDOW_MISSED');
        await send('synthetic-during-failover');
        for (let i = 0; i < 100 && Date.now() <= expiry; i++) await delay(100);
        if (Date.now() <= expiry) throw new Error('FIXTURE_LEASE_TIMEOUT');
        const successor = supervisor ? contender : startWorker({ ...input, worker: 'successor' });
        if (!supervisor) workers.push(successor); await successor.wait('ready');
        await assert.rejects(createXPushStore(db).assertLease(stale), { code: 'X_PUSH_LEASE_LOST' });
        await successor.wait('received', 'offline');
        const inbox = await db.queryDatabase('SELECT COUNT(*) n,COUNT(DISTINCT version) versions FROM automation_x_push_inbox WHERE subscription_id=?', [saved.subscription.id]);
        assert.equal(Number(inbox[0].n), 2); assert.equal(Number(inbox[0].versions), 2);
        if (supervisor) {
            await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [Date.now() - 301000, saved.subscription.id]);
            let jobs = 0;
            for (let i = 0; i < 100 && jobs < 2; i++) {
                jobs = Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n); if (jobs < 2) await delay(100);
            }
            if (jobs !== 2) throw new Error('FIXTURE_FAILOVER_ROUTE_FAILED');
        }
        successor.child.send({ action: 'stop' }); await successor.wait('done', 'stopped'); await successor.waitExit();
        console.log(JSON.stringify({ browser, realFcm: true, exclusiveLease: true, abruptWorkerExit: true, actualLeaseExpiry: true,
            successorReceivedOfflinePush: true, staleWorkerFenced: true, encryptedReceipts: 2, duplicateRows: 0,
            automaticSupervisorTakeover: supervisor, isolatedJobs: supervisor ? 2 : null, discordRequests: 0 }));
    } finally {
        for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
        await Promise.allSettled(workers.map(worker => worker.waitExit()));
        await db.close();
    }
}
main().catch(error => { console.error(/^FIXTURE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'FIXTURE_FAILOVER_FAILED'); process.exitCode = 1; });
