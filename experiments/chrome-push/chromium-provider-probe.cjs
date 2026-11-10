'use strict';
// Provider discovery uses a disposable profile and localhost only. It never
// reads a real browser profile or outputs an endpoint, subscription or key.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const webpush = require('web-push');
const CDP = require('chrome-remote-interface');
const { ClassicLevel } = require('classic-level');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function wireShape(bytes) {
    const fields = []; let pos = 0;
    function read() { let value = 0n; for (let i = 0; i < 10; i++) { if (pos >= bytes.length) throw new Error();
        const b = bytes[pos++]; if (i === 9 && b > 1) throw new Error(); value |= BigInt(b & 127) << BigInt(i * 7); if (!(b & 128)) return value; } throw new Error(); }
    try {
        while (pos < bytes.length && fields.length < 64) {
            const header = read(), field = Number(header >> 3n), wire = Number(header & 7n);
            if (field < 1 || field > 10000) throw new Error();
            if (wire === 0) { read(); fields.push({ field, wire }); }
            else if (wire === 1 || wire === 5) { pos += wire === 1 ? 8 : 4; if (pos > bytes.length) throw new Error(); fields.push({ field, wire }); }
            else if (wire === 2) { const length = Number(read()); if (!Number.isSafeInteger(length) || length > bytes.length - pos) throw new Error(); pos += length; fields.push({ field, wire, length }); }
            else throw new Error();
        }
        return pos === bytes.length ? fields : null;
    } catch { return null; }
}
const browsers = {
    edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    brave: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
};
async function main() {
    const kind = process.env.CHROMIUM_PROBE_BROWSER;
    if (!Object.hasOwn(browsers, kind)) throw new Error('PROBE_BROWSER_INVALID');
    const temp = await fs.realpath(os.tmpdir()), profile = await fs.mkdtemp(path.join(temp, 'cbte-chromium-probe-'));
    let child, cdp, server;
    try {
        if (kind === 'brave' && process.env.CHROMIUM_PROBE_BRAVE_GOOGLE === '1') {
            await fs.mkdir(path.join(profile, 'Default'));
            await fs.writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ brave: { gcm: { channel_status: true } } }));
        }
        const vapid = webpush.generateVAPIDKeys();
        server = http.createServer((req, res) => {
            if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end("self.addEventListener('push',e=>e.waitUntil(self.registration.showNotification('fixture'))) "); }
            else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<script>window.key=${JSON.stringify(vapid.publicKey)}</script>`); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        child = spawn(browsers[kind], ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
            ...(kind === 'edge' && process.env.CHROMIUM_PROBE_EDGE_DISABLE_WINRT === '1' ? ['--disable-features=msPushWinrt'] : []),
            ...(kind === 'edge' && process.env.CHROMIUM_PROBE_EDGE_ENABLE_WINRT === '1' ? ['--enable-features=msPushWinrt'] : []),
            '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
        let port;
        for (let i = 0; i < 120 && !port; i++) {
            try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); }
            if (child.exitCode !== null) throw new Error('PROBE_BROWSER_EXITED');
        }
        if (!port) throw new Error('PROBE_BROWSER_TIMEOUT');
        cdp = await CDP({ port });
        const version = await cdp.Browser.getVersion();
        await cdp.Browser.grantPermissions({ origin, permissions: ['notifications'] });
        await cdp.Page.enable();
        const loaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
        await cdp.Page.navigate({ url: origin }); await loaded;
        let timer;
        const result = await Promise.race([cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
          try {const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
          const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.key});
          return {ok:true,host:new URL(s.endpoint).hostname,protocol:new URL(s.endpoint).protocol};}
          catch(e){return {ok:false,name:e.name};}})()` }),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PROBE_SUBSCRIBE_TIMEOUT')), 30000); })]).finally(() => clearTimeout(timer));
        if (result.exceptionDetails || !result.result.value) throw new Error('PROBE_EVALUATE_FAILED');
        let edgeInternals = null;
        if (kind === 'edge') {
            const internalLoaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
            await cdp.Page.navigate({ url: 'edge://push-internals/' }); await internalLoaded;
            const internal = await cdp.Runtime.evaluate({ returnByValue: true, expression: `({
              builtin: document.body.innerText.includes('Builtin WNS client'),
              winrt: document.body.innerText.includes('WinRT WNS client'),
              fcm: document.body.innerText.includes('Firebase Cloud Messaging (FCM)') })` });
            edgeInternals = internal.result?.value || null;
        }
        await cdp.Browser.close().catch(() => {});
        if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
        await cdp.close().catch(() => {}); cdp = null;
        const prefs = JSON.parse(await fs.readFile(path.join(profile, 'Default', 'Preferences'), 'utf8'));
        const stat = async p => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } };
        const dirs = (await fs.readdir(path.join(profile, 'Default'), { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && /^(?:EdgePushStorageWithWinRt|EdgePushStorageWithConnectTokenAndKey|EdgeFCMPushStorage)$/.test(entry.name)).map(entry => entry.name);
        const stores = [];
        if (kind === 'edge' && process.env.CHROMIUM_PROBE_STORE_SHAPE === '1') {
            for (const name of dirs) {
                const db = new ClassicLevel(path.join(profile, 'Default', name), { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
                const records = [];
                try {
                    await db.open();
                    for await (const [key, value] of db.iterator({ limit: 32 })) {
                        if (key.length > 4096 || value.length > 1024 * 1024) throw new Error('PROBE_STORE_TOO_LARGE');
                        // Never print key or value bytes. The profile is a
                        // disposable test profile, and only size/format hints
                        // are needed to choose a possible integration design.
                        let jsonObject = false;
                        try { const obj = JSON.parse(value.toString('utf8')); jsonObject = Boolean(obj && typeof obj === 'object'); } catch { /* Binary value. */ }
                        const nameHints = ['connect', 'token', 'key', 'device', 'registration', 'subscription', 'crypto', 'channel', 'secret', 'version']
                            .filter(word => key.toString('utf8').toLowerCase().includes(word));
                        records.push({ keyBytes: key.length, keyHints: nameHints, valueBytes: value.length, jsonObject, wireShape: wireShape(value),
                            osCryptV10: value.subarray(0, 3).toString('ascii') === 'v10', osCryptV20: value.subarray(0, 3).toString('ascii') === 'v20' });
                    }
                    stores.push({ name, records });
                } finally { await db.close().catch(() => {}); }
            }
        }
        console.log(JSON.stringify({ browser: kind, product: version.product, subscription: result.result.value,
            category: typeof prefs.gcm?.product_category_for_subtypes === 'string' ? prefs.gcm.product_category_for_subtypes : null,
            mappingPresent: Boolean(prefs.gcm?.push_messaging_application_id_map),
            gcmStorePresent: await stat(path.join(profile, 'Default', 'GCM Store')),
            ...(kind === 'edge' ? { edgeInternals, edgePushStores: dirs, ...(process.env.CHROMIUM_PROBE_STORE_SHAPE === '1' ? { stores } : {}) } : {}),
            googleServicesEnabled: kind === 'brave' ? prefs.brave?.gcm?.channel_status === true : undefined }));
    } finally {
        await cdp?.close().catch(() => {});
        if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
        if (server) await new Promise(resolve => server.close(resolve));
        const resolved = await fs.realpath(profile), stat = await fs.lstat(profile);
        if (stat.isSymbolicLink() || path.dirname(resolved).toLowerCase() !== temp.toLowerCase()
            || !/^cbte-chromium-probe-[A-Za-z0-9]+$/.test(path.basename(resolved))) {
            process.stderr.write('PROBE_CLEANUP_UNSAFE\n'); process.exitCode = 1;
        } else await fs.rm(resolved, { recursive: true });
    }
}
main().catch(error => { console.error(/^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PROBE_FAILED'); process.exitCode = 1; });
