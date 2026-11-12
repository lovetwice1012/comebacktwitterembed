'use strict';

// Disposable GitHub-hosted macOS only: synthetic local origin and profile.
// Real user profiles, X, notification payloads and credentials are never logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const webpush = require('web-push');
const { createMacBraveProfile, createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
require('../../src/automation/brave-mac-browser');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { captureFromBroker } = require('../../src/automation/chrome-broker-client');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { withMacBraveSnapshot } = require('../../src/automation/chrome-mac-snapshot');
const { withMacBraveKeychainPassword } = require('../../src/automation/chrome-mac-keychain');
const { decryptMacChromiumDeviceToken } = require('../../src/automation/chrome-mac-token-crypto');
const { readEncryptionData } = require('../../src/automation/chrome-mcs-protobuf');
const { receiveSyntheticMacPush } = require('./chrome-mac-synthetic-receive.cjs');
const { classifyPushError, formatSuppressedPushFailure } = require('./chrome-mac-push-error.cjs');
const { probeAfterGone } = require('./chrome-mac-push-probe.cjs');
const { snapshotBraveInstallation, diagnoseBraveInstallation } = require('./brave-mac-install-diagnostic.cjs');
const { createInstrumentedBraveVerifier } = require('./brave-mac-verifier-diagnostic.cjs');
const { buildSyntheticBraveMacTransfer } = require('./brave-mac-synthetic-transfer.cjs');
const { writeExperimentalMacBraveExport } = require('../../src/automation/brave-mac-private-export');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
const { verifySyntheticMacDatabaseTransfer } = require('./chrome-mac-synthetic-db.cjs');

function fixturePipe(child) {
    let id = 0, buffer = Buffer.alloc(0); const pending = new Map();
    const rejectAll = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('FIXTURE_PIPE_CLOSED')); } pending.clear(); };
    child.stdio[4].on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 1024 * 1024) return rejectAll();
        for (;;) {
            const end = buffer.indexOf(0); if (end < 0) break;
            const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
            let message; try { message = JSON.parse(frame.toString('utf8')); } catch { return rejectAll(); }
            const entry = pending.get(message.id); if (!entry) continue;
            pending.delete(message.id); clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error('FIXTURE_CDP_ERROR')); else entry.resolve(message.result);
        }
    });
    child.on('exit', rejectAll); child.on('error', rejectAll); child.stdio[3].on('error', rejectAll); child.stdio[4].on('error', rejectAll);
    return (method, params = {}, sessionId, timeout = 30000) => new Promise((resolve, reject) => {
        const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error('FIXTURE_CDP_TIMEOUT')); }, timeout);
        pending.set(next, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
}

test('signed Mac Brave isolates its profile and hands synthetic push to the worker',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_BRAVE_HOSTED !== '1', timeout: 540000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-brave-push-hosted-'));
        const launched = []; let broker, server, profile, credentials, realBroker, realBrokerAttempted = false, realBrokerReleased = false;
        const spawnOwned = (file, args, options) => {
            const child = spawn(file, args, { ...options, detached: true });
            const entry = { child, closed: false, close: null };
            entry.close = new Promise(resolve => child.once('close', () => { entry.closed = true; resolve(); }));
            launched.push(entry); return child;
        };
        t.after(async () => {
            if (realBroker && !realBrokerReleased) try { realBroker.chrome.kill('SIGTERM'); } catch { /* Retain on uncertainty. */ }
            for (const entry of launched) if (!entry.closed) try { entry.child.kill('SIGTERM'); } catch { /* Retain on uncertainty. */ }
            let stopped = true;
            for (const entry of launched) {
                let timer;
                const closed = entry.closed || await Promise.race([entry.close.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
                clearTimeout(timer);
                if (!closed || !entry.child.pid || !await waitForMacProcessGroupExit(entry.child.pid)) stopped = false;
            }
            if (broker) await broker.stop().catch(() => { stopped = false; });
            if (realBroker) await realBroker.stop().catch(() => { stopped = false; });
            if (realBrokerAttempted && !realBrokerReleased) stopped = false;
            if (server) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
            if (stopped) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-brave-push-hosted-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(stopped, true, 'synthetic profile retained because browser shutdown was not confirmed');
        });
        const chrome = await createMacChromeProfile(base); profile = await createMacBraveProfile(base);
        assert.notEqual(profile.rootPath, chrome.rootPath); assert.notEqual(profile.profilePath, chrome.profilePath);
        const chromeSentinel = path.join(chrome.profilePath, 'synthetic-preserve');
        await fs.writeFile(chromeSentinel, 'unchanged', { flag: 'wx', mode: 0o600 });
        const preferencesFile = path.join(profile.profilePath, 'Default', 'Preferences');
        assert.equal(JSON.parse(await fs.readFile(preferencesFile, 'utf8')).brave.gcm.channel_status, true);
        const installationBefore = await snapshotBraveInstallation(); let installed;
        const verifyInstalledMacBrave = await createInstrumentedBraveVerifier(t);
        try { installed = await verifyInstalledMacBrave(); }
        catch (error) { await diagnoseBraveInstallation(t, installationBefore); throw error; }
        assert.equal(installed.browserVersion, '156.1.98.63', 'pinned synthetic Brave version mismatch');
        const vapid = webpush.generateVAPIDKeys();
        let browserDeliveries = 0;
        server = http.createServer((req, res) => {
            if (req.url === '/sw.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
                res.end("self.addEventListener('push',e=>e.waitUntil((async()=>{await fetch('/received');await self.registration.showNotification('Synthetic fixture')})()));");
            } else if (req.url === '/received') { browserDeliveries++; res.end('ok'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end('<!doctype html><title>Synthetic push fixture</title>'); }
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const child = spawnOwned(installed.executable, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile.profilePath}`,
            '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        const call = fixturePipe(child), version = await call('Browser.getVersion');
        assert.match(version.product, /^Chrome\/[0-9]+(?:\.[0-9]+){3}$/); const engineVersion = version.product.slice(7);
        assert.equal(engineVersion, '156.0.8078.80', 'pinned synthetic Chromium version mismatch');
        t.diagnostic('synthetic Brave bundle version=156.1.98.63 Chromium=156.0.8078.80');
        await call('Browser.grantPermissions', { origin, permissions: ['notifications'] });
        const target = await call('Target.createTarget', { url: origin });
        const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        for (let attempt = 0; attempt < 30; attempt++) {
            const page = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, attached.sessionId);
            if (page.result?.value === origin) break;
            if (attempt === 29) throw new Error('FIXTURE_PAGE_TIMEOUT');
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        const expression = `(async()=>{const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;` +
            `return(await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:${JSON.stringify(vapid.publicKey)}})).toJSON()})()`;
        const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId, 120000);
        if (response.exceptionDetails) throw new Error('FIXTURE_SUBSCRIBE_FAILED');
        const subscriptionTime = performance.now(), elapsedMs = () => Math.max(0, Math.round(performance.now() - subscriptionTime));
        const subscription = response.result?.value;
        assert.ok(/^https:\/\/fcm\.googleapis\.com\//.test(subscription?.endpoint || ''), 'unexpected synthetic provider');
        assert.equal(typeof subscription.keys?.p256dh, 'string'); assert.equal(typeof subscription.keys?.auth, 'string');
        webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
        const initialSendTime = elapsedMs(); let initialSendFailed = false;
        try { await webpush.sendNotification(subscription, 'baseline', { TTL: 60, timeout: 15000 }); }
        catch (error) {
            const category = classifyPushError(error); initialSendFailed = true;
            t.diagnostic(`initial synthetic Brave send=${category}`);
            t.diagnostic(`initial synthetic Brave send timing sinceSubscriptionMs=${initialSendTime} durationMs=${elapsedMs() - initialSendTime}`);
            if (!category.startsWith('410_')) throw new Error(`FIXTURE_BASELINE_SEND_${category}`);
            const current = await call('Runtime.evaluate', { expression: `(async()=>{const r=await navigator.serviceWorker.ready;const s=await r.pushManager.getSubscription();return s?s.toJSON():null})()`,
                awaitPromise: true, returnByValue: true }, attached.sessionId);
            const currentValue = current.result?.value;
            t.diagnostic(`synthetic Brave subscription still present=${Boolean(currentValue)} unchanged=${Boolean(currentValue && currentValue.endpoint === subscription.endpoint)}`);
            const comparison = await probeAfterGone({ send: () => webpush.sendNotification(subscription, 'baseline-recheck', { TTL: 60, timeout: 15000 }),
                sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), elapsedMs,
                report: event => t.diagnostic(`synthetic Brave recheck attempt=${event.attempt} sinceSubscriptionMs=${event.sinceSubscriptionMs} durationMs=${event.durationMs} result=${event.result}`) });
            if (!comparison.accepted) throw new Error(`FIXTURE_BASELINE_SEND_${category}`);
            t.diagnostic('continuing synthetic Brave checks after diagnostic retry; the initial failure remains a failing result');
        }
        for (let i = 0; i < 100 && browserDeliveries === 0; i++) await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(browserDeliveries, 1, 'baseline synthetic push was not delivered to Brave');
        await call('Browser.close').catch(() => {});
        let timer;
        const closed = await Promise.race([launched[0].close.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
        clearTimeout(timer); assert.equal(closed, true); assert.equal(await waitForMacProcessGroupExit(child.pid), true);
        const helper = process.env.MAC_LOCK_HELPER; assert.equal(typeof helper, 'string');
        const expectedSha256 = createHash('sha256').update(await fs.readFile(helper)).digest('hex');
        await withMacBraveKeychainPassword({ confirmed: true, work: password => withMacBraveSnapshot({ rootPath: profile.rootPath,
            profileId: profile.profileId, helperPath: helper, expectedSha256, work: async snapshot => {
                const preferences = JSON.parse(await fs.readFile(path.join(snapshot.snapshotPath, 'Default', 'Preferences'), 'utf8'));
                assert.equal(preferences.brave?.gcm?.channel_status, true, 'synthetic Brave Push setting was not retained');
                assert.equal(preferences.gcm?.product_category_for_subtypes, 'com.brave.macosx', 'observed Brave product category differs');
                const mappings = Object.entries(preferences.gcm?.push_messaging_application_id_map || {})
                    .filter(([, scope]) => typeof scope === 'string' && scope.split('#')[0] === origin + '/');
                assert.equal(mappings.length, 1, 'local subscription mapping was not unique');
                const appId = mappings[0][0], store = path.join(snapshot.snapshotPath, 'Default', 'GCM Store');
                const deviceDb = new ClassicLevel(store, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                const keyDb = new ClassicLevel(path.join(store, 'Encryption'), { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                try {
                    await deviceDb.open(); await keyDb.open();
                    const deviceId = (await deviceDb.get('device_aid_key')).toString('utf8');
                    const securityToken = decryptMacChromiumDeviceToken(await deviceDb.get('device_token_key'), password);
                    assert.ok(/^[1-9][0-9]*$/.test(deviceId) && /^[1-9][0-9]*$/.test(securityToken), 'invalid synthetic device credentials');
                    const records = [];
                    for await (const [key, value] of keyDb.iterator({ gte: appId, lt: appId + '\uffff', limit: 5 })) records.push({ key, value });
                    assert.equal(records.length, 1);
                    const encryption = readEncryptionData(records[0].value, { expectedAppId: appId,
                        expectedPublicKey: Buffer.from(subscription.keys.p256dh, 'base64url'), expectedAuthSecret: Buffer.from(subscription.keys.auth, 'base64url') });
                    assert.ok(records[0].key === `${appId},${encryption.authorizedEntity}`, 'synthetic subscription key did not match');
                    credentials = { deviceId, securityToken, appId, category: preferences.gcm.product_category_for_subtypes, encryption };
                } finally { await keyDb.close().catch(() => {}); await deviceDb.close().catch(() => {}); }
            } }) });
        t.diagnostic('synthetic Brave category, device token and subscription keys matched the private snapshot; credentials omitted');
        // Adapt only the fixture's loopback subscription in memory. Production
        // intake remains closed for Mac Brave, including this synthetic file.
        const transfer = buildSyntheticBraveMacTransfer({ origin, subscription, ...credentials,
            browserVersion: installed.browserVersion, engineVersion });
        const exportDir = path.join(base, 'synthetic-export'); await fs.mkdir(exportDir, { mode: 0o700 });
        const exportName = 'synthetic-brave-notifications.json', exportPath = path.join(exportDir, exportName);
        await assert.rejects(writeExperimentalMacBraveExport({ directory: exportDir, filename: exportName, file: transfer.file,
            confirmed: true, otherSubscriptionCount: 1, otherSitesConsent: false, experimental: true }), { code: 'X_BRAVE_MAC_EXPORT_INVALID' });
        await assert.rejects(fs.access(exportPath), { code: 'ENOENT' });
        const exported = await writeExperimentalMacBraveExport({ directory: exportDir, filename: exportName, file: transfer.file,
            confirmed: true, otherSubscriptionCount: transfer.otherSubscriptionCount, otherSitesConsent: true, experimental: true });
        assert.equal(exported.uploaded, false); assert.equal(exported.encrypted, false);
        const stat = await fs.lstat(exportPath);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1);
        const fileText = await fs.readFile(exportPath, 'utf8');
        let matches = false;
        try { matches = JSON.stringify(JSON.parse(fileText)) === JSON.stringify(transfer.file); } catch { /* Never log file contents. */ }
        assert.ok(matches, 'synthetic file contents did not match');
        assert.throws(() => parseTransferFile(fileText), { code: 'X_SETUP_INVALID_FILE' });
        t.diagnostic('synthetic Brave transfer saved privately; production parser correctly remains closed');
        // The setup broker uses the same receive-suppression flags as Windows.
        broker = await startChromeBroker({ chromePath: installed.executable, profilePath: profile.profilePath, origin,
            pipeTimeoutMs: 30000, extraArgs: ['--headless=new', '--no-proxy-server'], spawnChrome: spawnOwned });
        const before = browserDeliveries;
        const suppressedSendTime = elapsedMs();
        try { await webpush.sendNotification(subscription, 'suppressed', { TTL: 60, timeout: 15000 }); }
        catch (error) {
            t.diagnostic(formatSuppressedPushFailure(error, suppressedSendTime, elapsedMs() - suppressedSendTime));
            throw new Error('FIXTURE_SUPPRESSED_SEND_FAILED');
        }
        await new Promise(resolve => setTimeout(resolve, 10000));
        assert.equal(browserDeliveries, before, 'setup Brave consumed a synthetic push while suppression was enabled');
        if (process.env.CBTE_MAC_DB_FIXTURE === '1') {
            await verifySyntheticMacDatabaseTransfer(transfer.file, database => receiveSyntheticMacPush({ subscription, vapid, ...credentials,
                browserVersion: engineVersion, database }), { fileText, braveMac: true });
            t.diagnostic('synthetic Brave file reached isolated HTTP intake, encrypted database, MCS and notification queue');
        } else await receiveSyntheticMacPush({ subscription, vapid, ...credentials, browserVersion: engineVersion });
        await new Promise(resolve => setTimeout(resolve, 3000));
        assert.equal(browserDeliveries, before, 'setup Brave consumed a synthetic push while worker was connected');
        t.diagnostic('synthetic push reached MCS while the dedicated setup Brave was open; browser delivery was not observed');
        const captured = await captureFromBroker({ port: broker.port, token: broker.token });
        assert.ok(captured.endpoint === subscription.endpoint && captured.keys.p256dh === subscription.keys.p256dh
            && captured.keys.auth === subscription.keys.auth, 'synthetic captured subscription did not match');
        assert.equal(await fs.readFile(chromeSentinel, 'utf8'), 'unchanged');
        assert.deepEqual(await fs.readdir(chrome.profilePath), ['synthetic-preserve']);
        const setupEntry = launched[launched.length - 1];
        let setupTimer;
        const setupClosed = setupEntry.closed || await Promise.race([setupEntry.close.then(() => true),
            new Promise(resolve => { setupTimer = setTimeout(() => resolve(false), 15000); })]);
        clearTimeout(setupTimer); assert.equal(setupClosed, true);
        assert.equal(await waitForMacProcessGroupExit(setupEntry.child.pid), true);
        await broker.stop();
        // Exercise the actual signed Brave broker and its lease; replace only
        // the startup origin in memory so this test never opens X.
        const privatePath = require.resolve('../../src/automation/chrome-private-broker');
        const bravePath = require.resolve('../../src/automation/brave-mac-broker');
        const browserPath = require.resolve('../../src/automation/brave-mac-browser');
        const privateModule = require.cache[privatePath], previousExports = privateModule.exports, previousBrave = require.cache[bravePath];
        const browserModule = require.cache[browserPath], previousBrowser = browserModule.exports;
        try {
            privateModule.exports = { ...previousExports, startChromeBroker: options => previousExports.startChromeBroker({ ...options, origin,
                extraArgs: ['--headless=new', '--no-proxy-server'] }) };
            browserModule.exports = { ...previousBrowser, verifyInstalledMacBrave };
            delete require.cache[bravePath];
            const { startMacBraveBroker } = require(bravePath);
            realBrokerAttempted = true;
            try { realBroker = await startMacBraveBroker({ rootPath: profile.rootPath, profileId: profile.profileId }); }
            catch (error) { await diagnoseBraveInstallation(t, installationBefore); throw error; }
            assert.equal(realBroker.pushChannelStatus, 'enabled');
            await fs.access(path.join(profile.rootPath, 'broker.lock'));
            await realBroker.closeBrowser();
            realBrokerReleased = await realBroker.releaseComplete === true;
            assert.equal(realBrokerReleased, true, 'Brave broker did not confirm process group shutdown');
            await assert.rejects(fs.access(path.join(profile.rootPath, 'broker.lock')), { code: 'ENOENT' });
            t.diagnostic('signed Brave broker released its profile lock after the process group stopped');
        } finally {
            privateModule.exports = previousExports;
            browserModule.exports = previousBrowser;
            if (previousBrave) require.cache[bravePath] = previousBrave; else delete require.cache[bravePath];
        }
        credentials = null;
        assert.equal(initialSendFailed, false, 'initial synthetic Brave push failed despite diagnostic recovery');
    });
