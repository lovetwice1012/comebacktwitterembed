'use strict';
// Disposable localhost fixture only. No existing profile, X account or X data.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const CDP = require('chrome-remote-interface');
const webpush = require('web-push');
const { ClassicLevel } = require('classic-level');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { captureFromBroker } = require('../../src/automation/chrome-broker-client');
const { rewriteSyntheticOrigin } = require('./edge-fixture-record.cjs');
const { readEdgeSnapshot } = require('../../src/automation/edge-wns-snapshot-io');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'start';
async function main() {
    if (process.env.NODE_ENV !== 'test' || process.platform !== 'win32') throw new Error('PROBE_MODE_INVALID');
    const realWns = process.env.EDGE_PROBE_REAL_WNS === '1';
    if (realWns && (process.env.EDGE_PROBE_DATABASE !== '1' || !/^[1-9]\d{2}$/.test(process.env.EDGE_PROBE_SYNTHETIC_CHANNEL || '')
        || !/^\d\.\d$/.test(process.env.EDGE_PROBE_SYNTHETIC_PROTOCOL || ''))) throw new Error('PROBE_MODE_INVALID');
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-broker-fixture-'));
    const profile = path.join(root, 'profile'), edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    let server, chrome, cdp, broker, testDb;
    try {
        const vapid = webpush.generateVAPIDKeys();
        server = http.createServer((request, response) => {
            if (request.url === '/sw.js') { response.writeHead(200, { 'content-type': 'application/javascript' }); response.end('self.addEventListener("push",e=>e.waitUntil(self.registration.showNotification("fixture")))'); }
            else { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<script>window.key=${JSON.stringify(vapid.publicKey)}</script>`); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        chrome = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
            { windowsHide: true, stdio: 'ignore' });
        let port;
        for (let i = 0; i < 120 && !port; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); } }
        if (!port || chrome.exitCode !== null) throw new Error('PROBE_BROWSER_FAILED');
        cdp = await CDP({ port });
        const browserProduct = (await cdp.Browser.getVersion()).product;
        if (process.env.EDGE_PROBE_REPORT_PRODUCT === '1' && typeof browserProduct === 'string' && /^(?:Chrome|Edg|MicrosoftEdge)\/[0-9.]{1,64}$/.test(browserProduct))
            console.error('PROBE_BROWSER_PRODUCT', browserProduct);
        await cdp.Browser.grantPermissions({ origin, permissions: ['notifications'] }); await cdp.Page.enable();
        const loaded = new Promise(resolve => cdp.Page.loadEventFired(resolve)); await cdp.Page.navigate({ url: origin }); await loaded;
        const response = await cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
            const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
            const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.key});return s.toJSON()})()` });
        if (response.exceptionDetails || !response.result?.value?.endpoint) throw new Error('PROBE_SUBSCRIPTION_FAILED');
        const expected = response.result.value;
        const exit = chrome.exitCode === null ? once(chrome, 'exit') : Promise.resolve();
        await cdp.Browser.close(); await cdp.close(); cdp = null; await exit; chrome = null;
        stage = 'broker';
        broker = await startChromeBroker({ chromePath: edge, profilePath: profile, origin, browserMode: 'edge', includeApplicationServerKey: true, extraArgs: ['--headless=new'] });
        let captured;
        stage = 'capture';
        for (let i = 0; i < 50 && !captured; i++) {
            try { captured = await captureFromBroker({ port: broker.port, token: broker.token, includeApplicationServerKey: true }); }
            catch (error) { if (!['X_CHROME_CAPTURE_NOT_FOUND', 'X_CHROME_CAPTURE_INVALID', 'X_CHROME_CAPTURE_UNAVAILABLE'].includes(error?.code)) throw error; await wait(100); }
        }
        if (!captured || captured.endpoint !== expected.endpoint || captured.keys.p256dh !== expected.keys.p256dh
            || captured.keys.auth !== expected.keys.auth || captured.applicationServerKey !== vapid.publicKey) throw new Error('PROBE_CAPTURE_MISMATCH');
        stage = 'snapshot';
        const token = randomBytes(16).toString('hex'), snapshotPath = path.join(root, `edge-snapshot-${token}`);
        const storePath = path.join(snapshotPath, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        await fs.cp(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'), storePath, { recursive: true, errorOnExist: true, force: false });
        await fs.writeFile(path.join(snapshotPath, 'snapshot-owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-snapshot-v1', token }), { flag: 'wx' });
        const db = new ClassicLevel(storePath, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
        let rewriteKey, rewriteValue;
        try {
            await db.open();
            for await (const [candidateKey, value] of db.iterator({ limit: 128 })) {
                if (value.includes(Buffer.from(origin)) && value.includes(Buffer.from(captured.keys.p256dh, 'base64url')) && value.includes(Buffer.from(captured.keys.auth, 'base64url'))) {
                    if (rewriteKey) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS');
                    rewriteKey = Buffer.from(candidateKey); rewriteValue = rewriteSyntheticOrigin(value, `${origin}/`);
                }
            }
            if (!rewriteKey) throw new Error('PROBE_SUBSCRIPTION_FAILED');
            await db.put(rewriteKey, rewriteValue);
        } finally { rewriteKey?.fill(0); rewriteValue?.fill(0); await db.close().catch(() => {}); }
        const observed = { endpoint: captured.endpoint, publicKey: Buffer.from(captured.keys.p256dh, 'base64url'), auth: Buffer.from(captured.keys.auth, 'base64url'),
            applicationServerKey: Buffer.from(captured.applicationServerKey, 'base64url') };
        let result;
        try {
            result = await readEdgeSnapshot({ snapshotPath, token, expected: observed, browserVersion: browserProduct.split('/')[1],
                agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
                client: { channel: realWns ? process.env.EDGE_PROBE_SYNTHETIC_CHANNEL : 'abc', protocolVersion: realWns ? process.env.EDGE_PROBE_SYNTHETIC_PROTOCOL : '1.0',
                    clientName: 'Synthetic client', clientVersion: '1.2.3.4' },
                dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }) });
        } finally { observed.publicKey.fill(0); observed.auth.fill(0); observed.applicationServerKey.fill(0); }
        if (result.file.push.p256dhPublicKey !== captured.keys.p256dh || result.file.push.authenticationSecret !== captured.keys.auth
            || result.file.push.applicationServerKey !== captured.applicationServerKey) throw new Error('PROBE_CAPTURE_MISMATCH');
        stage = 'vault';
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 }), config = { activeKeyId: 'test', privateKeys: { test: keys.privateKey } };
        const sealer = createTransferPublicSealer({ activeKeyId: 'test', publicKeys: { test: keys.publicKey } }), vault = createTransferPrivateWorkerVault(config);
        const context = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
        const restored = vault.open(sealer.seal(result.file, context), context);
        const cryptoKeys = { public_key: [...Buffer.from(restored.push.p256dhPublicKey, 'base64url')],
            private_key: [...Buffer.from(restored.push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(restored.push.authenticationSecret, 'base64url')] };
        const { encryptFixture } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/tests/fixtures/crypto-fixture-builder.mjs')).href);
        const { decryptNotification } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
        const wire = encryptFixture(cryptoKeys, JSON.stringify({ text: 'synthetic' }));
        if (decryptNotification(wire.data, wire.headers, cryptoKeys)?.text !== 'synthetic') throw new Error('PROBE_DECRYPT_FAILED');
        let databaseRecovery = false, realWnsWorkerTested = false;
        if (process.env.EDGE_PROBE_DATABASE === '1') {
            if (Number(process.env.AUTOMATION_TEST_DB_PORT) !== 33621) throw new Error('PROBE_MODE_INVALID');
            stage = 'database';
            testDb = await require('../../scripts/lib/automation-test-db').createTestDatabase(33621);
            const { createXSetup } = require('../../src/automation/x-setup');
            const service = createXSetup(testDb, { sealer, rolloutMode: 'public', edgeEnabled: true, receiverEnabled: true });
            const actor = { userId: context.ownerUserId }, session = await service.startSession(actor, { consent: true });
            const saved = await service.importFile(actor, { sessionId: session.sessionId, fileText: JSON.stringify(result.file), consent: true });
            const { createXPushGateway } = require('../../src/automation/x-push-gateway');
            const gateway = createXPushGateway(testDb, { enabled: true, privateWorkerVault: vault, rolloutMode: 'public' });
            const identity = { subscriptionId: saved.subscription.id, ownerUserId: actor.userId };
            const lease = await gateway.store.claim({ ...identity, workerId: 'synthetic-edge-pipeline' });
            if (!lease) throw new Error('PROBE_DATABASE_FAILED');
            try {
                const inbox = await gateway.store.recordFrame(lease, { version: 'synthetic', data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 });
                if ((await gateway.decryptInbox(lease, inbox))?.text !== 'synthetic') throw new Error('PROBE_DATABASE_FAILED');
                databaseRecovery = true;
            } finally { await gateway.store.release(lease); }
            if (realWns) {
                stage = 'wns';
                const { createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
                const wnsGateway = createXPushGateway(testDb, { enabled: true, edgeEnabled: true, privateWorkerVault: vault,
                    edgeTokenVault: createWnsTokenWorkerVault(config), rolloutMode: 'public' });
                const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000); let received;
                webpush.setVapidDetails('mailto:test@example.com', vapid.publicKey, vapid.privateKey);
                try {
                    await wnsGateway.run({ ...identity, workerId: 'synthetic-edge-wns', signal: controller.signal,
                        onSession: async () => { await webpush.sendNotification(expected, JSON.stringify({ text: 'synthetic-real-wns' }), { TTL: 60 }); },
                        onReceived: async event => { received = event; controller.abort(); } });
                    if (received?.payload?.text !== 'synthetic-real-wns') throw new Error('PROBE_WNS_PIPELINE_FAILED');
                    const recovery = await wnsGateway.store.claim({ ...identity, workerId: 'synthetic-edge-recovery' });
                    if (!recovery) throw new Error('PROBE_WNS_PIPELINE_FAILED');
                    try {
                        const restoredReceipt = await wnsGateway.store.getInbox({ ...identity, id: received.inbox.id });
                        if ((await wnsGateway.decryptInbox(recovery, restoredReceipt))?.text !== 'synthetic-real-wns') throw new Error('PROBE_WNS_PIPELINE_FAILED');
                    } finally { await wnsGateway.store.release(recovery); }
                    realWnsWorkerTested = true;
                } finally { clearTimeout(timer); controller.abort(); }
            }
        }
        for (const field of Object.values(cryptoKeys)) field.fill(0);
        const summary = { syntheticProfile: true, privatePipeCapture: true, subscriptionMatched: true, applicationKeyMatched: true,
            snapshotSelected: true, ownerBoundVault: true, fixtureDecrypted: true, databaseRecovery, browserClosed: broker.chrome.exitCode !== null, realWnsWorkerTested };
        if (typeof process.send === 'function') await new Promise((resolve, reject) => process.send(summary, error => error ? reject(new Error('PROBE_IPC_FAILED')) : resolve()));
        else console.log(JSON.stringify(summary));
    } finally {
        if (testDb) await testDb.close();
        if (cdp) await cdp.close().catch(() => {});
        if (broker) { await broker.stop().catch(() => {}); if (broker.chrome.exitCode === null) { broker.chrome.kill(); await once(broker.chrome, 'exit').catch(() => {}); } }
        if (chrome && chrome.exitCode === null) { chrome.kill(); await once(chrome, 'exit').catch(() => {}); }
        if (server) await new Promise(resolve => server.close(resolve));
        const actual = await fs.realpath(root);
        if (path.dirname(actual).toLowerCase() !== temp.toLowerCase() || !/^cbte-edge-broker-fixture-[A-Za-z0-9]+$/.test(path.basename(actual))) throw new Error('PROBE_CLEANUP_INVALID');
        await fs.rm(actual, { recursive: true });
    }
}
main().catch(error => { const code = /^X_CHROME_[A-Z_]+$/.test(error?.code || '') ? error.code : /^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PROBE_FAILED';
    console.error('PROBE_STAGE', stage, code); process.exitCode = 1; });
