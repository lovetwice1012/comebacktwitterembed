'use strict';

const tls = require('node:tls');
const { createFrameDecoder, DEFAULT_MAX_FRAME } = require('./chrome-mcs-framing');
const fault = code => Object.assign(new Error(code), { code });
const HOST = 'mtalk.google.com';
const PORT = 443;
const DRAINABLE_FAILURES = new Set(['X_PUSH_SOCKET_FAILED', 'X_PUSH_SOCKET_CLOSED', 'X_PUSH_SEND_TIMEOUT', 'X_PUSH_BACKPRESSURE', 'X_PUSH_PROTOCOL_INVALID']);
// A TLS read can contain up to 1024 small frames. Leave room for that entire
// burst after the pause threshold, while bounding each connection's memory.
const HIGH_FRAMES = 8, LOW_FRAMES = 4, MAX_FRAMES = 1040;
// Include a partially decoded frame in addition to the low/high-water queue
// and one maximum TLS read; that frame can complete at the start of the read.
const HIGH_BYTES = DEFAULT_MAX_FRAME * 2, LOW_BYTES = DEFAULT_MAX_FRAME, MAX_BYTES = DEFAULT_MAX_FRAME * 7;

// Fixed destination and normal TLS certificate checks. A socket factory is
// injectable for tests, but never obtained from a user's transfer file.
function createChromeMcsTransport({ timeoutMs, createSocket = () => tls.connect({ host: HOST, port: PORT, servername: HOST, rejectUnauthorized: true }) }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 60000 || typeof createSocket !== 'function') throw fault('X_PUSH_CONFIG_INVALID');
    const socket = createSocket(), decoder = createFrameDecoder({ captureCompleteOnError: true }), queue = [];
    let queuedBytes = 0, waiter, failure, closed = false, connected = false, paused = false;
    const pendingWrites = new Set();
    let settleConnection;
    const connection = new Promise((resolve, reject) => { settleConnection = { resolve, reject }; });
    connection.catch(() => {});
    const timer = setTimeout(() => abort('X_PUSH_CONNECT_TIMEOUT'), timeoutMs);
    function clearQueue() { for (const frame of queue) frame.payload.fill(0); queue.length = 0; queuedBytes = 0; }
    function finishWait(value, error) {
        if (!waiter) return false;
        const current = waiter; waiter = null; clearTimeout(current.timer);
        if (error) current.reject(error); else current.resolve(value);
        return true;
    }
    function failWrites(error) {
        for (const pending of pendingWrites) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        pendingWrites.clear();
    }
    function abort(code) {
        if (failure || closed) return;
        failure = fault(code); clearTimeout(timer); settleConnection.reject(failure);
        if (!DRAINABLE_FAILURES.has(code)) clearQueue();
        decoder.discard(); finishWait(undefined, failure); failWrites(failure); socket.destroy();
    }
    socket.on('secureConnect', () => { if (failure || closed) return; connected = true; clearTimeout(timer); settleConnection.resolve(); });
    socket.on('data', chunk => {
        if (failure || closed) return;
        if (!Buffer.isBuffer(chunk) || chunk.length > DEFAULT_MAX_FRAME * 4) { abort('X_PUSH_BACKPRESSURE'); return; }
        try {
            const frames = decoder.push(chunk);
            for (let index = 0; index < frames.length; index++) {
                const frame = frames[index];
                if (finishWait(frame)) continue;
                if (queue.length >= MAX_FRAMES || queuedBytes + frame.payload.length > MAX_BYTES) {
                    // Keep only the bounded prefix already in the queue.
                    // Excess frames cannot be claimed as recovered.
                    for (const excess of frames.slice(index)) excess.payload.fill(0);
                    abort('X_PUSH_BACKPRESSURE'); return;
                }
                queue.push(frame); queuedBytes += frame.payload.length;
            }
            if (!paused && (queue.length >= HIGH_FRAMES || queuedBytes >= HIGH_BYTES)) { paused = true; socket.pause(); }
        } catch {
            // Decode errors can follow complete frames in the same TLS read.
            // Retain only the bounded completed prefix for authenticated,
            // lease-fenced recovery; never expose the malformed suffix.
            let overflow = false;
            for (const frame of decoder.takeCompletedOnError()) {
                if (queue.length < MAX_FRAMES && queuedBytes + frame.payload.length <= MAX_BYTES) {
                    queue.push(frame); queuedBytes += frame.payload.length;
                } else { overflow = true; frame.payload.fill(0); }
            }
            abort(overflow ? 'X_PUSH_BACKPRESSURE' : 'X_PUSH_PROTOCOL_INVALID');
        }
    });
    socket.on('error', () => abort('X_PUSH_SOCKET_FAILED'));
    socket.on('close', () => { if (!closed) abort('X_PUSH_SOCKET_CLOSED'); });
    async function read(waitMs) {
        if (failure) throw failure;
        if (closed) throw fault('X_PUSH_SOCKET_CLOSED');
        if (queue.length) {
            const frame = queue.shift(); queuedBytes -= frame.payload.length;
            if (paused && queue.length <= LOW_FRAMES && queuedBytes <= LOW_BYTES) { paused = false; socket.resume(); }
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
            const pending = { reject, timer: null };
            pending.timer = setTimeout(() => abort('X_PUSH_SEND_TIMEOUT'), timeoutMs);
            pendingWrites.add(pending);
            try { socket.write(data, err => {
                if (!pendingWrites.has(pending)) return;
                if (err) { abort('X_PUSH_SOCKET_FAILED'); return; }
                pendingWrites.delete(pending); clearTimeout(pending.timer); resolve();
            }); } catch { abort('X_PUSH_SOCKET_FAILED'); }
        });
    }
    async function close() {
        if (closed) return;
        closed = true; clearTimeout(timer); finishWait(undefined, fault('X_PUSH_SOCKET_CLOSED'));
        clearQueue(); decoder.discard();
        failWrites(fault('X_PUSH_SOCKET_CLOSED'));
        settleConnection.reject(fault('X_PUSH_SOCKET_CLOSED'));
        socket.destroy();
    }
    function takeBufferedAfterDisconnect() {
        if (!failure || !DRAINABLE_FAILURES.has(failure.code)) return [];
        const frames = queue.splice(0); queuedBytes = 0; return frames;
    }
    return { connect: () => connection, read, send, close, abort, takeBufferedAfterDisconnect };
}
module.exports = { createChromeMcsTransport, HOST, PORT };
