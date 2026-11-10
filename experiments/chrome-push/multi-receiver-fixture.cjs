'use strict';
// Synthetic profiles only. Setup children finish before one in-process worker
// opens both real FCM connections. Credentials travel only over private IPC.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const path = require('node:path');
const tls = require('node:tls');
const webpush = require('web-push');
const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'start';
async function createSyntheticSubscription(browser) {
    const env = { ...process.env, CHROMIUM_PROBE_BROWSER: browser, CHROME_FIXTURE_SYNTHETIC_IPC: '1', CHROME_FIXTURE_BLOCK_INITIAL: '1' };
    for (const key of ['CHROME_FIXTURE_LINUX', 'CHROME_FIXTURE_MYSQL_PORT', 'CHROME_FIXTURE_REOPEN', 'CHROME_FIXTURE_RUNTIME', 'CHROME_FIXTURE_OTHER']) delete env[key];
    const child = fork(path.join(__dirname, 'packaged-e2e.cjs'), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let data;
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('FIXTURE_CHILD_TIMEOUT')); }, 90000);
            child.once('message', value => { data = value; });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); if (code === 0 && data?.browser === browser) resolve(); else reject(new Error('FIXTURE_CHILD_FAILED')); });
        });
        return data;
    } finally { if (child.exitCode === null) child.kill(); }
}
async function main() {
    assert.equal(Number(process.env.AUTOMATION_TEST_DB_PORT), 33631, 'Use isolated fixture DB port 33631');
    stage = 'create-chrome'; const chrome = await createSyntheticSubscription('chrome');
    stage = 'create-brave'; const brave = await createSyntheticSubscription('brave'); const fixtures = [chrome, brave];
    assert.notEqual(fixtures[0].transfer.push.deviceId, fixtures[1].transfer.push.deviceId);
    const db = await createTestDatabase(33631); let runtime;
    try {
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: keys.publicKey } });
        const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture', privateKeys: { fixture: keys.privateKey } });
        const setup = createXSetup(db, { sealer, chromeEnabled: true, braveEnabled: true, receiverEnabled: true, rolloutMode: 'public' });
        const owners = ['222222222222222222', '333333333333333333']; let clock = Date.now();
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        for (let i = 0; i < fixtures.length; i++) {
            const owner = { userId: owners[i] }, fixture = fixtures[i], session = await setup.startSession(owner, { consent: true });
            const saved = await setup.importFile(owner, { sessionId: session.sessionId, fileText: JSON.stringify(fixture.transfer), consent: true });
            fixture.subscriptionId = saved.subscription.id;
            const target = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,'fixture',1,'ready','free',?,'bound',1,?,?)",
                [owners[i], String(12345 + i), `synthetic${i}`, JSON.stringify({ subscriptionId: fixture.subscriptionId }), clock, clock]);
            await db.withDatabaseTransaction(query => entitlements.assignSlot(query, owners[i], 'x', String(target.insertId)));
        }
        const tracedDb = { ...db, withDatabaseTransaction: async work => {
            try { return await db.withDatabaseTransaction(query => work(async (sql, args) => {
                try { return await query(sql, args); }
                catch (error) {
                    if (error?.code === 'ER_LOCK_DEADLOCK') console.error(JSON.stringify({ deadlockStatement: /^\s*(\w+)/.exec(sql)?.[1] || 'unknown',
                        receiverTable: sql.includes('automation_x_push_receivers'), subscriptionTable: sql.includes('automation_x_subscriptions') }));
                    throw error;
                }
            })); }
            catch (error) { if (/^ER_[A-Z_]+$/.test(error?.code || '')) console.error(JSON.stringify({ fixtureDatabaseError: error.code })); throw error; }
        } };
        stage = 'connect';
        const expectedVersions = new Map(), observedVersions = new Set();
        const gateway = createXPushGateway(tracedDb, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public', requestTimeoutMs: 15000, leaseMs: 300000,
            createChromeSocket: () => {
                const socket = tls.connect({ host: 'mtalk.google.com', port: 443, servername: 'mtalk.google.com', rejectUnauthorized: true });
                const write = socket.write.bind(socket);
                socket.write = (data, ...args) => {
                    if (Buffer.isBuffer(data) && data[0] === 41) for (const [index, version] of expectedVersions)
                        if (data.includes(Buffer.from(`chrome-${version}`))) observedVersions.add(index);
                    return write(data, ...args);
                };
                return socket;
            } });
        const queue = createQueue(db, {}, { clock: () => clock, rolloutMode: 'public' });
        runtime = createXPushRuntime(db, queue, { enabled: true, gateway, clock: () => clock, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed() {} });
        await runtime.tick(); let connected = false;
        for (let i = 0; i < 120 && !connected; i++) {
            // Drive the normal periodic tick and wall clock so a transient
            // failure can follow the worker's real reconnect policy.
            clock = Date.now(); await runtime.tick();
            const rows = await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_push_receivers WHERE state='listening'");
            connected = Number(rows[0].n) === 2; if (!connected) await delay(250);
        }
        if (!connected || runtime.status().sessions !== 2) {
            const states = await db.queryDatabase('SELECT state,reason_code FROM automation_x_push_receivers ORDER BY state,reason_code');
            console.error(JSON.stringify({ fixtureStates: states, runtime: runtime.status() }));
            throw new Error('FIXTURE_MULTI_CONNECT_FAILED');
        }
        const send = (i, sequence) => {
            const fixture = fixtures[i];
            return webpush.sendNotification(fixture.subscription,
                JSON.stringify({ notificationType: 'tweet', text: `synthetic-${i}-${sequence}`, author: { id: String(12345 + i), handle: `synthetic${i}` },
                    url: `https://x.com/synthetic${i}/status/${1234567890123456789n + BigInt(i) + BigInt(sequence) * 10n}` }),
                { TTL: 60, vapidDetails: { subject: 'mailto:test@example.com', publicKey: fixture.vapid.publicKey, privateKey: fixture.vapid.privateKey } });
        };
        stage = 'send';
        await Promise.all(fixtures.map((_fixture, i) => send(i, 0)));
        stage = 'receive'; let received = false;
        for (let i = 0; i < 120 && !received; i++) {
            const rows = await db.queryDatabase('SELECT subscription_id,COUNT(*) n FROM automation_x_push_inbox GROUP BY subscription_id');
            received = rows.length === 2 && rows.every(row => Number(row.n) === 1); if (!received) await delay(250);
        }
        if (!received) throw new Error('FIXTURE_MULTI_RECEIPT_FAILED');
        stage = 'route'; clock = Date.now();
        // Simulate the configured five-minute wait only in the disposable DB;
        // leave lease and runtime clocks aligned with real time.
        await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id IN (?)',
            [clock - 301000, fixtures.map(fixture => fixture.subscriptionId)]);
        let jobs = [];
        for (let i = 0; i < 30 && jobs.length < 2; i++) {
            await runtime.tick(); jobs = await db.queryDatabase('SELECT r.owner_user_id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id'); if (jobs.length < 2) await delay(250);
        }
        const ownerCounts = owners.map(owner => jobs.filter(row => row.owner_user_id === owner).length);
        if (jobs.length !== 2 || ownerCounts.some(count => count !== 1)) {
            const states = await db.queryDatabase('SELECT status,COUNT(*) n FROM automation_x_push_inbox GROUP BY status');
            console.error(JSON.stringify({ fixtureJobCount: jobs.length, ownerCounts, inboxStates: states }));
            throw new Error('FIXTURE_MULTI_ROUTE_FAILED');
        }
        async function refreshAndProve(index, sequence, versionField) {
        stage = `refresh-${index}`;
        const otherIndex = 1 - index, wantedJobs = (sequence + 1) * 2;
        const before = await db.queryDatabase('SELECT subscription_id,lease_token FROM automation_x_push_receivers WHERE subscription_id IN (?)',
            [fixtures.map(fixture => fixture.subscriptionId)]);
        const priorTokens = new Map(before.map(row => [row.subscription_id, row.lease_token]));
        const previousRevision = Number((await db.queryDatabase('SELECT revision FROM automation_x_subscriptions WHERE id=?', [fixtures[index].subscriptionId]))[0].revision);
        const changedTransfer = structuredClone(fixtures[index].transfer), version = changedTransfer.provenance[versionField].split('.');
        version[3] = String((Number(version[3]) + 1) % 100000); changedTransfer.provenance[versionField] = version.join('.');
        expectedVersions.set(index, changedTransfer.provenance[versionField]);
        const actor = { userId: owners[index] }, newSession = await setup.startSession(actor, { consent: true });
        const refreshed = await setup.importFile(actor, { sessionId: newSession.sessionId, fileText: JSON.stringify(changedTransfer), consent: true });
        if (!refreshed.duplicate || refreshed.subscription.id !== fixtures[index].subscriptionId
            || refreshed.subscription.revision !== previousRevision || refreshed.subscription.browserVersion !== changedTransfer.provenance.browserVersion)
            throw new Error('FIXTURE_MULTI_REFRESH_FAILED');
        clock = Date.now();
        const refreshTick = runtime.tick();
        await Promise.all([refreshTick, send(otherIndex, sequence)]);
        let refreshReady = false;
        for (let i = 0; i < 120 && !refreshReady; i++) {
            clock = Date.now(); await runtime.tick();
            const rows = await db.queryDatabase('SELECT subscription_id,state,lease_token FROM automation_x_push_receivers WHERE subscription_id IN (?)',
                [fixtures.map(fixture => fixture.subscriptionId)]);
            const first = rows.find(row => row.subscription_id === fixtures[index].subscriptionId), other = rows.find(row => row.subscription_id === fixtures[otherIndex].subscriptionId);
            if (!other || other.state !== 'listening' || other.lease_token !== priorTokens.get(fixtures[otherIndex].subscriptionId)) throw new Error('FIXTURE_OTHER_CONNECTION_CHANGED');
            refreshReady = first?.state === 'listening' && first.lease_token !== priorTokens.get(fixtures[index].subscriptionId);
            if (!refreshReady) await delay(250);
        }
        if (!refreshReady || !observedVersions.has(index)) throw new Error('FIXTURE_MULTI_REFRESH_TIMEOUT');
        await send(index, sequence);
        let allReceived = false;
        for (let i = 0; i < 120 && !allReceived; i++) {
            const rows = await db.queryDatabase('SELECT subscription_id,COUNT(*) n FROM automation_x_push_inbox GROUP BY subscription_id');
            allReceived = rows.length === 2 && rows.every(row => Number(row.n) === sequence + 1); if (!allReceived) await delay(250);
        }
        if (!allReceived) throw new Error('FIXTURE_MULTI_REFRESH_RECEIPT_FAILED');
        clock = Date.now();
        await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id IN (?)',
            [clock - 301000, fixtures.map(fixture => fixture.subscriptionId)]);
        for (let i = 0; i < 30 && jobs.length < wantedJobs; i++) {
            await runtime.tick(); jobs = await db.queryDatabase('SELECT r.owner_user_id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id');
            if (jobs.length < wantedJobs) await delay(250);
        }
        if (jobs.length !== wantedJobs || owners.some(owner => jobs.filter(row => row.owner_user_id === owner).length !== sequence + 1)) throw new Error('FIXTURE_MULTI_REFRESH_ROUTE_FAILED');
        }
        await refreshAndProve(0, 1, 'browserVersion');
        await refreshAndProve(1, 2, 'engineVersion');
        console.log(JSON.stringify({ syntheticProfiles: 2, receiverProcesses: 1, simultaneousConnections: 2, realFcm: true,
            encryptedReceipts: 6, isolatedOwnerJobs: 6, simulatedChromeVersionUpdate: true, simulatedBraveEngineUpdate: true,
            targetedRefreshPreservedOtherConnection: true, discordRequests: 0 }));
    } finally { await runtime?.stop(); await db.close(); }
}
main().catch(error => { console.error(JSON.stringify({ stage, code: /^FIXTURE_[A-Z_]+$/.test(error?.message || '') ? error.message : error?.code || error?.name || 'FIXTURE_MULTI_FAILED' })); process.exitCode = 1; });
