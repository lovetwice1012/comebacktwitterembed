'use strict';
// Full local setup fixture. A fresh headless Chrome profile is mapped to a
// local synthetic HTTPS site; no user's profile, credentials or X site is used.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const { spawn, spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const webpush = require('web-push');
const CDP = require('chrome-remote-interface');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const testBrowser = process.env.CHROMIUM_PROBE_BROWSER === 'brave' ? 'brave' : 'chrome';
const chrome = testBrowser === 'brave' ? 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
async function removeOwnedFixture(root, temp) {
    const actual = await fs.realpath(root);
    if (path.dirname(actual).toLowerCase() !== temp.toLowerCase() || !/^cbte-chrome-full-e2e-[A-Za-z0-9]+$/.test(path.basename(actual))) throw new Error('FIXTURE_CLEANUP_INVALID');
    await fs.rm(actual, { recursive: true });
}
async function stopOwnedBrokers(root) {
    const launchDir = path.join(root, 'owned', 'launches');
    const nested = path.join(root, 'bundle', '_app', 'ChromeNode.exe');
    const bundleExe = syncFs.existsSync(nested) ? nested : path.join(root, 'bundle', 'ChromeNode.exe');
    let names;
    try { names = await fs.readdir(launchDir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const cleanup = `$p=Get-Process -Id ([int]$env:CBTE_FIXTURE_PID) -ErrorAction SilentlyContinue
if ($null -ne $p) {
  try {
    $started=[DateTime]::Parse($env:CBTE_FIXTURE_STARTED).ToUniversalTime()
    # A finished broker's PID may already belong to an unrelated process.
    if ([IO.Path]::GetFullPath($p.Path) -ine [IO.Path]::GetFullPath($env:CBTE_FIXTURE_EXE) -or $p.StartTime.ToUniversalTime().Ticks -ne $started.Ticks) { return }
    & "$env:SystemRoot\\System32\\taskkill.exe" /PID $p.Id /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture stop failed' }
  } finally { $p.Dispose() }
}
exit 0`;
    for (const name of names) {
        if (!/^launch-[0-9a-f-]{36}\.json$/.test(name)) throw new Error('FIXTURE_LAUNCH_INVALID');
        const launch = JSON.parse(await fs.readFile(path.join(launchDir, name), 'utf8'));
        if (!Number.isInteger(launch.pid) || launch.pid < 1 || typeof launch.processStartedUtc !== 'string') throw new Error('FIXTURE_LAUNCH_INVALID');
        const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], {
            windowsHide: true, timeout: 20000, encoding: 'utf8', env: { ...process.env, CBTE_FIXTURE_PID: String(launch.pid),
                CBTE_FIXTURE_STARTED: launch.processStartedUtc, CBTE_FIXTURE_EXE: bundleExe },
        });
        if (result.status !== 0) throw new Error(`FIXTURE_BROKER_CLEANUP_FAILED: ${result.error?.code || result.status}: ${(result.stderr || '').slice(-3000)}`);
    }
}
const python = `from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime,timedelta,timezone
import json
k=rsa.generate_private_key(public_exponent=65537,key_size=2048)
n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'x.com')])
c=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc)-timedelta(days=1)).not_valid_after(datetime.now(timezone.utc)+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('x.com'),x509.DNSName('example.test')]),critical=False).sign(k,hashes.SHA256())
print(json.dumps({'key':k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()).decode(),'cert':c.public_bytes(serialization.Encoding.PEM).decode()}))`;

async function main() {
    if (!process.env.CHROME_SETUP_ZIP) throw new Error('FIXTURE_ZIP_REQUIRED');
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-chrome-full-e2e-'));
    let server, child, cdp, testDb, otherSubscription, browserPushEvents = 0;
    try {
        const packageRoot = path.join(root, 'bundle'); await fs.mkdir(packageRoot);
        const entries = unzipSync(await fs.readFile(process.env.CHROME_SETUP_ZIP));
        for (const [name, bytes] of Object.entries(entries)) {
            if (!/^(?:_app\/)?[^/\\]+$/.test(name)) throw new Error('FIXTURE_PACKAGE_INVALID');
            await fs.mkdir(path.dirname(path.join(packageRoot, name)), { recursive: true });
            await fs.writeFile(path.join(packageRoot, name), bytes, { flag: 'wx' });
        }
        const bundle = entries['_app/package-manifest.json'] ? path.join(packageRoot, '_app') : packageRoot;
        const owned = path.join(root, 'owned'), output = path.join(root, 'notification.json');
        const core = path.join(bundle, 'ChromeSetup.ps1');
        const invoke = args => {
            // The long-lived broker may inherit output handles. Ordinary files
            // let the caller observe the setup process exit without waiting for
            // the browser's separate lifecycle to close a pipe.
            const name = require('node:crypto').randomUUID(), outPath = path.join(root, `${name}.out`), errPath = path.join(root, `${name}.err`);
            const out = syncFs.openSync(outPath, 'wx'), err = syncFs.openSync(errPath, 'wx'); let result;
            try { result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', core, '-Browser', testBrowser, ...args],
                { windowsHide: true, timeout: 40000, stdio: ['ignore', out, err] }); }
            finally { syncFs.closeSync(out); syncFs.closeSync(err); }
            if (result.error) throw result.error;
            return { ...result, stdout: syncFs.readFileSync(outPath, 'utf8'), stderr: syncFs.readFileSync(errPath, 'utf8') };
        };
        const prep = invoke(['-Action', 'Prepare', '-PrivateRoot', owned]);
        if (prep.status !== 0 || !JSON.parse(prep.stdout).prepared) throw new Error('FIXTURE_PREPARE_FAILED');
        const certResult = spawnSync('python', ['-c', python], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        if (certResult.status !== 0) throw new Error('FIXTURE_CERT_FAILED');
        const certificate = JSON.parse(certResult.stdout), vapid = webpush.generateVAPIDKeys();
        webpush.setVapidDetails('mailto:test@example.com', vapid.publicKey, vapid.privateKey);
        server = https.createServer(certificate, (req, res) => {
            if (req.url === '/sw.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript' });
                res.end("self.addEventListener('push',e=>e.waitUntil(Promise.all([fetch('/browser-push-seen',{method:'POST'}),self.registration.showNotification('fixture')]))) ");
            } else if (req.url === '/browser-push-seen' && req.method === 'POST') {
                browserPushEvents++; res.writeHead(204); res.end();
            } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<script>window.vapid=${JSON.stringify(vapid.publicKey)}</script>`); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const profile = path.join(owned, 'chrome-profile');
        const chromeArgs = ['--headless=new', '--no-proxy-server', '--ignore-certificate-errors', '--remote-debugging-port=0',
            ...(process.env.CHROME_FIXTURE_BLOCK_INITIAL === '1' ? ['--gcm-mcs-endpoint=https://127.0.0.1:1'] : []),
            `--user-data-dir=${profile}`, `--host-resolver-rules=MAP mtalk.google.com ~NOTFOUND, MAP x.com 127.0.0.1:${server.address().port}, MAP example.test 127.0.0.1:${server.address().port}`,
            '--no-first-run', '--no-default-browser-check', 'https://x.com/'];
        child = spawn(chrome, chromeArgs, { windowsHide: true, stdio: 'ignore' });
        let port;
        for (let i = 0; i < 150 && !port; i++) {
            try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await pause(100); }
        }
        if (!port) throw new Error('FIXTURE_CHROME_START_FAILED');
        cdp = await CDP({ port }); await cdp.Browser.grantPermissions({ origin: 'https://x.com', permissions: ['notifications'] });
        await cdp.Page.enable();
        // The document may already have loaded before the debugger connected.
        const loaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
        await cdp.Page.navigate({ url: 'https://x.com/' }); await loaded;
        let subscribeTimer;
        const value = await Promise.race([cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
          const r=await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
          return (await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.vapid})).toJSON();})()` }),
            new Promise((_resolve, reject) => { subscribeTimer = setTimeout(() => reject(new Error('FIXTURE_SUBSCRIBE_TIMEOUT')), 30000); })])
            .finally(() => clearTimeout(subscribeTimer));
        if (value.exceptionDetails || !value.result.value?.endpoint) throw new Error('FIXTURE_SUBSCRIBE_FAILED');
        if (process.env.CHROME_FIXTURE_OTHER === '1') {
            await cdp.Browser.grantPermissions({ origin: 'https://example.test', permissions: ['notifications'] });
            const target = await CDP.New({ port, url: 'https://example.test/' });
            const other = await CDP({ port, target: target.id });
            try {
                await other.Page.enable(); const otherLoaded = new Promise(resolve => other.Page.loadEventFired(resolve));
                await other.Page.navigate({ url: 'https://example.test/' }); await otherLoaded;
                const second = await other.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
                  const r=await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
                  return (await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.vapid})).toJSON();})()` });
                if (second.exceptionDetails || !second.result.value?.endpoint) throw new Error('FIXTURE_OTHER_SUBSCRIBE_FAILED');
                otherSubscription = second.result.value;
            } finally { await other.close(); }
        }
        await cdp.Browser.close().catch(() => {});
        if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
        await cdp.close().catch(() => {}); cdp = null;
        const activePort = path.join(profile, 'DevToolsActivePort');
        await fs.unlink(activePort).catch(error => { if (error.code !== 'ENOENT') throw error; });
        // The extracted test copy alone receives flags mapping x.com to the
        // synthetic local site. Production sources and package are unchanged.
        const brokerFile = path.join(bundle, 'ChromeBroker.cjs');
        const originalBroker = await fs.readFile(brokerFile, 'utf8');
        const needle = 'startChromeBroker({ chromePath: input.chromePath, profilePath: input.profilePath });';
        if (!originalBroker.includes(needle)) throw new Error('FIXTURE_BROKER_SHAPE_CHANGED');
        const extra = ['--headless=new', '--no-proxy-server', '--ignore-certificate-errors',
            `--host-resolver-rules=MAP mtalk.google.com ~NOTFOUND, MAP x.com 127.0.0.1:${server.address().port}, MAP example.test 127.0.0.1:${server.address().port}`];
        let testBroker = originalBroker.replace(needle, `startChromeBroker({ chromePath: input.chromePath, profilePath: input.profilePath, extraArgs: ${JSON.stringify(extra)} });`);
        if (process.env.CHROME_FIXTURE_DNS_ONLY === '1') {
            const switchText = '"--gcm-mcs-endpoint=https://127.0.0.1:1",';
            if (testBroker.split(switchText).length !== 2) throw new Error('FIXTURE_MCS_SWITCH_SHAPE_CHANGED');
            // This extraction is disposable. Exercise the DNS safeguard alone
            // without changing the shipped package or any user profile.
            testBroker = testBroker.replace(switchText, '');
        }
        await fs.writeFile(brokerFile, testBroker);
        const manifestPath = path.join(bundle, 'package-manifest.json'), manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        manifest.files['ChromeBroker.cjs'] = require('node:crypto').createHash('sha256').update(testBroker).digest('hex');
        if (process.env.CHROME_FIXTURE_WRITE_FAILURE === '1') {
            // Inject only into this disposable extracted package, never the
            // release or an existing browser profile.
            const originalCore = await fs.readFile(core, 'utf8');
            const marker = "$stream=[XSetupNative.ReaderJob]::CreatePrivateFile($target,$script:UserSid.Value)";
            if (originalCore.split(marker).length !== 2) throw new Error('FIXTURE_WRITE_FAILURE_SHAPE_CHANGED');
            const testCore = originalCore.replace(marker, `${marker}\n                if ($env:CBTE_FIXTURE_FORCE_OUTPUT_FAILURE -eq '1') { throw 'synthetic output failure' }`);
            await fs.writeFile(core, testCore, 'utf8');
            manifest.files['ChromeSetup.ps1'] = require('node:crypto').createHash('sha256').update(testCore).digest('hex');
        }
        if (process.env.CHROME_FIXTURE_DIAGNOSTIC === '1') {
            const originalCore = await fs.readFile(core, 'utf8');
            const marker = "} catch {\n    $message=[string]$_.Exception.Message";
            if (!originalCore.includes(marker)) throw new Error('FIXTURE_DIAGNOSTIC_SHAPE_CHANGED');
            const diagnosticCore = originalCore.replace(marker, `} catch { [Console]::Error.WriteLine("FIXTURE_LINE="+$_.InvocationInfo.ScriptLineNumber+" ERROR="+$_.Exception.Message)\n    $message=[string]$_.Exception.Message`);
            await fs.writeFile(core, diagnosticCore, 'utf8');
            manifest.files['ChromeSetup.ps1'] = require('node:crypto').createHash('sha256').update(diagnosticCore).digest('hex');
        }
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
        async function openPrivateBrowser() {
            const started = Date.now();
            const opened = invoke(['-Action', 'Open', '-PrivateRoot', owned]);
            if (opened.status !== 0) {
                if (process.env.CHROME_FIXTURE_DIAGNOSTIC === '1') process.stderr.write(opened.stderr);
                throw new Error('FIXTURE_BROKER_OPEN_FAILED');
            }
            if (process.env.CHROME_FIXTURE_DIAGNOSTIC === '1') console.log(JSON.stringify({ brokerOpenMs: Date.now() - started }));
            for (let i = 0; i < 30; i++) {
                try { await fs.stat(activePort); throw new Error('FIXTURE_DEBUG_PORT_EXPOSED'); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                await pause(100);
            }
            const launchDir = path.join(owned, 'launches'), names = await fs.readdir(launchDir);
            const sorted = await Promise.all(names.map(async name => ({ name, time: (await fs.stat(path.join(launchDir, name))).mtimeMs })));
            sorted.sort((a, b) => b.time - a.time);
            const launch = JSON.parse(await fs.readFile(path.join(launchDir, sorted[0].name), 'utf8'));
            const attack = `const net=require('node:net'),fs=require('node:fs');const s=net.connect({host:'127.0.0.1',port:Number(process.argv[1])});let any=false;s.setTimeout(5000,()=>process.exit(2));s.on('connect',()=>s.write(fs.readFileSync(0)));s.on('data',()=>any=true);s.on('close',()=>process.exit(any?3:0));s.on('error',e=>process.exit(e.code==='ECONNRESET'?0:4));`;
            for (const body of ['GET /json/list HTTP/1.1\r\n\r\n', JSON.stringify({ command: 'Runtime.evaluate', token: launch.brokerToken }) + '\n']) {
                const attempt = spawnSync(process.execPath, ['-e', attack, String(launch.port)], { input: body, timeout: 7000, windowsHide: true });
                if (attempt.status !== 0) throw new Error('FIXTURE_BROKER_EXPOSED');
            }
            console.log(JSON.stringify({ separateProcessDebuggerAccessBlocked: true }));
        }
        await openPrivateBrowser();
        if (process.env.CHROME_FIXTURE_FORCE_FAILURE === '1') throw new Error('FIXTURE_FORCED_FAILURE');
        if (process.env.CHROME_FIXTURE_WRITE_FAILURE === '1') {
            const failedOutput = path.join(root, 'failed-output.json'), untouched = path.join(root, 'unrelated.txt');
            await fs.writeFile(untouched, 'synthetic sentinel', { flag: 'wx' });
            const prior = process.env.CBTE_FIXTURE_FORCE_OUTPUT_FAILURE;
            let failed;
            try {
                process.env.CBTE_FIXTURE_FORCE_OUTPUT_FAILURE = '1';
                failed = invoke(['-Action', 'Export', '-PrivateRoot', owned, '-OutputPath', failedOutput]);
            } finally {
                if (prior === undefined) delete process.env.CBTE_FIXTURE_FORCE_OUTPUT_FAILURE;
                else process.env.CBTE_FIXTURE_FORCE_OUTPUT_FAILURE = prior;
            }
            if (failed.status === 0) throw new Error('FIXTURE_WRITE_FAILURE_NOT_DETECTED');
            try { await fs.stat(failedOutput); throw new Error('FIXTURE_PARTIAL_OUTPUT_REMAINS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (await fs.readFile(untouched, 'utf8') !== 'synthetic sentinel') throw new Error('FIXTURE_UNRELATED_FILE_CHANGED');
            console.log(JSON.stringify({ failedOutputRemovedByOwnedHandle: true, unrelatedFilePreserved: true }));
            await openPrivateBrowser();
        }
        let exportStart = Date.now();
        let exported = invoke(['-Action', 'Export', '-PrivateRoot', owned, '-OutputPath', output]);
        if (process.env.CHROME_FIXTURE_DIAGNOSTIC === '1') console.log(JSON.stringify({ exportMs: Date.now() - exportStart }));
        if (process.env.CHROME_FIXTURE_OTHER === '1') {
            if (exported.status === 0 || !JSON.parse(exported.stdout).message.startsWith('X_CHROME_OTHER_CONSENT_REQUIRED:'))
                throw new Error('FIXTURE_CONSENT_REQUIRED_FAILED');
            try { await fs.stat(output); throw new Error('FIXTURE_UNAPPROVED_FILE_CREATED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const leftovers = (await fs.readdir(owned)).filter(name => name.startsWith('chrome-snapshot-'));
            if (leftovers.length) throw new Error('FIXTURE_SNAPSHOT_NOT_REMOVED');
            await openPrivateBrowser();
            exportStart = Date.now(); exported = invoke(['-Action', 'Export', '-PrivateRoot', owned, '-OutputPath', output, '-AllowOtherNotifications']);
            if (process.env.CHROME_FIXTURE_DIAGNOSTIC === '1') console.log(JSON.stringify({ exportMs: Date.now() - exportStart }));
            console.log(JSON.stringify({ otherSiteRequiresConsent: true, unapprovedFileCreated: false }));
        }
        if (exported.status !== 0) {
            let code = 'FIXTURE_EXPORT_FAILED';
            try { code = JSON.parse(exported.stdout).message.split(':')[0]; } catch { /* fixed diagnostic only */ }
            throw new Error(code);
        }
        const result = parseTransferFile(await fs.readFile(output, 'utf8'));
        if (result.version !== 2 || result.provenance.kind !== (testBrowser === 'brave' ? 'brave-gcm' : 'chrome-gcm') || result.push.p256dhPublicKey !== value.result.value.keys.p256dh
            || result.push.authenticationSecret !== value.result.value.keys.auth) throw new Error('FIXTURE_OUTPUT_MISMATCH');
        console.log(JSON.stringify({ packagedChromeExport: true, actualLevelDb: true, separateProfile: true, noExternalUpload: true }));
        if (process.env.CHROME_FIXTURE_SYNTHETIC_IPC === '1') {
            // Only this disposable profile's locally generated subscription is
            // shared with the parent fixture; never write it to stdout or logs.
            if (typeof process.send !== 'function') throw new Error('FIXTURE_IPC_REQUIRED');
            await new Promise((resolve, reject) => process.send({ browser: testBrowser, transfer: result,
                subscription: value.result.value, vapid }, error => error ? reject(error) : resolve()));
            return;
        }
        if (process.env.CHROME_FIXTURE_LINUX === '1') {
            // The named WSL instance is a disposable fixture. Credentials
            // from this synthetic Chrome profile are passed via stdin only.
            const withDb = process.env.CHROME_FIXTURE_LINUX_DB === '1';
            const probePath = withDb ? '/tmp/cbte-linux-worker/experiments/chrome-push/linux-worker-fixture.cjs'
                : '/tmp/cbte-saved-control/experiments/chrome-push/linux-mcs-fixture.cjs';
            const distro = process.env.CHROME_FIXTURE_LINUX_DISTRO || 'cbte-chrome-compat-20261110';
            if (!/^cbte-[a-z0-9-]+$/.test(distro)) throw new Error('FIXTURE_LINUX_DISTRO_INVALID');
            const probe = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--exec', '/usr/bin/node', probePath],
                { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
            let outputText = '', readyResolve, readyReject, exitResolve;
            const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
            const exited = new Promise(resolve => { exitResolve = resolve; });
            probe.stdin.on('error', () => {});
            probe.stdout.on('data', chunk => {
                outputText += chunk.toString('utf8');
                if (outputText.length > 1024) { probe.kill(); readyReject(new Error('FIXTURE_LINUX_OUTPUT_INVALID')); }
                if (outputText.includes('{"ready":true,"checkin":true}\n')) readyResolve();
            });
            probe.once('error', () => { readyReject(new Error('FIXTURE_LINUX_START_FAILED')); exitResolve(-1); });
            probe.once('exit', code => { if (!outputText.includes('{"ready":true,"checkin":true}\n')) readyReject(new Error('FIXTURE_LINUX_LOGIN_FAILED')); exitResolve(code); });
            const timer = setTimeout(() => { probe.kill(); readyReject(new Error('FIXTURE_LINUX_TIMEOUT')); }, 45000);
            try {
                probe.stdin.end(JSON.stringify(withDb ? result : { credentials: { deviceId: result.push.deviceId, securityToken: result.push.securityToken,
                    clientVersion: result.provenance.engineVersion || result.provenance.browserVersion }, route: { expectedCategory: result.push.productCategory,
                    expectedAppId: result.push.appId, expectedSender: result.push.authorizedEntity } }));
                await ready;
                await webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: 'linux-synthetic',
                    url: 'https://x.com/synthetic/status/1234567890123456792', author: { handle: 'synthetic', id: '12345' } }), { TTL: 60 });
                const expected = withDb ? '{"encryptedReceipt":true,"queuedJobs":1}\n' : '{"encryptedReceipt":true}\n';
                if (await exited !== 0 || !outputText.includes(expected)) throw new Error('FIXTURE_LINUX_RECEIPT_FAILED');
                console.log(JSON.stringify({ linuxWorkerCheckin: true, linuxWorkerEncryptedReceipt: true,
                    ...(withDb ? { isolatedLinuxDatabase: true, queuedJobs: 1 } : {}), isolatedProfile: true, realFcm: true }));
            } finally { clearTimeout(timer); if (probe.exitCode === null) probe.kill(); }
        }
        if (process.env.CHROME_FIXTURE_CHECKIN === '1') {
            const { checkin } = require('../../src/automation/chrome-checkin');
            const checked = await checkin({ deviceId: result.push.deviceId, securityToken: result.push.securityToken,
                browserVersion: result.provenance.engineVersion || result.provenance.browserVersion });
            console.log(JSON.stringify({ syntheticDeviceCheckin: true, realGoogleCheckin: true, intervalSeconds: checked.intervalSeconds }));
        }
        if (process.env.CHROME_FIXTURE_MYSQL_PORT) {
            const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
            const { createXSetup } = require('../../src/automation/x-setup');
            const { createXPushGateway } = require('../../src/automation/x-push-gateway');
            const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
            const { generateKeyPairSync } = require('node:crypto');
            testDb = await createTestDatabase(Number(process.env.CHROME_FIXTURE_MYSQL_PORT));
            const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
            const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: keys.publicKey } });
            const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture', privateKeys: { fixture: keys.privateKey } });
            const setup = createXSetup(testDb, { sealer, chromeEnabled: true, braveEnabled: testBrowser === 'brave', receiverEnabled: true, rolloutMode: 'public' });
            const actor = { userId: '222222222222222222' }, session = await setup.startSession(actor, { consent: true });
            const fileText = await fs.readFile(output, 'utf8');
            const preview = await setup.validate(actor, { sessionId: session.sessionId, fileText });
            if (preview.formatVersion !== 2) throw new Error('FIXTURE_PREVIEW_FAILED');
            const saved = await setup.importFile(actor, { sessionId: session.sessionId, fileText, consent: true });
            let clock = Date.now();
            let foreignFrames = 0, foreignAckAttempts = 0, pingFrames = 0, serverConfirmations = 0, inspectErrors = 0, activeChromeSocket;
            const inspectOther = process.env.CHROME_FIXTURE_OTHER_DELIVERY === '1';
            const inspectBurst = process.env.CHROME_FIXTURE_BURST === '1';
            if (inspectOther && (!otherSubscription || process.env.CHROME_FIXTURE_RUNTIME !== '1')) throw new Error('FIXTURE_OTHER_CONFIG_INVALID');
            if (inspectBurst && process.env.CHROME_FIXTURE_RUNTIME !== '1') throw new Error('FIXTURE_BURST_CONFIG_INVALID');
            const gateway = createXPushGateway(testDb, { enabled: true, chromeEnabled: true, privateWorkerVault: vault,
                rolloutMode: 'public', requestTimeoutMs: 15000, leaseMs: 300000,
                ...(inspectOther || inspectBurst ? { createChromeSocket: () => {
                    const socket = tls.connect({ host: 'mtalk.google.com', port: 443, servername: 'mtalk.google.com', rejectUnauthorized: true });
                    activeChromeSocket = socket;
                    const decoder = require('../../src/automation/chrome-mcs-framing').createFrameDecoder();
                    const write = socket.write.bind(socket);
                    socket.write = (data, ...args) => {
                        if (Buffer.isBuffer(data) && data[0] === 7 && foreignFrames > 0) foreignAckAttempts++;
                        if (Buffer.isBuffer(data) && data[0] === 0) pingFrames++;
                        return write(data, ...args);
                    };
                    socket.on('data', chunk => {
                        try {
                            for (const frame of decoder.push(chunk)) {
                                const protocol = require('../../src/automation/chrome-mcs-protobuf');
                                if ([0, 1, 3, 7, 8].includes(frame.tag) && protocol.lastStreamReceived(frame.tag, frame.payload) > 0) serverConfirmations++;
                                if (frame.tag !== 8) continue;
                                if (protocol.inspectControlMessage(frame.payload)) continue;
                                const message = protocol.dataMessage(frame.payload, {
                                    expectedCategory: result.push.productCategory, expectedAppId: result.push.appId, expectedSender: result.push.authorizedEntity });
                                if (!message.matches) foreignFrames++;
                            }
                        } catch { inspectErrors++; }
                    });
                    return socket;
                } } : {}) });
            const marker = `synthetic-${Date.now()}`, controller = new AbortController(); let matched = false;
            if (process.env.CHROME_FIXTURE_RUNTIME === '1') {
                const entitlements = require('../../src/automation/entitlements');
                const { createQueue } = require('../../src/automation/queue');
                const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
                const admin = { userId: '666666666666666666', isAdmin: true };
                await testDb.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin,
                    { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
                const monitor = await testDb.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
                    [actor.userId, JSON.stringify({ subscriptionId: saved.subscription.id }), clock, clock]);
                await testDb.withDatabaseTransaction(query => entitlements.assignSlot(query, actor.userId, 'x', String(monitor.insertId)));
                const queue = createQueue(testDb, {}, { clock: () => clock, rolloutMode: 'public' });
                const newRuntime = () => createXPushRuntime(testDb, queue, { enabled: true, gateway, clock: () => clock, rolloutMode: 'public',
                    processingPolicy: 'batch', assertAllowed: () => {} });
                let runtime = newRuntime();
                try {
                    await runtime.tick(); let listening = false;
                    for (let i = 0; i < 120 && !listening; i++) {
                        const rows = await testDb.queryDatabase('SELECT state FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]);
                        listening = rows[0]?.state === 'listening'; if (!listening) await pause(250);
                    }
                    if (!listening) throw new Error('FIXTURE_RUNTIME_CONNECT_FAILED');
                    if (inspectOther) {
                        const otherMarker = 'synthetic-foreign-payload';
                        await webpush.sendNotification(otherSubscription, JSON.stringify({ marker: otherMarker }), { TTL: 60 });
                        for (let i = 0; i < 120 && (!foreignFrames || !foreignAckAttempts); i++) await pause(250);
                        if (!foreignFrames || !foreignAckAttempts || inspectErrors) throw new Error('FIXTURE_OTHER_RECEIPT_FAILED');
                        // Allow the gateway to process its ACK before observing
                        // persistence; this payload is never decrypted here.
                        await pause(500);
                        const inbox = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox');
                        const jobs = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_jobs');
                        const audit = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_audit WHERE detail_json LIKE ?', [`%${otherMarker}%`]);
                        if (Number(inbox[0].n) || Number(jobs[0].n) || Number(audit[0].n)) throw new Error('FIXTURE_OTHER_PERSISTED');
                        console.log(JSON.stringify({ foreignPushObservedAndDiscarded: true, foreignInboxRows: 0, foreignJobs: 0, foreignAuditPayloads: 0, realFcm: true }));
                    }
                    await webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: marker,
                        url: 'https://x.com/synthetic/status/1234567890123456789', author: { handle: 'synthetic', id: '12345' } }), { TTL: 60 });
                    let recorded = false;
                    for (let i = 0; i < 120 && !recorded; i++) {
                        const rows = await testDb.queryDatabase("SELECT COUNT(*) n FROM automation_x_push_inbox WHERE status='received'");
                        recorded = Number(rows[0].n) > 0; if (!recorded) await pause(250);
                    }
                    if (!recorded) throw new Error('FIXTURE_RUNTIME_RECEIPT_FAILED');
                    clock += 301000; let jobs = 0;
                    for (let i = 0; i < 20 && !jobs; i++) {
                        await runtime.tick(); const rows = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_jobs');
                        jobs = Number(rows[0].n); if (!jobs) await pause(250);
                    }
                    if (jobs !== 1) throw new Error('FIXTURE_RUNTIME_ROUTE_FAILED');
                    console.log(JSON.stringify({ registeredChromeRuntimeRouted: true, queuedJobs: jobs, isolatedDatabase: true, realFcm: true }));
                    if (process.env.CHROME_FIXTURE_DELIVERY === '1') {
                        const { createTransport } = require('../../src/automation/transport');
                        const { createRunner } = require('../../src/automation/runtime');
                        const { DeliveryGateError } = require('../../src/automation/delivery-gate');
                        const delivered = [], channelId = '444444444444444444', messageId = '555555555555555555';
                        const transport = createTransport(testDb, {}, { options: { jsonTransformer: value => value } }, {
                            clock: () => clock, safety: { assertNotification: async () => {} },
                            rest: { post: async (route, args) => {
                                if (route === '/users/@me/channels') return { id: channelId, recipients: [{ id: actor.userId }] };
                                if (route !== `/channels/${channelId}/messages`) throw new Error('FIXTURE_DELIVERY_ROUTE_INVALID');
                                delivered.push(args.body); return { id: messageId, channel_id: channelId };
                            } },
                            beforeSubmit: async job => {
                                const current = await queue.check(job, clock);
                                if (current.state !== 'ready') throw new DeliveryGateError(current.state, current.code, current.dueAtMs);
                            },
                        });
                        const runner = createRunner(testDb, queue, transport, { clock: () => clock, assertAllowed() {}, notificationAllowed: () => true,
                            sleep: async ms => { clock += ms; } });
                        const sent = await runner.tick();
                        if (sent.state !== 'sent' || delivered.length !== 1 || !delivered[0].content?.includes('https://x.com/synthetic/status/1234567890123456789')
                            || delivered[0].allowed_mentions?.parse?.length !== 0 || delivered[0].enforce_nonce !== true) throw new Error('FIXTURE_DELIVERY_FAILED');
                        if ((await runner.tick()).state !== 'idle' || delivered.length !== 1) throw new Error('FIXTURE_DELIVERY_DUPLICATED');
                        console.log(JSON.stringify({ mockDiscordDmDelivered: true, actualDiscordRequests: 0, duplicateDelivery: false }));
                    }
                    if (inspectBurst) {
                        const count = Number(process.env.CHROME_FIXTURE_BURST_COUNT || 26), previousConfirmations = serverConfirmations, previousPings = pingFrames;
                        if (!Number.isInteger(count) || count < 25 || count > 104) throw new Error('FIXTURE_BURST_CONFIG_INVALID');
                        for (let i = 0; i < count; i++) {
                            await webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: `synthetic-burst-${i}`,
                                url: `https://x.com/synthetic/status/${1234567890123457000n + BigInt(i)}`, author: { handle: 'synthetic', id: '12345' } }), { TTL: 120 });
                            await pause(150);
                        }
                        let rows = [];
                        const wantedPings = Math.floor(count / 25);
                        for (let i = 0; i < 160 && (rows.length < count + 1 || pingFrames - previousPings < wantedPings); i++) {
                            rows = await testDb.queryDatabase('SELECT data_ciphertext,headers_json FROM automation_x_push_inbox WHERE subscription_id=?', [saved.subscription.id]);
                            if (rows.length < count + 1 || pingFrames - previousPings < wantedPings) await pause(250);
                        }
                        if (rows.length !== count + 1 || pingFrames - previousPings < wantedPings || inspectErrors) throw new Error('FIXTURE_BURST_RECEIPT_FAILED');
                        const { pathToFileURL } = require('node:url');
                        const { decryptNotification } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                        const keys = { public_key: [...Buffer.from(result.push.p256dhPublicKey, 'base64url')],
                            private_key: [...Buffer.from(result.push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(result.push.authenticationSecret, 'base64url')] };
                        const texts = rows.map(row => decryptNotification(row.data_ciphertext, JSON.parse(row.headers_json), keys).text);
                        if (new Set(texts.filter(text => typeof text === 'string' && text.startsWith('synthetic-burst-'))).size !== count
                            || Array.from({ length: count }, (_unused, i) => `synthetic-burst-${i}`).some(text => !texts.includes(text))) throw new Error('FIXTURE_BURST_CONTENT_MISMATCH');
                        let pendingCount = count + 1;
                        for (let i = 0; i < 40 && (serverConfirmations === previousConfirmations || pendingCount > 25); i++) {
                            const pending = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_mcs_pending WHERE subscription_id=?', [saved.subscription.id]);
                            pendingCount = Number(pending[0].n);
                            if (serverConfirmations === previousConfirmations || pendingCount > 25) await pause(250);
                        }
                        if (serverConfirmations === previousConfirmations || pendingCount > 25) throw new Error('FIXTURE_BURST_CONFIRM_FAILED');
                        console.log(JSON.stringify({ realFcmBurst: count, encryptedReceipts: rows.length, confirmationRequested: true,
                            serverConfirmedDuringBurst: true, pendingCount, allSyntheticPostsRecovered: true }));
                        if (process.env.CHROME_FIXTURE_BURST_RECONNECT === '1') {
                            const before = (await testDb.queryDatabase('SELECT last_connected_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]))[0];
                            const oldSocket = activeChromeSocket;
                            if (!oldSocket || oldSocket.destroyed) throw new Error('FIXTURE_RECONNECT_SOCKET_INVALID');
                            clock = Date.now(); oldSocket.destroy();
                            let disconnected = false;
                            for (let i = 0; i < 120 && !disconnected; i++) {
                                const state = (await testDb.queryDatabase('SELECT state FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]))[0];
                                disconnected = runtime.status().sessions === 0 && state?.state !== 'listening';
                                if (!disconnected) await pause(100);
                            }
                            if (!disconnected) throw new Error('FIXTURE_DISCONNECT_TIMEOUT');
                            await webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: 'synthetic-during-disconnect',
                                url: 'https://x.com/synthetic/status/1234567890123457998', author: { handle: 'synthetic', id: '12345' } }), { TTL: 120 });
                            let reconnected = false;
                            for (let i = 0; i < 180 && !reconnected; i++) {
                                clock = Date.now(); await runtime.tick();
                                const state = (await testDb.queryDatabase('SELECT state,last_connected_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]))[0];
                                reconnected = state?.state === 'listening' && Number(state.last_connected_at_ms) > Number(before.last_connected_at_ms)
                                    && activeChromeSocket !== oldSocket;
                                if (!reconnected) await pause(250);
                            }
                            if (!reconnected) throw new Error('FIXTURE_BURST_RECONNECT_FAILED');
                            let offlineRows = [];
                            for (let i = 0; i < 120 && offlineRows.length < count + 2; i++) {
                                offlineRows = await testDb.queryDatabase('SELECT data_ciphertext,headers_json FROM automation_x_push_inbox WHERE subscription_id=?', [saved.subscription.id]);
                                if (offlineRows.length < count + 2) await pause(250);
                            }
                            if (offlineRows.length !== count + 2 || !offlineRows.some(row =>
                                decryptNotification(row.data_ciphertext, JSON.parse(row.headers_json), keys).text === 'synthetic-during-disconnect'))
                                throw new Error('FIXTURE_OFFLINE_RECEIPT_FAILED');
                            await webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: 'synthetic-after-disconnect',
                                url: 'https://x.com/synthetic/status/1234567890123457999', author: { handle: 'synthetic', id: '12345' } }), { TTL: 60 });
                            let postReconnectRows = [];
                            for (let i = 0; i < 120 && postReconnectRows.length < count + 3; i++) {
                                postReconnectRows = await testDb.queryDatabase('SELECT data_ciphertext,headers_json FROM automation_x_push_inbox WHERE subscription_id=?', [saved.subscription.id]);
                                if (postReconnectRows.length < count + 3) await pause(250);
                            }
                            if (postReconnectRows.length !== count + 3 || !postReconnectRows.some(row =>
                                decryptNotification(row.data_ciphertext, JSON.parse(row.headers_json), keys).text === 'synthetic-after-disconnect'))
                                throw new Error('FIXTURE_RECONNECT_RECEIPT_FAILED');
                            clock = Date.now();
                            await testDb.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?',
                                [clock - 301000, saved.subscription.id]);
                            let offlineJobs = 0;
                            for (let i = 0; i < 40 && offlineJobs === 0; i++) {
                                await runtime.tick();
                                const matches = await testDb.queryDatabase("SELECT COUNT(*) n FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE r.event_json LIKE ?", ['%synthetic-during-disconnect%']);
                                offlineJobs = Number(matches[0].n); if (!offlineJobs) await pause(250);
                            }
                            if (offlineJobs !== 1) throw new Error('FIXTURE_OFFLINE_ROUTE_FAILED');
                            console.log(JSON.stringify({ abruptSocketDisconnect: true, automaticReconnect: true, priorReceiptsPreserved: count + 1,
                                offlineReceiptAfterReconnect: true, offlineJobCreated: true, newReceiptAfterReconnect: true, duplicateRows: 0, realFcm: true }));
                        }
                    }
                    if (process.env.CHROME_FIXTURE_REOPEN === '1') {
                        // The dedicated profile alone is reopened. Export closes
                        // it again, after which the same imported receiver must
                        // reconnect and route another synthetic notification.
                        await openPrivateBrowser();
                        let priorReceipts = Number((await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n);
                        if (process.env.CHROME_FIXTURE_BLOCK_MCS === '1') {
                            const beforeBrowserEvents = browserPushEvents;
                            await webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: marker + '-browser-open',
                                url: 'https://x.com/synthetic/status/1234567890123456791', author: { handle: 'synthetic', id: '12345' } }), { TTL: 120 });
                            let duringOpen = false;
                            for (let i = 0; i < 120 && !duringOpen; i++) {
                                await runtime.tick();
                                const rows = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox');
                                duringOpen = Number(rows[0].n) > priorReceipts; if (!duringOpen) await pause(250);
                            }
                            if (!duringOpen) throw new Error('FIXTURE_OPEN_BROWSER_RECEIPT_FAILED');
                            await pause(5000);
                            if (browserPushEvents !== beforeBrowserEvents) throw new Error('FIXTURE_BROWSER_RECEIVED_PUSH');
                            priorReceipts++;
                            console.log(JSON.stringify({ receivedWhileSetupBrowserOpen: true, browserPushEvents: 0, syntheticProfile: true, realFcm: true }));
                        }
                        const secondOutput = path.join(root, 'notification-reopened.json');
                        const secondExport = invoke(['-Action', 'Export', '-PrivateRoot', owned, '-OutputPath', secondOutput, '-AllowOtherNotifications']);
                        if (secondExport.status !== 0) throw new Error('FIXTURE_REOPEN_EXPORT_FAILED');
                        if (process.env.CHROME_FIXTURE_REIMPORT === '1') {
                            const before = (await testDb.queryDatabase('SELECT last_connected_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]))[0];
                            const newSession = await setup.startSession(actor, { consent: true });
                            const repeated = await setup.importFile(actor, { sessionId: newSession.sessionId, fileText: await fs.readFile(secondOutput, 'utf8'), consent: true });
                            if (!repeated.duplicate || repeated.subscription.id !== saved.subscription.id) throw new Error('FIXTURE_REIMPORT_IDENTITY_FAILED');
                            let reconnected = false;
                            for (let i = 0; i < 120 && !reconnected; i++) {
                                await runtime.tick();
                                const rows = await testDb.queryDatabase('SELECT state,last_connected_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]);
                                reconnected = rows[0]?.state === 'listening' && Number(rows[0].last_connected_at_ms) > Number(before.last_connected_at_ms);
                                if (!reconnected) await pause(250);
                            }
                            if (!reconnected) throw new Error('FIXTURE_REIMPORT_RECONNECT_FAILED');
                            console.log(JSON.stringify({ reimportRequestedReconnect: true, originalSubscriptionPreserved: true }));
                        }
                        if (process.env.CHROME_FIXTURE_FORCE_RECONNECT === '1') {
                            await runtime.stop(); runtime = newRuntime(); await runtime.tick();
                            let ready = false;
                            for (let i = 0; i < 120 && !ready; i++) {
                                const rows = await testDb.queryDatabase('SELECT state FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]);
                                ready = rows[0]?.state === 'listening'; if (!ready) await pause(250);
                            }
                            if (!ready) throw new Error('FIXTURE_RECONNECT_FAILED');
                        }
                        if (process.env.CHROME_FIXTURE_REOPEN_WAIT === '1') {
                            let last = '';
                            for (let i = 0; i < 20; i++) {
                                clock += 1000; await runtime.tick();
                                const rows = await testDb.queryDatabase('SELECT state,reason_code,retry_attempt FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]);
                                const state = JSON.stringify(rows[0]);
                                if (state !== last) { console.log(JSON.stringify({ reopenTransition: rows[0] })); last = state; }
                                await pause(1000);
                            }
                        }
                        await webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: marker + '-reopened',
                            url: 'https://x.com/synthetic/status/1234567890123456790', author: { handle: 'synthetic', id: '12345' } }), { TTL: 120 });
                        let recovered = false;
                        for (let i = 0; i < 160 && !recovered; i++) {
                            clock += 1000; await runtime.tick();
                            const rows = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox');
                            recovered = Number(rows[0].n) > priorReceipts;
                            if (!recovered) await pause(250);
                        }
                        if (!recovered) {
                            if (process.env.CHROME_FIXTURE_DIAGNOSTIC === '1') {
                                const states = await testDb.queryDatabase('SELECT state,reason_code,retry_at_ms,retry_attempt FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]);
                                const counts = await testDb.queryDatabase('SELECT status,COUNT(*) n FROM automation_x_push_inbox GROUP BY status');
                                console.error(JSON.stringify({ fixtureReceiver: states[0], fixtureInbox: counts, fixtureRuntime: runtime.status() }));
                            }
                            throw new Error('FIXTURE_REOPEN_RECEIPT_FAILED');
                        }
                        // Advance the disposable DB's last batch time to model
                        // five elapsed minutes without delaying the fixture.
                        await testDb.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [Date.now() - 301000, saved.subscription.id]);
                        clock += 301000;
                        const expectedJobs = process.env.CHROME_FIXTURE_BLOCK_MCS === '1' ? 3 : 2;
                        for (let i = 0; i < 40 && jobs < expectedJobs; i++) {
                            await runtime.tick(); const rows = await testDb.queryDatabase('SELECT COUNT(*) n FROM automation_jobs');
                            jobs = Number(rows[0].n); if (jobs < expectedJobs) await pause(250);
                        }
                        if (jobs !== expectedJobs) {
                            if (process.env.CHROME_FIXTURE_DIAGNOSTIC === '1') {
                                const states = await testDb.queryDatabase('SELECT state,reason_code,last_process_at_ms,process_window_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [saved.subscription.id]);
                                const counts = await testDb.queryDatabase('SELECT status,COUNT(*) n FROM automation_x_push_inbox GROUP BY status');
                                console.error(JSON.stringify({ fixtureReceiver: states[0], fixtureInbox: counts, jobs, fixtureRuntime: runtime.status() }));
                            }
                            throw new Error('FIXTURE_REOPEN_ROUTE_FAILED');
                        }
                        console.log(JSON.stringify({ reopenedBrowserRecovered: true, queuedJobs: jobs, isolatedDatabase: true, realFcm: true }));
                    }
                } finally { await runtime.stop(); }
                return;
            }
            const timer = setTimeout(() => controller.abort(), 40000);
            try {
                await gateway.run({ subscriptionId: saved.subscription.id, ownerUserId: actor.userId, workerId: 'packaged-e2e', signal: controller.signal,
                    onSession: () => webpush.sendNotification(value.result.value, JSON.stringify({ notificationType: 'tweet', text: marker,
                        url: 'https://x.com/synthetic/status/123', author: { handle: 'synthetic', id: '123' } }), { TTL: 60 }),
                    onReceived: ({ payload }) => { if (payload.text === marker) { matched = true; controller.abort(); } } });
            } finally { clearTimeout(timer); }
            if (!matched) throw new Error('FIXTURE_GATEWAY_DELIVERY_FAILED');
            console.log(JSON.stringify({ exportedFileImportedAndReceived: true, isolatedDatabase: true, realFcm: true }));
        }
    } finally {
        await cdp?.close().catch(() => {});
        if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
        await stopOwnedBrokers(root);
        if (server) await new Promise(resolve => server.close(resolve));
        await testDb?.close();
        await removeOwnedFixture(root, temp);
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
