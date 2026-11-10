'use strict';

const tls = require('node:tls');
const { createFrameDecoder, DEFAULT_MAX_FRAME } = require('./chrome-mcs-framing');
const fault = code => Object.assign(new Error(code), { code });
const HOST = 'mtalk.google.com';
const PORT = 443;

// Fixed destination and normal TLS certificate checks. A socket factory is
// injectable for tests, but never obtained from a user's transfer file.
function createChromeMcsTransport({ timeoutMs, createSocket = () => tls.connect({ host: HOST, port: PORT, servername: HOST, rejectUnauthorized: true }) }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 60000 || typeof createSocket !== 'function') throw fault('X_PUSH_CONFIG_INVALID');
    const socket = createSocket(), decoder = createFrameDecoder(), queue = [];
    let queuedBytes = 0, waiter, failure, closed = false, connected = false;
    let settleConnection;
    const connection = new Promise((resolve, reject) => { settleConnection = { resolve, reject }; });
    connection.catch(() => {});
    const timer = setTimeout(() => abort('X_PUSH_CONNECT_TIMEOUT'), timeoutMs);
    function finishWait(value, error) {
        if (!waiter) return false;
        const current = waiter; waiter = null; clearTimeout(current.timer);
        if (error) current.reject(error); else current.resolve(value);
        return true;
    }
    function abort(code) {
        if (failure || closed) return;
        failure = fault(code); clearTimeout(timer); settleConnection.reject(failure);
        queue.length = 0; queuedBytes = 0; finishWait(undefined, failure); socket.destroy();
    }
    socket.on('secureConnect', () => { if (failure || closed) return; connected = true; clearTimeout(timer); settleConnection.resolve(); });
    socket.on('data', chunk => {
        if (failure || closed) return;
        if (!Buffer.isBuffer(chunk) || chunk.length > DEFAULT_MAX_FRAME * 4) { abort('X_PUSH_BACKPRESSURE'); return; }
        try {
            for (const frame of decoder.push(chunk)) {
                if (finishWait(frame)) continue;
                if (queue.length >= 16 || queuedBytes + frame.payload.length > DEFAULT_MAX_FRAME * 4) { abort('X_PUSH_BACKPRESSURE'); return; }
                queue.push(frame); queuedBytes += frame.payload.length;
            }
            if (queue.length >= 8) socket.pause();
        } catch { abort('X_PUSH_PROTOCOL_INVALID'); }
    });
    socket.on('error', () => abort('X_PUSH_SOCKET_FAILED'));
    socket.on('close', () => { if (!closed) abort('X_PUSH_SOCKET_CLOSED'); });
    async function read(waitMs) {
        if (failure) throw failure;
        if (closed) throw fault('X_PUSH_SOCKET_CLOSED');
        if (queue.length) {
            const frame = queue.shift(); queuedBytes -= frame.payload.length;
            if (queue.length < 8) socket.resume();
            return frame;
        }
        if (waiter) throw fault('X_PUSH_CONCURRENT_RECEIVE');
        return new Promise((resolve, reject) => {
            const readTimer = setTimeout(() => finishWait(undefined), Math.max(1, waitMs));
            waiter = { resolve, reject, timer: readTimer }; socket.resume();
        });
    }
    async function send(data) {
        if (failure) throw failure;
        if (!connected || closed || !Buffer.isBuffer(data)) throw fault('X_PUSH_SOCKET_CLOSED');
        await new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => { if (!settled) { settled = true; abort('X_PUSH_SEND_TIMEOUT'); reject(failure); } }, timeoutMs);
            try { socket.write(data, err => {
                if (settled) return; settled = true; clearTimeout(timeout);
                if (err) abort('X_PUSH_SOCKET_FAILED');
                if (failure) reject(failure); else resolve();
            }); } catch { clearTimeout(timeout); settled = true; abort('X_PUSH_SOCKET_FAILED'); reject(failure); }
        });
    }
    async function close() {
        if (closed) return;
        closed = true; clearTimeout(timer); finishWait(undefined, fault('X_PUSH_SOCKET_CLOSED'));
        settleConnection.reject(fault('X_PUSH_SOCKET_CLOSED'));
        socket.destroy();
    }
    return { connect: () => connection, read, send, close, abort };
}
module.exports = { createChromeMcsTransport, HOST, PORT };
