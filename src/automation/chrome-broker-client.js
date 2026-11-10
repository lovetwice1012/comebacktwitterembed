'use strict';
const net = require('node:net');
const { parseUniqueJson } = require('./strict-json');
const fault = code => Object.assign(new Error(code), { code });
async function captureFromBroker({ port, token }) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))
        throw fault('X_CHROME_CAPTURE_INVALID');
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }); let done = false, data = Buffer.alloc(0);
        const timer = setTimeout(() => finish(fault('X_CHROME_CAPTURE_TIMEOUT')), 30000);
        function finish(error, result) {
            if (done) return; done = true; clearTimeout(timer); socket.destroy();
            if (error) reject(error); else resolve(result);
        }
        socket.on('connect', () => socket.write(JSON.stringify({ command: 'capture', token }) + '\n'));
        socket.on('data', chunk => {
            if (!Buffer.isBuffer(chunk) || data.length + chunk.length > 65536) { finish(fault('X_CHROME_CAPTURE_INVALID')); return; }
            data = Buffer.concat([data, chunk]); const end = data.indexOf(10);
            if (end < 0) return;
            if (end !== data.length - 1) { finish(fault('X_CHROME_CAPTURE_INVALID')); return; }
            try {
                const response = parseUniqueJson(data.subarray(0, end).toString('utf8'));
                if (response.ok !== true) {
                    const code = /^X_CHROME_CAPTURE_[A-Z_]+$/.test(String(response.errorCode || '')) ? response.errorCode : 'X_CHROME_CAPTURE_UNAVAILABLE';
                    finish(fault(code)); return;
                }
                const value = response.subscription;
                if (!value || typeof value.scope !== 'string' || typeof value.endpoint !== 'string' || !value.keys
                    || typeof value.keys.p256dh !== 'string' || typeof value.keys.auth !== 'string') throw new Error();
                finish(null, { scope: value.scope, endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } });
            } catch { finish(fault('X_CHROME_CAPTURE_INVALID')); }
        });
        socket.on('error', () => finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')));
        socket.on('close', () => { if (!done) finish(fault('X_CHROME_CAPTURE_UNAVAILABLE')); });
    });
}
module.exports = { captureFromBroker };
