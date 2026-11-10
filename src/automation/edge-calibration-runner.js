'use strict';

// Runs a synthetic localhost-only subscription in a new, owned profile. The
// caller verifies the browser signature, profile ACL and OS peer identity.
// This module never opens the user's X profile or writes an upload file.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createECDH, createHash, X509Certificate } = require('node:crypto');
const { parseUniqueJson } = require('./strict-json');
const { createChromePipe } = require('./chrome-cdp-pipe');
const { createEdgeCalibrationRelay } = require('./edge-calibration-relay');
const fail = code => Object.assign(new Error(code), { code });
async function checkRoot(rootPath, token) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)
        || path.basename(rootPath) !== `edge-calibration-${token}`) throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
    const root = path.resolve(rootPath), stat = await fs.lstat(root), actual = await fs.realpath(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform === 'win32' ? actual.toLowerCase() !== root.toLowerCase() : actual !== root))
        throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
    const markerPath = path.join(root, 'owner.json'), markerStat = await fs.lstat(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size < 1 || markerStat.size > 4096) throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
    const owner = parseUniqueJson(await fs.readFile(markerPath, 'utf8'));
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) || Object.keys(owner).sort().join(',') !== 'appId,kind,token'
        || owner.appId !== 'x-notification-setup' || owner.kind !== 'edge-calibration-v1' || owner.token !== token) throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
    const profile = path.join(root, 'profile'), profileStat = await fs.lstat(profile), profileActual = await fs.realpath(profile);
    if (profileStat.isSymbolicLink() || !profileStat.isDirectory() || (process.platform === 'win32' ? profileActual.toLowerCase() !== profile.toLowerCase() : profileActual !== profile)
        || (await fs.readdir(profile)).length !== 0) throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
    return profile;
}
/** @param {{rootPath:string, token:string, edgePath:string, pfx:Buffer, passphrase:string, certificate:Buffer, captureIdentity:Function, authorizePeer:Function, signal?:AbortSignal, timeoutMs?:number, spawnBrowser?:Function}} options */
async function runEdgeCalibration({ rootPath, token, edgePath, pfx, passphrase, certificate, captureIdentity, authorizePeer, signal, timeoutMs = 60000, spawnBrowser = spawn }) {
    if (typeof edgePath !== 'string' || !path.isAbsolute(edgePath) || path.basename(edgePath).toLowerCase() !== 'msedge.exe'
        || !Buffer.isBuffer(pfx) || !Buffer.isBuffer(certificate) || typeof captureIdentity !== 'function' || typeof authorizePeer !== 'function'
        || typeof spawnBrowser !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
    let profile, pageServer, relay, browser, pipe, version, spki, closing; const controller = new AbortController();
    let abortCode = 'X_EDGE_CALIBRATION_STOPPED';
    const abort = () => { controller.abort(); if (browser && browser.exitCode === null && browser.signalCode === null) { try { browser.kill(); } catch {} } };
    const timer = setTimeout(() => { abortCode = 'X_EDGE_CALIBRATION_TIMEOUT'; abort(); }, timeoutMs);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const stopped = new Promise((_resolve, reject) => {
        if (controller.signal.aborted) reject(fail(abortCode));
        else controller.signal.addEventListener('abort', () => reject(fail(abortCode)), { once: true });
    }); stopped.catch(() => {});
    const wait = work => Promise.race([work, stopped]);
    async function closeBrowser() {
        if (closing) return closing;
        if (!browser) return;
        const owned = browser, currentPipe = pipe;
        closing = (async () => {
            try {
                if (owned.exitCode === null && owned.signalCode === null && currentPipe) await currentPipe.closeBrowser();
            } catch {
                if (owned.exitCode === null && owned.signalCode === null) {
                    let timer, onExit;
                    const exited = new Promise(resolve => { onExit = resolve; owned.once('exit', onExit); });
                    try {
                        if (!owned.kill() && owned.exitCode === null && owned.signalCode === null) throw fail('X_EDGE_CALIBRATION_CLEANUP_FAILED');
                        await Promise.race([exited, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fail('X_EDGE_CALIBRATION_CLEANUP_FAILED')), 5000); })]);
                    } finally { clearTimeout(timer); owned.removeListener('exit', onExit); }
                }
            } finally { if (browser === owned) { browser = null; pipe = null; } }
        })();
        try { await closing; } finally { closing = null; }
    }
    try {
        profile = await wait(checkRoot(rootPath, token));
        const cert = new X509Certificate(certificate);
        if (!cert.checkHost('localhost') || !cert.checkIP('127.0.0.1')) throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
        spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
        pageServer = http.createServer((request, response) => {
            if (request.method !== 'GET' || !['/', '/sw.js'].includes(request.url)) { response.writeHead(404); response.end(); return; }
            if (request.url === '/sw.js') { response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
                response.end('self.addEventListener("push",e=>e.waitUntil(self.registration.showNotification("fixture")))'); }
            else { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end('<!doctype html><title>Setup</title>'); }
        });
        pageServer.maxConnections = 8;
        pageServer.on('connection', socket => socket.setTimeout(5000, () => socket.destroy()));
        await wait(new Promise((resolve, reject) => { pageServer.once('error', reject); pageServer.listen({ host: '127.0.0.1', port: 0 }, resolve); }));
        const address = pageServer.address(); if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw fail('X_EDGE_CALIBRATION_LISTEN_FAILED');
        const origin = `http://127.0.0.1:${address.port}`;
        const key = createECDH('prime256v1'); key.generateKeys(); const publicKey = key.getPublicKey().toString('base64url');
        const start = args => {
            browser = spawnBrowser(edgePath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
            if (!browser || !Number.isInteger(browser.pid) || browser.pid <= 4) throw fail('X_EDGE_CALIBRATION_BROWSER_FAILED');
            pipe = createChromePipe(browser, { origin, browserMode: 'edge', calibration: true, timeoutMs: Math.min(timeoutMs, 60000) });
            return { browser, pipe };
        };
        const common = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync'];
        const initial = start([...common, 'about:blank']);
        if (typeof initial.pipe.prepareCalibration !== 'function') throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
        version = await wait(initial.pipe.ready()); await wait(initial.pipe.prepareCalibration(publicKey)); await wait(closeBrowser());
        if (controller.signal.aborted) throw fail(abortCode);
        let identityPromise;
        relay = await wait(createEdgeCalibrationRelay({ pfx, passphrase, timeoutMs: Math.min(timeoutMs, 30000), authorizePeer: async ports => {
            const identity = await identityPromise;
            if (controller.signal.aborted || !identity || typeof identity.startTicks !== 'string' || !/^\d{18}$/.test(identity.startTicks)) return false;
            return (await authorizePeer({ ...ports, browserPid: identity.pid, browserStartTicks: identity.startTicks, browserExecutable: edgePath })) === true;
        } }));
        const resumed = start([...common, `--edge-wns-push-server-url=https://127.0.0.1:${relay.port}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank']);
        const pid = resumed.browser.pid;
        identityPromise = Promise.resolve().then(() => captureIdentity(pid, edgePath)).then(startTicks => ({ pid, startTicks }));
        identityPromise.catch(() => {});
        const secondVersion = await wait(resumed.pipe.ready());
        if (secondVersion !== version) throw fail('X_EDGE_CALIBRATION_BROWSER_CHANGED');
        const [client] = await wait(Promise.all([relay.metadata, identityPromise]));
        return { browserVersion: version, client };
    } catch (error) {
        if (controller.signal.aborted) throw fail(abortCode);
        if (typeof error?.code === 'string' && /^X_EDGE_CALIBRATION_[A-Z_]+$/.test(error.code)) throw error;
        throw fail('X_EDGE_CALIBRATION_FAILED');
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        let cleanupFailed = false;
        if (relay) try { await relay.close(); } catch { cleanupFailed = true; }
        try { await closeBrowser(); } catch { cleanupFailed = true; }
        if (pageServer) try { await new Promise(resolve => { pageServer.close(resolve); pageServer.closeAllConnections?.(); }); } catch { cleanupFailed = true; }
        if (cleanupFailed) throw fail('X_EDGE_CALIBRATION_CLEANUP_FAILED');
    }
}
module.exports = { runEdgeCalibration };
