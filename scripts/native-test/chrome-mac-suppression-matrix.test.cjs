'use strict';

// Every case runs on a separate disposable hosted Mac with its own local
// origin, profile, Keychain, VAPID key and FCM subscription. No real X or
// user browser data is involved, and notification contents are never logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const webpush = require('web-push');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { verifyInstalledChrome } = require('../../src/automation/chrome-mac-broker');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { withMacChromeSnapshot } = require('../../src/automation/chrome-mac-snapshot');
const { withMacChromeKeychainPassword } = require('../../src/automation/chrome-mac-keychain');
const { decryptMacChromiumDeviceToken } = require('../../src/automation/chrome-mac-token-crypto');
const { readEncryptionData } = require('../../src/automation/chrome-mcs-protobuf');
const { receiveExpectedSyntheticPush } = require('./chrome-mac-suppression-receive.cjs');
const { classifyPushError } = require('./chrome-mac-push-error.cjs');
const { sendSyntheticBaseline } = require('./chrome-mac-suppression-baseline.cjs');

const OLD = '--host-resolver-rules=MAP mtalk.google.com ~NOTFOUND';
const NEW = '--host-resolver-rules=MAP mtalk.google.com ^NOTFOUND';
const LOOPBACK = '--gcm-mcs-endpoint=https://127.0.0.1:1';
const CASES = Object.freeze({ none: [], old_resolver: [OLD], new_resolver: [NEW], endpoint: [LOOPBACK], combined: [LOOPBACK, OLD] });
function flagsFor(name) {
    if (typeof name !== 'string' || !Object.hasOwn(CASES, name)) throw new Error('FIXTURE_CASE_INVALID');
    return [...CASES[name]];
}
test('suppression matrix isolates the two resolver rules and MCS endpoint', () => {
    assert.deepEqual(flagsFor('none'), []);
    assert.deepEqual(flagsFor('old_resolver'), [OLD]); assert.deepEqual(flagsFor('new_resolver'), [NEW]);
    assert.deepEqual(flagsFor('endpoint'), [LOOPBACK]); assert.deepEqual(flagsFor('combined'), [LOOPBACK, OLD]);
    assert.throws(() => flagsFor('constructor'), /FIXTURE_CASE_INVALID/);
    assert.throws(() => flagsFor('other'), /FIXTURE_CASE_INVALID/);
});

function fixturePipe(child) {
    let id = 0, buffer = Buffer.alloc(0); const pending = new Map();
    const rejectAll = () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('FIXTURE_PIPE_CLOSED')); } pending.clear(); };
    child.stdio[4].on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 1024 * 1024) return rejectAll();
        for (;;) {
            const end = buffer.indexOf(0); if (end < 0) break;
            const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
            let value; try { value = JSON.parse(frame.toString('utf8')); } catch { return rejectAll(); }
            const entry = pending.get(value.id); if (!entry) continue;
            pending.delete(value.id); clearTimeout(entry.timer);
            if (value.error) entry.reject(new Error('FIXTURE_CDP_FAILED')); else entry.resolve(value.result);
        }
    });
    child.on('exit', rejectAll); child.on('error', rejectAll); child.stdio[3].on('error', rejectAll); child.stdio[4].on('error', rejectAll);
    return (method, params = {}, sessionId, timeout = 30000) => new Promise((resolve, reject) => {
        const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error('FIXTURE_CDP_TIMEOUT')); }, timeout);
        pending.set(requestId, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
}
async function waitFor(value, timeoutMs) {
    let timer; try { return await Promise.race([value, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
}

test('hosted Chrome isolates synthetic Push suppression mechanisms',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_SUPPRESSION_HOSTED !== '1', timeout: 540000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const caseName = process.env.CBTE_MAC_SUPPRESSION_CASE, flags = flagsFor(caseName);
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-chrome-suppression-'));
        const children = [], observed = new Set(), expectedMarkers = new Set(); let server, credentials, initialBaselineFailed = false, subscriptionStartedAt = 0;
        let stage = 'setup';
        const spawnOwned = (file, args, options) => {
            const child = spawn(file, args, { ...options, detached: true });
            const entry = { child, closed: false, close: null };
            entry.close = new Promise(resolve => child.once('close', () => { entry.closed = true; resolve(true); }));
            children.push(entry); return entry;
        };
        t.after(async () => {
            for (const entry of children) if (!entry.closed) try { entry.child.kill('SIGTERM'); } catch { /* Keep fixture on uncertainty. */ }
            let stopped = true;
            for (const entry of children) {
                const closed = entry.closed || await waitFor(entry.close, 20000);
                if (!closed || !entry.child.pid || !await waitForMacProcessGroupExit(entry.child.pid)) stopped = false;
            }
            if (server) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
            if (stopped) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-chrome-suppression-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(stopped, true, 'synthetic profile retained because browser shutdown was not confirmed');
        });
        try {
            server = http.createServer((request, response) => {
                if (request.url === '/sw.js') {
                    response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
                    response.end("self.addEventListener('push',e=>e.waitUntil((async()=>{const x=e.data?e.data.text():'';await fetch('/delivered?tag='+encodeURIComponent(x));await self.registration.showNotification('Synthetic fixture')})()));");
                } else if (request.url?.startsWith('/delivered?tag=')) {
                    const marker = request.url.slice('/delivered?tag='.length);
                    if (expectedMarkers.has(marker)) observed.add(marker);
                    response.writeHead(200).end('ok');
                } else { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end('<!doctype html><title>Synthetic fixture</title>'); }
            });
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
            const origin = `http://127.0.0.1:${server.address().port}`, profile = await createMacChromeProfile(base);
            const executable = await verifyInstalledChrome(), vapid = webpush.generateVAPIDKeys();
            let subscription, browserVersion;
            async function launch(caseFlags) {
                const entry = spawnOwned(executable, ['--headless=new', '--remote-debugging-pipe', '--enable-automation',
                    `--user-data-dir=${profile.profilePath}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
                    '--no-proxy-server', ...caseFlags, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
                const call = fixturePipe(entry.child), version = await call('Browser.getVersion');
                assert.match(version.product, /^Chrome\/[0-9]+(?:\.[0-9]+){3}$/);
                const currentVersion = version.product.slice(7);
                if (browserVersion && currentVersion !== browserVersion) throw new Error('FIXTURE_BROWSER_VERSION_CHANGED');
                if (!browserVersion) t.diagnostic(`synthetic browser engineVersion=${currentVersion}`);
                browserVersion = currentVersion;
                const command = await call('Browser.getBrowserCommandLine');
                assert.deepEqual(command.arguments.filter(value => value.startsWith('--host-resolver-rules=') || value.startsWith('--gcm-mcs-endpoint=')).sort(), [...caseFlags].sort());
                await call('Browser.grantPermissions', { origin, permissions: ['notifications'] });
                const target = await call('Target.createTarget', { url: origin });
                const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                for (let i = 0; i < 100; i++) {
                    const page = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, attached.sessionId);
                    if (page.result?.value === origin) return { entry, call, sessionId: attached.sessionId };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                throw new Error('FIXTURE_PAGE_TIMEOUT');
            }
            async function closeBrowser(instance) {
                await instance.call('Browser.close').catch(() => {});
                assert.equal(instance.entry.closed || await waitFor(instance.entry.close, 20000), true, 'synthetic browser did not close');
                assert.equal(await waitForMacProcessGroupExit(instance.entry.child.pid), true, 'synthetic browser group did not stop');
            }
            async function sendAndObserve(label) {
                const marker = `fixture-${randomBytes(16).toString('hex')}`; expectedMarkers.add(marker);
                const send = () => webpush.sendNotification(subscription, marker, { TTL: 300, timeout: 15000 });
                if (label === 'BASELINE') {
                    const outcome = await sendSyntheticBaseline({ send, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
                        elapsedMs: () => Math.max(0, Math.round(performance.now() - subscriptionStartedAt)),
                        report: event => t.diagnostic(`synthetic BASELINE ${event.phase} result=${event.result}${event.phase === 'retry' ? ` attempt=${event.attempt} sinceSubscriptionMs=${event.sinceSubscriptionMs} durationMs=${event.durationMs}` : ''}`) });
                    initialBaselineFailed = outcome.initialFailed;
                } else {
                    // Restart controls and the actual trial are sent only once.
                    try { await send(); }
                    catch (error) { t.diagnostic(`synthetic ${label} send=${classifyPushError(error)}`); throw new Error(`FIXTURE_${label}_SEND_FAILED`); }
                    t.diagnostic(`synthetic ${label} send=accepted`);
                }
                const deadline = Date.now() + 30000;
                while (!observed.has(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
                return { marker, browserReceived: observed.has(marker) };
            }
            stage = 'baseline'; const first = await launch([]);
            const response = await first.call('Runtime.evaluate', { expression: `(async()=>{const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;return(await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:${JSON.stringify(vapid.publicKey)}})).toJSON()})()`, awaitPromise: true, returnByValue: true }, first.sessionId, 120000);
            if (response.exceptionDetails) throw new Error('FIXTURE_SUBSCRIPTION_FAILED');
            subscription = response.result?.value;
            subscriptionStartedAt = performance.now();
            assert(/^https:\/\/fcm\.googleapis\.com\//.test(subscription?.endpoint || '') && typeof subscription.keys?.p256dh === 'string' && typeof subscription.keys?.auth === 'string', 'invalid synthetic subscription');
            webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
            const baseline = await sendAndObserve('BASELINE');
            assert.equal(baseline.browserReceived, true, 'baseline synthetic notification not received by browser');
            t.diagnostic('synthetic baseline browser=received'); await closeBrowser(first);

            stage = 'restart_control'; const restarted = await launch([]);
            const restartedResult = await sendAndObserve('RESTART_CONTROL');
            assert.equal(restartedResult.browserReceived, true, 'restarted browser did not receive control notification');
            t.diagnostic('synthetic restart control browser=received'); await closeBrowser(restarted);

            if (caseName !== 'none') {
                stage = 'snapshot'; const helper = process.env.MAC_LOCK_HELPER;
                assert.equal(typeof helper, 'string'); const expectedSha256 = createHash('sha256').update(await fs.readFile(helper)).digest('hex');
                await withMacChromeKeychainPassword({ confirmed: true, work: password => withMacChromeSnapshot({ rootPath: profile.rootPath,
                profileId: profile.profileId, helperPath: helper, expectedSha256, work: async snapshot => {
                    const preferences = JSON.parse(await fs.readFile(path.join(snapshot.snapshotPath, 'Default/Preferences'), 'utf8'));
                    assert.equal(preferences.gcm?.product_category_for_subtypes, 'com.chrome.macosx');
                    const entries = Object.entries(preferences.gcm?.push_messaging_application_id_map || {})
                        .filter(([, scope]) => typeof scope === 'string' && scope.split('#')[0] === origin + '/');
                    assert.equal(entries.length, 1, 'synthetic subscription mapping was not unique');
                    const appId = entries[0][0], store = path.join(snapshot.snapshotPath, 'Default/GCM Store');
                    const devices = new ClassicLevel(store, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                    const keys = new ClassicLevel(path.join(store, 'Encryption'), { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                    try {
                        await devices.open(); await keys.open();
                        const deviceId = (await devices.get('device_aid_key')).toString('utf8');
                        const securityToken = decryptMacChromiumDeviceToken(await devices.get('device_token_key'), password);
                        assert(/^[1-9][0-9]*$/.test(deviceId) && /^[1-9][0-9]*$/.test(securityToken), 'invalid synthetic device credentials');
                        const records = [];
                        for await (const [recordKey, record] of keys.iterator({ gte: appId, lt: appId + '\uffff', limit: 5 })) records.push({ recordKey, record });
                        assert.equal(records.length, 1, 'synthetic key was not unique');
                        const encryption = readEncryptionData(records[0].record, { expectedAppId: appId,
                            expectedPublicKey: Buffer.from(subscription.keys.p256dh, 'base64url'), expectedAuthSecret: Buffer.from(subscription.keys.auth, 'base64url') });
                        assert(records[0].recordKey === `${appId},${encryption.authorizedEntity}`, 'synthetic key did not match');
                        credentials = { deviceId, securityToken, appId, category: preferences.gcm.product_category_for_subtypes, encryption };
                    } finally { await keys.close().catch(() => {}); await devices.close().catch(() => {}); }
                } }) });
            }

            stage = 'trial'; const trialBrowser = await launch(flags);
            const trial = await sendAndObserve('TRIAL');
            t.diagnostic(`synthetic trial case=${caseName} browser=${trial.browserReceived ? 'received' : 'not_observed'}`);
            await closeBrowser(trialBrowser);
            if (caseName === 'none') assert.equal(trial.browserReceived, true, 'unblocked browser did not receive trial notification');
            else {
                // The same marker must be recovered after the browser stops;
                // no new notification is sent by the MCS verifier.
                assert.equal(trial.browserReceived, false, 'suppression case was received by the browser');
                assert.equal(observed.has(trial.marker), false, 'browser received the synthetic notification during shutdown');
                stage = 'mcs'; await receiveExpectedSyntheticPush({ subscription, ...credentials, browserVersion, marker: trial.marker });
                t.diagnostic(`synthetic trial case=${caseName} mcs=received`);
                t.diagnostic(`synthetic trial case=${caseName} decryption=matched`);
                // A local report may already be in flight when the browser
                // exits. Recheck after MCS receipt and a bounded grace period;
                // this cannot prove that no later report is possible.
                await new Promise(resolve => setTimeout(resolve, 3000));
                assert.equal(observed.has(trial.marker), false, 'browser reported the synthetic notification after MCS receipt');
            }
            assert.equal(initialBaselineFailed, false, 'initial baseline send failed despite diagnostic retry');
        } catch (error) {
            t.diagnostic(`synthetic suppression case=${caseName} stoppedAt=${stage}; result=inconclusive_or_failed`);
            if (stage === 'mcs' && /^FIXTURE_MCS_[A-Z_]+$/.test(String(error?.message || ''))) t.diagnostic(`synthetic mcs reason=${error.message}`);
            throw error;
        } finally { credentials = null; }
    });
