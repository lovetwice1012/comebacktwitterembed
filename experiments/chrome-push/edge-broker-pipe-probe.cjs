'use strict';
// Disposable localhost fixture only. No existing profile, X account or X data.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const CDP = require('chrome-remote-interface');
const webpush = require('web-push');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { captureFromBroker } = require('../../src/automation/chrome-broker-client');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'start';
async function main() {
    if (process.env.NODE_ENV !== 'test' || process.platform !== 'win32') throw new Error('PROBE_MODE_INVALID');
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-broker-fixture-'));
    const profile = path.join(root, 'profile'), edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    let server, chrome, cdp, broker;
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
        console.log(JSON.stringify({ syntheticProfile: true, privatePipeCapture: true, subscriptionMatched: true, applicationKeyMatched: true, browserClosed: broker.chrome.exitCode !== null }));
    } finally {
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
