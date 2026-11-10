'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { createChromePipe } = require('./edge-cdp-pipe');
const { parseUniqueJson } = require('./strict-json');
const fault = code => Object.assign(new Error(code), { code });

// The listener exposes only a single capture-and-close action, never general
// DevTools. Its random 256-bit capability is returned over the launching
// process's private stdout pipe and must be stored under the user's ACL.
async function startChromeBroker({ chromePath, profilePath, origin = 'https://x.com', extraArgs = [], spawnChrome = spawn, includeApplicationServerKey = false, browserMode = 'chrome' }) {
    if (typeof chromePath !== 'string' || typeof profilePath !== 'string' || typeof spawnChrome !== 'function'
        || !Array.isArray(extraArgs) || extraArgs.some(arg => typeof arg !== 'string') || typeof includeApplicationServerKey !== 'boolean'
        || !['chrome', 'edge'].includes(browserMode) || browserMode === 'edge' && !includeApplicationServerKey
        || (origin !== 'https://x.com' && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin))) throw fault('X_CHROME_BROKER_INVALID');
    // Only the dedicated setup profile is affected. Keep Chrome's check-in and
    // subscription registration endpoints available, but give its MCS
    // receive connection an unreachable loopback endpoint. This prevents the
    // setup browser from taking notifications away from the server worker.
    const token = randomBytes(32), chrome = spawnChrome(chromePath, ['--remote-debugging-pipe',
        ...(browserMode === 'chrome' ? ['--gcm-mcs-endpoint=https://127.0.0.1:1', '--host-resolver-rules=MAP mtalk.google.com ~NOTFOUND'] : []), `--user-data-dir=${profilePath}`,
        '--no-first-run', '--no-default-browser-check', ...extraArgs, `${origin}/`],
    { windowsHide: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const pipe = createChromePipe(chrome, { origin, includeApplicationServerKey, browserMode });
    let engineVersion;
    try { engineVersion = await pipe.ready(); } catch (error) { if (chrome.exitCode === null) chrome.kill(); throw error; }
    let busy = false, stopped = false;
    const clients = new Set();
    const server = net.createServer(socket => {
        if (stopped || clients.size >= 8 || socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return; }
        clients.add(socket); socket.setTimeout(5000, () => socket.destroy());
        let data = Buffer.alloc(0), handled = false;
        socket.on('close', () => clients.delete(socket)); socket.on('error', () => socket.destroy());
        socket.on('data', chunk => {
            if (handled || !Buffer.isBuffer(chunk) || data.length + chunk.length > 4096) { socket.destroy(); return; }
            data = Buffer.concat([data, chunk]); const end = data.indexOf(10);
            if (end < 0) return;
            handled = true;
            if (end !== data.length - 1) { socket.destroy(); return; }
            let input;
            try { input = parseUniqueJson(data.subarray(0, end).toString('utf8')); } catch { socket.destroy(); return; }
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'command,token'
                || input.command !== 'capture' || typeof input.token !== 'string' || !/^[0-9a-f]{64}$/.test(input.token)
                || !timingSafeEqual(Buffer.from(input.token, 'hex'), token)) { socket.destroy(); return; }
            if (busy) { socket.end(JSON.stringify({ ok: false, errorCode: 'X_CHROME_CAPTURE_BUSY' }) + '\n'); return; }
            busy = true; socket.setTimeout(30000, () => socket.destroy());
            Promise.resolve().then(async () => {
                const subscription = await pipe.capture();
                // If the requesting helper went away while Chrome was being
                // inspected, keep the browser open and allow a later retry.
                if (socket.destroyed) { busy = false; return; }
                await pipe.closeBrowser();
                if (socket.destroyed) { busy = false; await stop(); return; }
                socket.once('finish', () => { void stop(); });
                socket.end(JSON.stringify({ ok: true, subscription }) + '\n');
            }).catch(error => {
                const code = /^X_CHROME_CAPTURE_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'X_CHROME_CAPTURE_UNAVAILABLE';
                socket.end(JSON.stringify({ ok: false, errorCode: code }) + '\n');
                busy = false;
                if (chrome.exitCode !== null) void stop();
            });
        });
    });
    async function stop() {
        if (stopped) return; stopped = true;
        token.fill(0);
        for (const client of clients) client.destroy();
        await new Promise(resolve => server.close(resolve));
    }
    chrome.once('exit', () => { if (!busy) void stop(); });
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)); }); }
    catch (error) { if (chrome.exitCode === null) chrome.kill(); throw error; }
    if (chrome.exitCode !== null) { await stop(); throw fault('X_CHROME_BROKER_INVALID'); }
    const address = server.address();
    if (!address || typeof address === 'string') {
        await stop();
        if (chrome.exitCode === null) chrome.kill();
        throw fault('X_CHROME_BROKER_INVALID');
    }
    return { port: address.port, token: token.toString('hex'), pid: process.pid, browserPid: chrome.pid, engineVersion, stop, chrome };
}
module.exports = { startChromeBroker };
