'use strict';
// Disposable localhost fixture only. No existing profile, X account or X data.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes, generateKeyPairSync, X509Certificate, createHash } = require('node:crypto');
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
    const calibrate = process.env.EDGE_PROBE_RELAY_CALIBRATION === '1';
    if (realWns && (process.env.EDGE_PROBE_DATABASE !== '1' || !calibrate && (!/^[1-9]\d{2}$/.test(process.env.EDGE_PROBE_SYNTHETIC_CHANNEL || '')
        || !/^\d\.\d$/.test(process.env.EDGE_PROBE_SYNTHETIC_PROTOCOL || '')))) throw new Error('PROBE_MODE_INVALID');
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-broker-fixture-'));
    const profile = path.join(root, 'profile'), edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    let server, chrome, cdp, broker, testDb, calibrationRelay, calibrationPfx;
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
        let calibrationMetadata;
        if (process.env.EDGE_PROBE_RELAY_CALIBRATION === '1') {
            stage = 'calibration';
            if (process.env.EDGE_PROBE_CALIBRATION_RUNNER === '1') {
                const calibrationToken = randomBytes(16).toString('hex'), calibrationRoot = path.join(root, `edge-calibration-${calibrationToken}`);
                await fs.mkdir(path.join(calibrationRoot, 'profile'), { recursive: true });
                await fs.writeFile(path.join(calibrationRoot, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token: calibrationToken }), { flag: 'wx' });
                const certHelper = path.resolve(__dirname, '../../client/angelic-setup/EdgeEphemeralCertificate.ps1').replace(/'/g, "''");
                const peerHelper = path.resolve(__dirname, '../../client/angelic-setup/EdgePeerIdentity.ps1').replace(/'/g, "''"), executable = edge.replace(/'/g, "''");
                const command = `$ErrorActionPreference='Stop'; . '${certHelper}'; $c=New-XEdgeEphemeralCertificate; try { [ordered]@{pfx=[Convert]::ToBase64String($c.pfx);password=$c.password;certificate=[Convert]::ToBase64String($c.certificate)}|ConvertTo-Json -Compress } finally { [Array]::Clear($c.pfx,0,$c.pfx.Length);[Array]::Clear($c.certificate,0,$c.certificate.Length) }`;
                const execute = source => require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
                    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
                const output = execute(command); if (output.status !== 0) throw new Error('PROBE_CERT_FAILED');
                const cert = JSON.parse(output.stdout); calibrationPfx = Buffer.from(cert.pfx, 'base64');
                const calibrated = await require('../../src/automation/edge-calibration-runner').runEdgeCalibration({ rootPath: calibrationRoot, token: calibrationToken, edgePath: edge,
                    pfx: calibrationPfx, passphrase: cert.password, certificate: Buffer.from(cert.certificate, 'base64'),
                    captureIdentity: async pid => {
                        const source = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; try {if ([IO.Path]::GetFullPath($p.Path) -ine '${executable}') {exit 1}; $p.StartTime.ToUniversalTime().Ticks.ToString()} finally {$p.Dispose()}`;
                        const value = execute(source); if (value.status !== 0) throw new Error('PROBE_PEER_AUTH_FAILED'); return (value.stdout || '').trim();
                    },
                    authorizePeer: async ({ clientPort, serverPort, browserPid, browserStartTicks }) => {
                        const source = `$ErrorActionPreference='Stop'; . '${peerHelper}'; if (-not (Test-XEdgeOwnedLoopbackPeer -ClientPort ${clientPort} -ServerPort ${serverPort} -BrowserPid ${browserPid} -BrowserStartTicks ([long]'${browserStartTicks}') -BrowserExecutable '${executable}')) {exit 1}; exit 0`;
                        return execute(source).status === 0;
                    } });
                if (calibrated.browserVersion !== browserProduct.split('/')[1]) throw new Error('PROBE_CALIBRATION_PROFILE_INVALID');
                calibrationMetadata = calibrated.client;
            } else {
            // A separate disposable profile is calibrated. The profile whose
            // notification settings will be exported never uses the relay.
            const calibrationProfile = path.join(root, 'calibration-profile');
            if (process.env.EDGE_PROBE_CALIBRATION_PIPE === '1') {
                chrome = spawn(edge, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${calibrationProfile}`,
                    '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
                const pipe = require('../../src/automation/chrome-cdp-pipe').createChromePipe(chrome, { origin, browserMode: 'edge', calibration: true, timeoutMs: 30000 });
                if (await pipe.ready() !== browserProduct.split('/')[1] || await pipe.prepareCalibration(vapid.publicKey) !== true) throw new Error('PROBE_CALIBRATION_PROFILE_INVALID');
                await pipe.closeBrowser(); chrome = null;
            } else {
            chrome = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${calibrationProfile}`,
                '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
            let calibrationPort;
            for (let i = 0; i < 120 && !calibrationPort; i++) {
                try { calibrationPort = Number((await fs.readFile(path.join(calibrationProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); }
            }
            if (!calibrationPort || chrome.exitCode !== null) throw new Error('PROBE_BROWSER_FAILED');
            cdp = await CDP({ port: calibrationPort }); await cdp.Browser.grantPermissions({ origin, permissions: ['notifications'] }); await cdp.Page.enable();
            const calibrationLoaded = new Promise(resolve => cdp.Page.loadEventFired(resolve)); await cdp.Page.navigate({ url: origin }); await calibrationLoaded;
            const calibrationSubscription = await cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
                const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
                const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.key});return s.toJSON()})()` });
            if (calibrationSubscription.exceptionDetails || !calibrationSubscription.result?.value?.endpoint
                || calibrationSubscription.result.value.keys?.p256dh === captured.keys.p256dh) throw new Error('PROBE_CALIBRATION_PROFILE_INVALID');
            const calibrationExit = chrome.exitCode === null ? once(chrome, 'exit') : Promise.resolve();
            await cdp.Browser.close(); await cdp.close(); cdp = null; await calibrationExit; chrome = null;
            }
            const certHelper = path.resolve(__dirname, '../../client/angelic-setup/EdgeEphemeralCertificate.ps1').replace(/'/g, "''");
            const certCommand = `$ErrorActionPreference='Stop'; . '${certHelper}'; $c=New-XEdgeEphemeralCertificate; try { [ordered]@{pfx=[Convert]::ToBase64String($c.pfx);password=$c.password;certificate=[Convert]::ToBase64String($c.certificate)}|ConvertTo-Json -Compress } finally { [Array]::Clear($c.pfx,0,$c.pfx.Length);[Array]::Clear($c.certificate,0,$c.certificate.Length) }`;
            const certOutput = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(certCommand, 'utf16le').toString('base64')],
                { encoding: 'utf8', windowsHide: true, timeout: 10000 });
            if (certOutput.status !== 0) throw new Error('PROBE_CERT_FAILED');
            const cert = JSON.parse(certOutput.stdout); calibrationPfx = Buffer.from(cert.pfx, 'base64');
            const spki = createHash('sha256').update(new X509Certificate(Buffer.from(cert.certificate, 'base64')).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
            let browserTicks;
            const helper = path.resolve(__dirname, '../../client/angelic-setup/EdgePeerIdentity.ps1').replace(/'/g, "''"), executable = edge.replace(/'/g, "''");
            calibrationRelay = await require('../../src/automation/edge-calibration-relay').createEdgeCalibrationRelay({ pfx: calibrationPfx, passphrase: cert.password,
                authorizePeer: async ({ clientPort, serverPort }) => {
                    if (!chrome || !/^\d{18}$/.test(browserTicks || '')) return false;
                    const command = `$ErrorActionPreference='Stop'; . '${helper}'; if (-not (Test-XEdgeOwnedLoopbackPeer -ClientPort ${clientPort} -ServerPort ${serverPort} -BrowserPid ${chrome.pid} -BrowserStartTicks ([long]'${browserTicks}') -BrowserExecutable '${executable}')) {exit 1}; exit 0`;
                    const checked = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
                    return checked.status === 0;
                } });
            chrome = spawn(edge, ['--headless=new', `--user-data-dir=${calibrationProfile}`, `--edge-wns-push-server-url=https://127.0.0.1:${calibrationRelay.port}`,
                `--ignore-certificate-errors-spki-list=${spki}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
            const ticksCommand = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${chrome.pid}; try {if ([IO.Path]::GetFullPath($p.Path) -ine '${executable}') {exit 1}; $p.StartTime.ToUniversalTime().Ticks.ToString()} finally {$p.Dispose()}`;
            const ticksOutput = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ticksCommand, 'utf16le').toString('base64')],
                { encoding: 'utf8', windowsHide: true, timeout: 10000 });
            browserTicks = (ticksOutput.stdout || '').trim(); if (ticksOutput.status !== 0 || !/^\d{18}$/.test(browserTicks)) throw new Error('PROBE_PEER_AUTH_FAILED');
            let timeout;
            try { calibrationMetadata = await Promise.race([calibrationRelay.metadata, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('PROBE_CALIBRATION_TIMEOUT')), 30000); })]); }
            finally { clearTimeout(timeout); }
            await calibrationRelay.close(); calibrationRelay = null;
            if (chrome.exitCode === null) { chrome.kill(); await once(chrome, 'exit'); } chrome = null;
            }
        }
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
                client: calibrationMetadata || { channel: realWns ? process.env.EDGE_PROBE_SYNTHETIC_CHANNEL : 'abc', protocolVersion: realWns ? process.env.EDGE_PROBE_SYNTHETIC_PROTOCOL : '1.0',
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
            snapshotSelected: true, ownerBoundVault: true, fixtureDecrypted: true, databaseRecovery, calibrationMetadataCaptured: Boolean(calibrationMetadata), browserClosed: broker.chrome.exitCode !== null, realWnsWorkerTested };
        if (typeof process.send === 'function') await new Promise((resolve, reject) => process.send(summary, error => error ? reject(new Error('PROBE_IPC_FAILED')) : resolve()));
        else console.log(JSON.stringify(summary));
    } finally {
        if (testDb) await testDb.close();
        if (calibrationRelay) await calibrationRelay.close().catch(() => {});
        calibrationPfx?.fill(0);
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
