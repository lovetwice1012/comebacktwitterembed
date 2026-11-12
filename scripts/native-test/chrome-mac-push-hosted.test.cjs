'use strict';

// Networked CI experiment using a disposable profile and an unrelated local
// origin. Subscription credentials stay in memory and never enter the logs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const webpush = require('web-push');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { verifyInstalledChrome } = require('../../src/automation/chrome-mac-broker');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { captureFromBroker } = require('../../src/automation/chrome-broker-client');
const { describeInstalledChrome } = require('./chrome-mac-install-diagnostic.cjs');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { withMacChromeSnapshot } = require('../../src/automation/chrome-mac-snapshot');
const { withMacChromeKeychainPassword } = require('../../src/automation/chrome-mac-keychain');
const { decryptMacChromiumDeviceToken } = require('../../src/automation/chrome-mac-token-crypto');
const { readEncryptionData } = require('../../src/automation/chrome-mcs-protobuf');
const { receiveSyntheticMacPush } = require('./chrome-mac-synthetic-receive.cjs');
const { checkin } = require('../../src/automation/chrome-checkin');
const { verifySyntheticMacTransfer } = require('./chrome-mac-synthetic-transfer.cjs');
const { writeMacChromeExport } = require('../../src/automation/chrome-mac-private-export');
const { verifySyntheticMacDatabaseTransfer } = require('./chrome-mac-synthetic-db.cjs');
const { classifyPushError } = require('./chrome-mac-push-error.cjs');
const { probeAfterGone } = require('./chrome-mac-push-probe.cjs');
const { describeSyntheticGroup } = require('./chrome-mac-group-diagnostic.cjs');

function fixturePipe(child) {
    let id = 0, pending = new Map(), buffer = Buffer.alloc(0);
    const rejectAll = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('FIXTURE_PIPE_CLOSED')); } pending.clear(); };
    child.stdio[4].on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 1024 * 1024) { rejectAll(); return; }
        for (;;) {
            const end = buffer.indexOf(0); if (end < 0) break;
            const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
            let msg; try { msg = JSON.parse(frame.toString('utf8')); } catch { rejectAll(); return; }
            const entry = pending.get(msg.id); if (!entry) continue;
            pending.delete(msg.id); clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error('FIXTURE_CDP_ERROR')); else entry.resolve(msg.result);
        }
    });
    child.on('exit', rejectAll); child.on('error', rejectAll); child.stdio[3].on('error', rejectAll); child.stdio[4].on('error', rejectAll);
    return (method, params = {}, sessionId, timeout = 30000) => new Promise((resolve, reject) => {
        const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(`FIXTURE_CDP_TIMEOUT_${method}`)); }, timeout);
        pending.set(next, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
}

test('macOS Chrome creates a synthetic Web Push subscription on a local origin',
    { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-mac-push-hosted-'));
        let child, closed = false, resolveClosed, closePromise, broker;
        const spawnOwned = (file, args, options) => {
            closed = false; closePromise = new Promise(resolve => { resolveClosed = resolve; });
            child = spawn(file, args, { ...options, detached: true });
            child.once('close', () => { closed = true; resolveClosed(); });
            return child;
        };
        const vapid = webpush.generateVAPIDKeys(), publicKey = vapid.publicKey;
        const delivered = new Set(), workerDelivered = new Set(); let initialPushFailed = false, initialLoginFailed = false;
        const server = http.createServer((req, res) => {
            if (req.url === '/sw.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript' });
                res.end("self.addEventListener('push',e=>e.waitUntil((async()=>{const tag=e.data?e.data.text():'';" +
                    "try{await fetch('/worker-delivered?tag='+encodeURIComponent(tag))}catch{}" +
                    "await self.registration.showNotification('Fixture');for(const c of await clients.matchAll({includeUncontrolled:true}))c.postMessage(tag)})()));");
            } else if (req.url?.startsWith('/worker-delivered?tag=')) {
                const tag = req.url.slice('/worker-delivered?tag='.length);
                if (['preflight', 'secondary', 'original-recheck'].includes(tag)) workerDelivered.add(tag);
                res.end('ok');
            } else if (req.url?.startsWith('/delivered?tag=')) {
                const tag = req.url.slice('/delivered?tag='.length);
                if (['preflight', 'secondary', 'original-recheck'].includes(tag)) delivered.add(tag);
                res.end('ok');
            }
            else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end("<!doctype html><title>Push fixture</title><script>navigator.serviceWorker.addEventListener('message',e=>fetch('/delivered?tag='+encodeURIComponent(e.data)))</script>");
            }
        });
        t.after(async () => {
            if (child && !closed) { try { child.kill('SIGTERM'); } catch { /* Keep profile if shutdown is uncertain. */ } }
            let timer; let stopped = !child || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            if (child?.pid && stopped) stopped = await waitForMacProcessGroupExit(child.pid);
            if (child?.pid && !stopped) await describeSyntheticGroup(t, child.pid, 'cleanup');
            clearTimeout(timer); if (broker) await broker.stop();
            server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
            if (stopped) { const real = await fs.realpath(base); assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-mac-push-hosted-/); await fs.rm(real, { recursive: true }); }
            assert.equal(stopped, true, 'synthetic browser still running; profile retained');
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const profile = await createMacChromeProfile(base); let executable;
        try { executable = await verifyInstalledChrome(); }
        catch (error) {
            await describeInstalledChrome(t, 'push test signature failure');
            const app = '/Applications/Google Chrome.app';
            for (const filename of [app, path.join(app, 'Contents/Info.plist'), path.join(app, 'Contents/MacOS/Google Chrome')]) {
                try { const stat = await fs.lstat(filename); t.diagnostic(`installed ${path.basename(filename)}: directory=${stat.isDirectory()} file=${stat.isFile()} link=${stat.isSymbolicLink()} size=${stat.size}`); }
                catch (reason) { t.diagnostic(`installed ${path.basename(filename)}: ${reason.code}`); }
            }
            const check = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"', app],
                { encoding: 'utf8', timeout: 120000 });
            t.diagnostic(`codesign status=${check.status} signal=${check.signal} error=${check.error?.code || 'none'} stderr=${(check.stderr || '').slice(0, 2048)}`);
            const display = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', app], { encoding: 'utf8', timeout: 30000 });
            t.diagnostic(`signature metadata status=${display.status} stderr=${(display.stderr || '').slice(0, 2048)}`);
            throw error;
        }
        spawnOwned(executable, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile.profilePath}`,
            '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        const call = fixturePipe(child);
        const version = await call('Browser.getVersion');
        assert.ok(/^Chrome\/[0-9]+(?:\.[0-9]+){3}$/.test(version.product), 'unexpected browser version');
        await call('Browser.grantPermissions', { origin, permissions: ['notifications'] });
        const target = await call('Target.createTarget', { url: origin });
        const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const expression = `(async()=>{const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;` +
            `const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:${JSON.stringify(publicKey)}});return s.toJSON()})()`;
        let value;
        for (let attempt = 0; attempt < 30; attempt++) {
            const page = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, attached.sessionId);
            if (page.result?.value === origin) break;
            if (attempt === 29) throw new Error('FIXTURE_PAGE_TIMEOUT');
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId, 120000);
        if (response.exceptionDetails) throw new Error('FIXTURE_SUBSCRIBE_FAILED');
        const subscriptionTime = performance.now();
        const elapsedMs = () => Math.max(0, Math.round(performance.now() - subscriptionTime));
        value = response.result?.value;
        assert.equal(typeof value?.endpoint, 'string'); assert.ok(/^https:\/\/fcm\.googleapis\.com\//.test(value.endpoint), 'unexpected push provider');
        assert.equal(typeof value.keys?.p256dh, 'string'); assert.equal(typeof value.keys?.auth, 'string');
        webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
        let originalRecheckAccepted = false, originalRecheckStop;
        const initialSendTime = elapsedMs();
        try { await webpush.sendNotification(value, 'preflight', { TTL: 60, timeout: 15000 }); }
        catch (error) {
            const original = classifyPushError(error);
            t.diagnostic(`initial synthetic subscription send=${original}`);
            t.diagnostic(`initial synthetic send timing sinceSubscriptionMs=${initialSendTime} durationMs=${elapsedMs() - initialSendTime}`);
            if (original.startsWith('410_')) {
                try {
                    const current = await call('Runtime.evaluate', { expression: `(async()=>{const r=await navigator.serviceWorker.ready;const s=await r.pushManager.getSubscription();return s?s.toJSON():null})()`,
                        awaitPromise: true, returnByValue: true }, attached.sessionId);
                    const currentValue = current.result?.value;
                    t.diagnostic(`original synthetic subscription still present=${Boolean(currentValue)} unchanged=${Boolean(currentValue && currentValue.endpoint === value.endpoint)}`);
                    // Test the original subscription without creating another
                    // registration first; the latter could change provider state.
                    const comparison = await probeAfterGone({
                        send: () => webpush.sendNotification(value, 'original-recheck', { TTL: 60, timeout: 15000 }),
                        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), elapsedMs,
                        report: event => t.diagnostic(`original synthetic recheck attempt=${event.attempt} sinceSubscriptionMs=${event.sinceSubscriptionMs} durationMs=${event.durationMs} result=${event.result}`),
                    });
                    originalRecheckAccepted = comparison.accepted;
                    originalRecheckStop = comparison.stopped;
                    if (originalRecheckAccepted) {
                        t.diagnostic('original synthetic subscription accepted before secondary registration');
                        for (let attempt = 0; attempt < 100 && !delivered.has('original-recheck'); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
                        t.diagnostic(`original synthetic early recheck delivered=${delivered.has('original-recheck')}`);
                        t.diagnostic(`original synthetic early recheck reached service worker=${workerDelivered.has('original-recheck')}`);
                    } else t.diagnostic(`original synthetic early recheck stopped=${comparison.stopped}`);
                    const secondaryVapid = webpush.generateVAPIDKeys();
                    const probe = `(async()=>{const r=await navigator.serviceWorker.register('/sw.js',{scope:'/secondary/'});` +
                        `if(!r.active)await new Promise((resolve,reject)=>{const w=r.installing||r.waiting;if(!w)return reject(Error('worker'));` +
                        `w.addEventListener('statechange',()=>{if(w.state==='activated')resolve();if(w.state==='redundant')reject(Error('worker'))})});` +
                        `return(await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:${JSON.stringify(secondaryVapid.publicKey)}})).toJSON()})()`;
                    const second = await call('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true }, attached.sessionId, 60000);
                    if (second.exceptionDetails || typeof second.result?.value?.endpoint !== 'string') throw new Error('FIXTURE_SECONDARY_INVALID');
                    webpush.setVapidDetails('mailto:fixture@example.com', secondaryVapid.publicKey, secondaryVapid.privateKey);
                    try { await webpush.sendNotification(second.result.value, 'secondary', { TTL: 60, timeout: 15000 }); t.diagnostic('secondary synthetic subscription send accepted'); }
                    catch (secondaryError) { t.diagnostic(`secondary synthetic subscription send=${classifyPushError(secondaryError)}`); }
                    // One controlled diagnostic retry only, never production
                    // behavior: establish whether this exact synthetic token
                    // remains rejected after a short registration delay.
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
                    if (!originalRecheckAccepted && originalRecheckStop === 'all_410' && !delivered.has('original-recheck')) {
                        try {
                            await webpush.sendNotification(value, 'original-recheck', { TTL: 60, timeout: 15000 });
                            t.diagnostic('original synthetic subscription accepted on delayed recheck');
                            for (let attempt = 0; attempt < 100 && !delivered.has('original-recheck'); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
                            t.diagnostic(`original synthetic delayed recheck delivered=${delivered.has('original-recheck')}`);
                        }
                        catch (retryError) { t.diagnostic(`original synthetic subscription delayed recheck=${classifyPushError(retryError)}`); }
                    }
                } catch { t.diagnostic('secondary synthetic subscription comparison unavailable'); }
            }
            // Only the disposable database investigation may continue after
            // verifying delivery of the original retry. Its final result must
            // still fail to preserve the initial 410 as a release gate.
            if (process.env.CBTE_MAC_DB_FIXTURE === '1' && delivered.has('original-recheck')) {
                // Remove only the additional registration created above in
                // this throwaway local origin. Keep the original subscription.
                const cleanup = `(async()=>{const r=await navigator.serviceWorker.getRegistration('/secondary/');` +
                    `if(!r||r.scope!==${JSON.stringify(origin + '/secondary/')})return false;return r.unregister()})()`;
                const removed = await call('Runtime.evaluate', { expression: cleanup, awaitPromise: true, returnByValue: true }, attached.sessionId);
                if (removed.exceptionDetails || removed.result?.value !== true) throw new Error('FIXTURE_SECONDARY_CLEANUP_FAILED');
                const originalCheck = await call('Runtime.evaluate', { expression: `(async()=>{const r=await navigator.serviceWorker.ready;const s=await r.pushManager.getSubscription();return s?s.toJSON():null})()`,
                    awaitPromise: true, returnByValue: true }, attached.sessionId);
                const originalValue = originalCheck.result?.value;
                if (!originalValue || originalValue.endpoint !== value.endpoint || originalValue.keys?.p256dh !== value.keys.p256dh
                    || originalValue.keys?.auth !== value.keys.auth) throw new Error('FIXTURE_ORIGINAL_CHANGED');
                t.diagnostic('removed only the secondary synthetic registration; original remained unchanged');
                initialPushFailed = true; delivered.add('preflight');
                t.diagnostic('continuing disposable DB investigation after initial push failure; final result will remain failed');
            } else throw new Error(`FIXTURE_PREFLIGHT_SEND_${original}`);
        }
        for (let attempt = 0; attempt < 100 && !delivered.has('preflight'); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
        t.diagnostic(`synthetic preflight reached service worker=${workerDelivered.has('preflight')}`);
        if (delivered.has('preflight') && !initialPushFailed) t.diagnostic('browser received synthetic preflight push before shutdown');
        else if (initialPushFailed && delivered.has('preflight')) t.diagnostic('diagnostic retry reached the browser; initial preflight remained failed');
        else if (process.env.CBTE_MAC_DB_FIXTURE === '1') {
            initialPushFailed = true;
            t.diagnostic('browser did not receive preflight within 20 seconds; continuing DB investigation with a failing final result');
        } else assert.fail('browser did not receive the synthetic preflight push');
        // Match the setup broker's graceful close. A dropped reply is expected
        // if the pipe closes first; process and group shutdown are checked below.
        await call('Browser.close').catch(() => {});
        let timer;
        const stopped = await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
        clearTimeout(timer); assert.equal(stopped, true, 'first browser did not stop');
        const firstGroupStopped = await waitForMacProcessGroupExit(child.pid);
        if (!firstGroupStopped) await describeSyntheticGroup(t, child.pid, 'first browser');
        assert.equal(firstGroupStopped, true, 'first browser group did not stop');
        const helper = process.env.MAC_LOCK_HELPER; assert.equal(typeof helper, 'string');
        const expectedSha256 = createHash('sha256').update(await fs.readFile(helper)).digest('hex');
        let fixtureCredentials, snapshotStage = 'keychain';
        try { await withMacChromeKeychainPassword({ confirmed: true, work: password => { snapshotStage = 'snapshot'; return withMacChromeSnapshot({
            rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper, expectedSha256,
            work: async snapshot => {
                snapshotStage = 'preferences';
                const preferences = JSON.parse(await fs.readFile(path.join(snapshot.snapshotPath, 'Default/Preferences'), 'utf8'));
                assert.equal(preferences.gcm?.product_category_for_subtypes, 'com.chrome.macosx');
                const entries = Object.entries(preferences.gcm?.push_messaging_application_id_map || {})
                    .filter(([, scope]) => typeof scope === 'string' && scope.split('#')[0] === origin + '/');
                assert.equal(entries.length, 1, 'local subscription mapping was not unique');
                const appId = entries[0][0], store = path.join(snapshot.snapshotPath, 'Default/GCM Store');
                snapshotStage = 'leveldb';
                const devices = new ClassicLevel(store, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                const keys = new ClassicLevel(path.join(store, 'Encryption'), { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                try {
                    await devices.open(); await keys.open();
                    const device = (await devices.get('device_aid_key')).toString('utf8');
                    const token = decryptMacChromiumDeviceToken(await devices.get('device_token_key'), password);
                    snapshotStage = 'key-match';
                    assert.ok(/^[1-9][0-9]*$/.test(device) && /^[1-9][0-9]*$/.test(token), 'invalid device credentials');
                    const records = [];
                    for await (const [recordKey, record] of keys.iterator({ gte: appId, lt: appId + '\uffff', limit: 5 })) records.push({ recordKey, record });
                    assert.equal(records.length, 1, 'local subscription key was not unique');
                    const found = readEncryptionData(records[0].record, { expectedAppId: appId,
                        expectedPublicKey: Buffer.from(value.keys.p256dh, 'base64url'), expectedAuthSecret: Buffer.from(value.keys.auth, 'base64url') });
                    assert.ok(records[0].recordKey === `${appId},${found.authorizedEntity}`, 'subscription key did not match');
                    fixtureCredentials = { deviceId: device, securityToken: token, appId, category: preferences.gcm.product_category_for_subtypes, encryption: found };
                    snapshotStage = 'cleanup';
                } finally { await keys.close().catch(() => {}); await devices.close().catch(() => {}); }
            }
        }); } }); } catch (error) { t.diagnostic(`synthetic snapshot failed at stage=${snapshotStage}`); throw error; }
        t.diagnostic('synthetic device token and subscription keys matched the isolated snapshot; credentials omitted');
        const browserVersion = version.product.slice('Chrome/'.length);
        const transfer = verifySyntheticMacTransfer({ origin, subscription: value, ...fixtureCredentials, browserVersion });
        t.diagnostic('synthetic X-format transfer passed parser and owner-bound worker vault; local origin was substituted');
        // Exercise the actual local writer on a private, disposable directory.
        // The test only substitutes its own synthetic origin in memory; no
        // real browser profile, X account, or automatic user upload is used.
        const exportDir = path.join(base, 'synthetic-export'); await fs.mkdir(exportDir, { mode: 0o700 });
        const exportName = 'synthetic-notifications.json', exportPath = path.join(exportDir, exportName);
        const exported = await writeMacChromeExport({ directory: exportDir, filename: exportName, file: transfer, confirmed: true });
        assert.equal(exported.uploaded, false); assert.equal(exported.encrypted, false);
        const exportInfo = await fs.lstat(exportPath);
        assert.ok(exportInfo.isFile() && !exportInfo.isSymbolicLink() && exportInfo.uid === process.getuid()
            && (exportInfo.mode & 0o777) === 0o600 && exportInfo.nlink === 1, 'synthetic export was not private');
        const fileText = await fs.readFile(exportPath, 'utf8');
        assert.ok(JSON.stringify(JSON.parse(fileText)) === JSON.stringify(transfer), 'saved synthetic transfer changed');
        t.diagnostic('synthetic transfer saved locally with private permissions; no upload was performed by the writer');
        t.diagnostic(`synthetic credential ranges: deviceHighBit=${BigInt(fixtureCredentials.deviceId) >= (1n << 63n)} tokenHighBit=${BigInt(fixtureCredentials.securityToken) >= (1n << 63n)}`);
        async function receiveWithDiagnostics(database) {
            const receive = (port = 443) => receiveSyntheticMacPush({ subscription: value, vapid, ...fixtureCredentials, browserVersion, port, database,
                onLoginError: info => t.diagnostic(`synthetic MCS login code=${info.code} category=${info.category}`) });
            try { await receive(); }
            catch (error) {
                // Diagnostic only: the gateway currently logs in before check-in.
                // Retry solely after a rejected login, before any push was sent.
                if (!/^FIXTURE_MCS_PROCESSING_FAILED_login_X_CHROME_SESSION_LOGIN_FAILED_tag3_error[0-9]+_matchedfalse$/.test(error?.message || '')) throw error;
                initialLoginFailed = true;
                t.diagnostic('first MCS login rejected; trying a synthetic Mac check-in with the same credentials');
                await checkin({ deviceId: fixtureCredentials.deviceId, securityToken: fixtureCredentials.securityToken, browserVersion, platform: 'macos' });
                t.diagnostic('synthetic Mac check-in accepted unchanged credentials; retrying login');
                try { await receive(); }
                catch (retryError) {
                    if (!/^FIXTURE_MCS_PROCESSING_FAILED_login_X_CHROME_SESSION_LOGIN_FAILED_tag3_error401_matchedfalse$/.test(retryError?.message || '')) throw retryError;
                    t.diagnostic('second login rejected; waiting five seconds before comparing the same port');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    try { await receive(); t.diagnostic('delayed MCS login accepted the synthetic credentials'); }
                    catch (delayedError) {
                        if (!/^FIXTURE_MCS_PROCESSING_FAILED_login_X_CHROME_SESSION_LOGIN_FAILED_tag3_error401_matchedfalse$/.test(delayedError?.message || '')) throw delayedError;
                        t.diagnostic('delayed login rejected; comparing the alternate MCS port with identical synthetic credentials');
                        await receive(5228);
                        t.diagnostic('alternate MCS port accepted the synthetic credentials');
                    }
                }
            }
        }
        if (process.env.CBTE_MAC_DB_FIXTURE === '1') {
            await verifySyntheticMacDatabaseTransfer(transfer, receiveWithDiagnostics, { fileText });
            t.diagnostic('synthetic Mac transfer and encrypted MCS receipt persisted in disposable database before ACK');
            if (process.env.CBTE_MAC_REAL_ROUTE_FIXTURE === '1') t.diagnostic('synthetic MCS receipt routed to one notification job');
        } else await receiveWithDiagnostics();
        fixtureCredentials = null;
        t.diagnostic('synthetic notification received and decrypted by MCS session; credentials omitted');
        broker = await startChromeBroker({ chromePath: executable, profilePath: profile.profilePath, origin, pipeTimeoutMs: 30000,
            extraArgs: ['--headless=new', '--no-proxy-server'], spawnChrome: spawnOwned });
        let captured;
        for (let attempt = 0; attempt < 30 && !captured; attempt++) {
            try { captured = await captureFromBroker({ port: broker.port, token: broker.token }); }
            catch (error) {
                if (!/^X_CHROME_CAPTURE_(?:INVALID|NOT_FOUND)$/.test(error?.code || '') || attempt === 29) throw error;
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        assert.ok(captured?.endpoint === value.endpoint && captured.keys?.p256dh === value.keys.p256dh && captured.keys?.auth === value.keys.auth,
            'captured subscription did not match');
        t.diagnostic('synthetic local subscription created and captured; credentials omitted');
        assert.equal(initialPushFailed, false, 'initial synthetic push failed despite diagnostic recovery');
        assert.equal(initialLoginFailed, false, 'initial MCS login failed despite diagnostic recovery');
        value = null;
    });
