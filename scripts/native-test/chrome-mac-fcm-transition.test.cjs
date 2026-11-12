'use strict';

// Disposable GitHub-hosted macOS only: compare the same synthetic FCM
// subscription across browser shutdown and MCS login. Never log endpoint,
// payload, browser profile, device credentials or provider response bodies.
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
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { withMacChromeSnapshot } = require('../../src/automation/chrome-mac-snapshot');
const { withMacChromeKeychainPassword } = require('../../src/automation/chrome-mac-keychain');
const { decryptMacChromiumDeviceToken } = require('../../src/automation/chrome-mac-token-crypto');
const { readEncryptionData } = require('../../src/automation/chrome-mcs-protobuf');
const { receiveSyntheticMacPush } = require('./chrome-mac-synthetic-receive.cjs');
const { classifyPushError } = require('./chrome-mac-push-error.cjs');

function fixturePipe(child) {
    let id = 0, buffer = Buffer.alloc(0); const pending = new Map();
    const abort = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('FIXTURE_PIPE_CLOSED')); } pending.clear(); };
    child.stdio[4].on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 1024 * 1024) return abort();
        for (;;) {
            const end = buffer.indexOf(0); if (end < 0) break;
            const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
            let msg; try { msg = JSON.parse(frame.toString('utf8')); } catch { abort(); return; }
            const item = pending.get(msg.id); if (!item) continue;
            pending.delete(msg.id); clearTimeout(item.timer);
            if (msg.error) item.reject(new Error('FIXTURE_CDP_ERROR')); else item.resolve(msg.result);
        }
    });
    child.on('exit', abort); child.on('error', abort); child.stdio[3].on('error', abort); child.stdio[4].on('error', abort);
    return (method, params = {}, sessionId, timeout = 30000) => new Promise((resolve, reject) => {
        const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error('FIXTURE_CDP_TIMEOUT')); }, timeout);
        pending.set(next, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
}

function profileProcessCount(profilePath) {
    // Match only the path of this synthetic profile. The raw process output
    // remains in memory; a zero result cannot exclude escaped descendants
    // whose command line does not contain that path.
    const escaped = profilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = spawnSync('/usr/bin/pgrep', ['-f', escaped], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    if (result.status === 1) return 0;
    if (result.status !== 0 || !/^\s*\d+(?:\s+\d+)*\s*$/.test(result.stdout || '')) return 'unknown';
    return (result.stdout.match(/\d+/g) || []).length;
}

function classifyMcsFailure(error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const send = /^FIXTURE_MCS_PROCESSING_FAILED_send_FIXTURE_MCS_SEND_FAILED_((?:[0-9]{3}|UNKNOWN)_(?:UNREGISTERED|INVALID_TOKEN|EXPIRED|NOT_FOUND|OTHER))_tag3_accepted_matchedfalse$/.exec(message);
    if (send) return `send_${send[1]}`;
    if (/^FIXTURE_MCS_PROCESSING_FAILED_login_X_CHROME_SESSION_LOGIN_FAILED_tag3_error[0-9]+_matchedfalse$/.test(message)) return 'login_rejected';
    if (message === 'FIXTURE_MCS_TIMEOUT') return 'timeout';
    if (message === 'FIXTURE_MCS_CONNECTION_FAILED' || message === 'FIXTURE_MCS_CONNECTION_TIMEOUT') return 'connection_failed';
    return 'other_failure';
}

test('synthetic MCS failure classification never exposes provider text', () => {
    assert.equal(classifyMcsFailure(new Error('FIXTURE_MCS_PROCESSING_FAILED_send_FIXTURE_MCS_SEND_FAILED_410_EXPIRED_tag3_accepted_matchedfalse')), 'send_410_EXPIRED');
    assert.equal(classifyMcsFailure(new Error('FIXTURE_MCS_PROCESSING_FAILED_login_X_CHROME_SESSION_LOGIN_FAILED_tag3_error401_matchedfalse')), 'login_rejected');
    assert.equal(classifyMcsFailure(new Error('FIXTURE_MCS_TIMEOUT')), 'timeout');
    assert.equal(classifyMcsFailure(new Error('secret endpoint or provider body')), 'other_failure');
});

test('FCM accepts a synthetic subscription before shutdown, before MCS and after MCS',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_FCM_TRANSITION_HOSTED !== '1', timeout: 300000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-mac-fcm-transition-'));
        const vapid = webpush.generateVAPIDKeys(); let child, closed = false, closedPromise, resolveClosed, profile;
        let cleanupSafe = true, beforeMcs, afterMcs = 'not_attempted';
        const spawnOwned = (file, args, options) => {
            closed = false; closedPromise = new Promise(resolve => { resolveClosed = resolve; });
            child = spawn(file, args, { ...options, detached: true });
            child.once('close', () => { closed = true; resolveClosed(); }); return child;
        };
        let seenPreflight = false;
        const server = http.createServer((req, res) => {
            if (req.url === '/sw.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript' });
                res.end("self.addEventListener('push',e=>e.waitUntil((async()=>{if(e.data&&e.data.text()==='fixture-preflight')await fetch('/seen');await self.registration.showNotification('Fixture')})()));");
            } else if (req.url === '/seen') { seenPreflight = true; res.end('ok'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Push fixture</title>'); }
        });
        t.after(async () => {
            if (child && !closed) { try { child.kill('SIGTERM'); } catch { /* Retain profile if uncertain. */ } }
            let timer; const ended = !child || closed || await Promise.race([closedPromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer); if (child?.pid) cleanupSafe = cleanupSafe && ended && await waitForMacProcessGroupExit(child.pid);
            server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
            if (cleanupSafe) { const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp); assert.match(path.basename(actual), /^cbte-mac-fcm-transition-/); await fs.rm(actual, { recursive: true }); }
            assert.equal(cleanupSafe, true, 'synthetic browser shutdown unconfirmed; profile retained');
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        profile = await createMacChromeProfile(base); const executable = await verifyInstalledChrome();
        spawnOwned(executable, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile.profilePath}`,
            '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        const call = fixturePipe(child), version = await call('Browser.getVersion');
        assert.match(version.product || '', /^Chrome\/[0-9]+(?:\.[0-9]+){3}$/);
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
        const subscription = response.result?.value;
        assert.match(subscription?.endpoint || '', /^https:\/\/fcm\.googleapis\.com\//);
        assert.equal(typeof subscription?.keys?.p256dh, 'string'); assert.equal(typeof subscription?.keys?.auth, 'string');
        webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
        const since = performance.now(), ms = () => Math.max(0, Math.round(performance.now() - since));
        try { await webpush.sendNotification(subscription, 'fixture-preflight', { TTL: 60, timeout: 15000 }); t.diagnostic(`phase=browser send=accepted elapsedMs=${ms()}`); }
        catch (error) { throw new Error(`FIXTURE_BROWSER_SEND_${classifyPushError(error)}`); }
        for (let attempt = 0; attempt < 100 && !seenPreflight; attempt++) await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(seenPreflight, true, 'browser preflight was not received by synthetic worker');
        t.diagnostic('phase=browser workerReceived=true');
        await call('Browser.close').catch(() => {});
        let timer; const stopped = closed || await Promise.race([closedPromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
        clearTimeout(timer); assert.equal(stopped, true, 'synthetic browser did not close');
        assert.equal(await waitForMacProcessGroupExit(child.pid), true, 'synthetic browser process group remained');
        const matching = profileProcessCount(profile.profilePath);
        t.diagnostic(`phase=closed groupGone=true matchingProfileProcesses=${matching}`);
        if (matching !== 0) {
            // Do not inspect or delete a profile if a matching process remains
            // or the process query itself did not produce a definite result.
            cleanupSafe = false;
            throw new Error('FIXTURE_PROFILE_PROCESS_UNCONFIRMED');
        }
        const helper = process.env.MAC_LOCK_HELPER; assert.equal(typeof helper, 'string');
        const expectedSha256 = createHash('sha256').update(await fs.readFile(helper)).digest('hex');
        let credentials;
        await withMacChromeKeychainPassword({ confirmed: true, work: password => withMacChromeSnapshot({ rootPath: profile.rootPath,
            profileId: profile.profileId, helperPath: helper, expectedSha256, work: async snapshot => {
                const preferences = JSON.parse(await fs.readFile(path.join(snapshot.snapshotPath, 'Default/Preferences'), 'utf8'));
                const entries = Object.entries(preferences.gcm?.push_messaging_application_id_map || {})
                    .filter(([, scope]) => typeof scope === 'string' && scope.split('#')[0] === origin + '/');
                assert.equal(entries.length, 1); const appId = entries[0][0], store = path.join(snapshot.snapshotPath, 'Default/GCM Store');
                const devices = new ClassicLevel(store, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                const keys = new ClassicLevel(path.join(store, 'Encryption'), { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' });
                try {
                    await devices.open(); await keys.open();
                    const deviceId = (await devices.get('device_aid_key')).toString('utf8');
                    const securityToken = decryptMacChromiumDeviceToken(await devices.get('device_token_key'), password);
                    const records = [];
                    for await (const [recordKey, record] of keys.iterator({ gte: appId, lt: appId + '\uffff', limit: 5 })) records.push({ recordKey, record });
                    assert.equal(records.length, 1);
                    const encryption = readEncryptionData(records[0].record, { expectedAppId: appId,
                        expectedPublicKey: Buffer.from(subscription.keys.p256dh, 'base64url'), expectedAuthSecret: Buffer.from(subscription.keys.auth, 'base64url') });
                    assert.equal(records[0].recordKey, `${appId},${encryption.authorizedEntity}`);
                    credentials = { deviceId, securityToken, appId, category: preferences.gcm.product_category_for_subtypes, encryption };
                } finally { await keys.close().catch(() => {}); await devices.close().catch(() => {}); }
            } }) });
        try { await webpush.sendNotification(subscription, 'fixture-before-mcs', { TTL: 0, timeout: 15000 }); beforeMcs = 'accepted'; }
        catch (error) { beforeMcs = classifyPushError(error); }
        t.diagnostic(`phase=before_mcs send=${beforeMcs} elapsedMs=${ms()} ttl=0`);
        // This is a separate memory-store fixture. A TTL=0 probe may still be
        // delivered to a connected endpoint; it is not routed to a DB or job.
        try {
            await receiveSyntheticMacPush({ subscription, vapid, ...credentials, browserVersion: version.product.slice('Chrome/'.length) });
            afterMcs = 'accepted_and_received';
        } catch (error) { afterMcs = classifyMcsFailure(error); }
        t.diagnostic(`phase=after_mcs send=${afterMcs} elapsedMs=${ms()} checkin=not_requested`);
        assert.equal(beforeMcs, 'accepted', 'synthetic pre-MCS send failed');
        assert.equal(afterMcs, 'accepted_and_received', 'synthetic post-MCS send failed or was not received');
    });
