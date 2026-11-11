'use strict';

// Networked CI experiment using a disposable profile and an unrelated local
// origin. Subscription credentials stay in memory and never enter the logs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createECDH } = require('node:crypto');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { verifyInstalledChrome } = require('../../src/automation/chrome-mac-broker');

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
    return (method, params = {}, sessionId, timeout = 15000) => new Promise((resolve, reject) => {
        const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error('FIXTURE_CDP_TIMEOUT')); }, timeout);
        pending.set(next, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
}

test('macOS Chrome creates a synthetic Web Push subscription on a local origin',
    { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-mac-push-hosted-'));
        let child, closed = false, resolveClosed;
        const closePromise = new Promise(resolve => { resolveClosed = resolve; });
        const key = createECDH('prime256v1'); key.generateKeys(); const publicKey = key.getPublicKey().toString('base64url');
        const server = http.createServer((req, res) => {
            if (req.url === '/sw.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end("self.addEventListener('push',()=>{});"); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Push fixture</title>'); }
        });
        t.after(async () => {
            if (child && !closed) { try { child.kill('SIGTERM'); } catch { /* Keep profile if shutdown is uncertain. */ } }
            let timer; const stopped = !child || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
            if (stopped) { const real = await fs.realpath(base); assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-mac-push-hosted-/); await fs.rm(real, { recursive: true }); }
            assert.equal(stopped, true, 'synthetic browser still running; profile retained');
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const profile = await createMacChromeProfile(base), executable = await verifyInstalledChrome();
        child = spawn(executable, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile.profilePath}`,
            '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        child.once('close', () => { closed = true; resolveClosed(); });
        const call = fixturePipe(child);
        await call('Browser.getVersion');
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
        value = response.result?.value;
        assert.equal(typeof value?.endpoint, 'string'); assert.ok(/^https:\/\/fcm\.googleapis\.com\//.test(value.endpoint), 'unexpected push provider');
        assert.equal(typeof value.keys?.p256dh, 'string'); assert.equal(typeof value.keys?.auth, 'string');
        t.diagnostic('synthetic local subscription created; credentials omitted');
        value = null;
    });
