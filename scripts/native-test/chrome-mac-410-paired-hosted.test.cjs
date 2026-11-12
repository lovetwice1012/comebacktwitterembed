'use strict';

// Uses only a fresh local-origin subscription in an isolated hosted Mac.
// No user browser profile, X account, notification content, or keys are logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const webpush = require('web-push');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { verifyInstalledChrome } = require('../../src/automation/chrome-mac-broker');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { compareFreshSubscriptions, deliveryObservation } = require('./chrome-mac-410-paired.cjs');

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

test('paired synthetic subscriptions compare an immediate and a delayed first send',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_410_PAIRED !== '1', timeout: 180000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-mac-410-paired-'));
        const observed = new Set(); let browser, closed = false, closePromise, server;
        t.after(async () => {
            if (browser && !closed) { try { browser.kill('SIGTERM'); } catch {} }
            let timer; const ended = !browser || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
            clearTimeout(timer); const gone = !browser?.pid || ended && await waitForMacProcessGroupExit(browser.pid);
            if (server) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
            if (gone) { const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp); assert.match(path.basename(actual), /^cbte-mac-410-paired-/); await fs.rm(actual, { recursive: true }); }
            assert.equal(gone, true, 'synthetic profile retained because browser shutdown was not confirmed');
        });
        server = http.createServer((req, res) => {
            if (req.url === '/sw.js') {
                res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
                res.end("self.addEventListener('push',e=>e.waitUntil((async()=>{const x=e.data?e.data.text():'';await fetch('/seen?case='+encodeURIComponent(x));await self.registration.showNotification('Synthetic fixture')})()));");
            } else if (['/seen?case=immediate', '/seen?case=delayed', '/seen?case=retry'].includes(req.url)) {
                observed.add(req.url.slice('/seen?case='.length)); res.writeHead(204).end();
            } else { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><title>Synthetic fixture</title>'); }
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`, profile = await createMacChromeProfile(base);
        const executable = await verifyInstalledChrome(), vapid = webpush.generateVAPIDKeys();
        browser = spawn(executable, ['--headless=new', '--remote-debugging-pipe', '--enable-automation', `--user-data-dir=${profile.profilePath}`,
            '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server', 'about:blank'],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        closePromise = new Promise(resolve => browser.once('close', () => { closed = true; resolve(); }));
        const call = fixturePipe(browser), version = await call('Browser.getVersion');
        assert.match(version.product || '', /^Chrome\/[0-9]+(?:\.[0-9]+){3}$/);
        t.diagnostic(`synthetic engineVersion=${version.product.slice('Chrome/'.length)}`);
        await call('Browser.grantPermissions', { origin, permissions: ['notifications'] });
        const target = await call('Target.createTarget', { url: origin });
        const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        let loaded = false;
        for (let i = 0; i < 100 && !loaded; i++) {
            const result = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, attached.sessionId);
            loaded = result.result?.value === origin; if (!loaded) await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!loaded) throw new Error('FIXTURE_PAGE_TIMEOUT');
        webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
        const start = performance.now(), elapsedMs = () => Math.max(0, Math.round(performance.now() - start));
        const result = await compareFreshSubscriptions({
            subscribe: async label => {
                const scope = label === 'immediate' ? '/paired-a/' : '/paired-b/';
                const expression = `(async()=>{const r=await navigator.serviceWorker.register('/sw.js',{scope:${JSON.stringify(scope)}});` +
                    `if(!r.active)await new Promise((resolve,reject)=>{const w=r.installing||r.waiting;if(!w)return reject(Error('worker'));` +
                    `const check=()=>{if(w.state==='activated')resolve();else if(w.state==='redundant')reject(Error('worker'))};w.addEventListener('statechange',check);check()});` +
                    `return(await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:${JSON.stringify(vapid.publicKey)}})).toJSON()})()`;
                const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId, 120000);
                if (response.exceptionDetails) throw new Error('FIXTURE_SUBSCRIPTION_FAILED');
                const value = response.result?.value;
                if (!/^https:\/\/fcm\.googleapis\.com\//.test(value?.endpoint || '') || typeof value.keys?.p256dh !== 'string' || typeof value.keys?.auth !== 'string')
                    throw new Error('FIXTURE_SUBSCRIPTION_INVALID');
                return value;
            },
            send: (subscription, label) => webpush.sendNotification(subscription, label, { TTL: 60, timeout: 15000 }),
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), elapsedMs,
            report: event => t.diagnostic(`paired synthetic phase=${event.label} result=${event.result} sinceSubscriptionMs=${event.sinceSubscriptionMs} durationMs=${event.durationMs}`),
        });
        const expected = [...(result.secondResult === 'accepted' ? ['delayed'] : []),
            ...(result.firstResult === 'accepted' ? ['immediate'] : result.retryResult === 'accepted' ? ['retry'] : [])];
        for (let i = 0; i < 100 && !expected.every(label => observed.has(label)); i++) await new Promise(resolve => setTimeout(resolve, 200));
        t.diagnostic(`paired synthetic browserDelivery immediate=${deliveryObservation(result.firstResult, observed.has('immediate'))}` +
            ` delayed=${deliveryObservation(result.secondResult, observed.has('delayed'))}` +
            ` retry=${deliveryObservation(result.retryResult, observed.has('retry'))}`);
        assert.equal(result.initialFailure, false, 'a first synthetic send failed; later acceptance is diagnostic only');
        assert.equal(expected.every(label => observed.has(label)), true, 'accepted synthetic messages did not both reach the browser');
    });
