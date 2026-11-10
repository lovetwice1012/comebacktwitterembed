'use strict';

// Captures only the public PushSubscription fields from a user-controlled,
// dedicated Chrome page. It never reads cookies, passwords or page content.
const http = require('node:http');
const fault = code => Object.assign(new Error(code), { code });
function captureExpression(origin) { return `(async()=>{
  if(location.origin !== ${JSON.stringify(origin)}) throw new Error('origin');
  const regs=await navigator.serviceWorker.getRegistrations();
  const found=[];
  for(const reg of regs){if(new URL(reg.scope).origin!==${JSON.stringify(origin)})continue;
    const sub=await reg.pushManager.getSubscription(); if(sub)found.push({scope:reg.scope,...sub.toJSON()});}
  if(location.origin !== ${JSON.stringify(origin)} || found.length !== 1) throw new Error('subscription');
  return found[0];
})()`; }

async function listTargets(port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 5000, headers: { Host: `127.0.0.1:${port}` } }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(fault('X_CHROME_CAPTURE_UNAVAILABLE')); return; }
            let bytes = 0; const chunks = [];
            res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(); else chunks.push(chunk); });
            res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fault('X_CHROME_CAPTURE_INVALID')); } });
            res.on('error', () => reject(fault('X_CHROME_CAPTURE_UNAVAILABLE')));
        });
        req.on('timeout', () => req.destroy()); req.on('error', () => reject(fault('X_CHROME_CAPTURE_UNAVAILABLE')));
    });
}
function selectPage(targets, port, origin = 'https://x.com') {
    if (!Array.isArray(targets) || targets.length > 256) throw fault('X_CHROME_CAPTURE_INVALID');
    const selected = targets.filter(target => {
        try { return target && target.type === 'page' && new URL(target.url).origin === origin; } catch { return false; }
    });
    if (selected.length !== 1) throw fault(selected.length ? 'X_CHROME_CAPTURE_AMBIGUOUS' : 'X_CHROME_CAPTURE_NOT_FOUND');
    try {
        const url = new URL(selected[0].webSocketDebuggerUrl);
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || url.username || url.password
            || url.search || url.hash || !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error();
        return url.href;
    } catch { throw fault('X_CHROME_CAPTURE_INVALID'); }
}
async function captureChromeSubscription({ port, WebSocket, targets = listTargets, fixtureOrigin }) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof WebSocket !== 'function' || typeof targets !== 'function')
        throw fault('X_CHROME_CAPTURE_INVALID');
    if (fixtureOrigin !== undefined && (typeof fixtureOrigin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(fixtureOrigin)))
        throw fault('X_CHROME_CAPTURE_INVALID');
    const origin = fixtureOrigin || 'https://x.com';
    const url = selectPage(await targets(port), port, origin);
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { maxPayload: 65536, handshakeTimeout: 5000 });
        let finished = false;
        const timer = setTimeout(() => finish(fault('X_CHROME_CAPTURE_TIMEOUT')), 10000);
        function finish(error, value) {
            if (finished) return; finished = true; clearTimeout(timer); socket.terminate();
            if (error) reject(error); else resolve(value);
        }
        socket.on('open', () => {
            try { socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
                params: { expression: captureExpression(origin), awaitPromise: true, returnByValue: true } }), err => { if (err) finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')); }); }
            catch { finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')); }
        });
        socket.on('message', (raw, binary) => {
            if (binary || raw.length > 65536) { finish(fault('X_CHROME_CAPTURE_INVALID')); return; }
            try {
                const packet = JSON.parse(raw.toString());
                if (packet.id !== 1) return;
                const result = packet.result;
                if (packet.error || !result || result.exceptionDetails || !result.result || result.result.type !== 'object'
                    || !result.result.value || typeof result.result.value !== 'object') throw new Error();
                const value = result.result.value;
                if (typeof value.scope !== 'string' || typeof value.endpoint !== 'string' || !value.keys
                    || typeof value.keys.p256dh !== 'string' || typeof value.keys.auth !== 'string') throw new Error();
                finish(null, { scope: value.scope, endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } });
            } catch { finish(fault('X_CHROME_CAPTURE_INVALID')); }
        });
        socket.on('error', () => finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')));
        socket.on('close', () => finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')));
    });
}
async function closeDedicatedChrome({ port, browserPath, WebSocket }) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof browserPath !== 'string'
        || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath) || typeof WebSocket !== 'function')
        throw fault('X_CHROME_CAPTURE_INVALID');
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { handshakeTimeout: 5000, maxPayload: 65536 });
        let finished = false, sent = false;
        const timer = setTimeout(() => finish(fault('X_CHROME_CAPTURE_TIMEOUT')), 10000);
        function finish(error) {
            if (finished) return; finished = true; clearTimeout(timer); socket.terminate();
            if (error) reject(error); else resolve();
        }
        socket.on('open', () => {
            try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }), err => {
                if (err) finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')); else sent = true;
            }); } catch { finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')); }
        });
        // The caller additionally waits for the verified Chrome PID to exit.
        socket.on('close', () => finish(sent ? null : fault('X_CHROME_CAPTURE_UNAVAILABLE')));
        socket.on('error', () => finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')));
    });
}
module.exports = { captureChromeSubscription, selectPage, closeDedicatedChrome };
