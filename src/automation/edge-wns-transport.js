'use strict';

// One TLS socket per receiver, inside the shared Node worker. The address is
// fixed; transfer data cannot choose a host or relax certificate validation.
const tls = require('node:tls');
const { createFrameDecoder, MAX_CHUNK } = require('./edge-wns-framing');
const fail = code => Object.assign(new Error(code), { code });
// A single TLS read may contain many small frames. Pause well before the hard
// bounds so normal bursts do not force a disconnect before persistence.
const HIGH_FRAMES = 8, LOW_FRAMES = 4, MAX_FRAMES = 1040;
const HIGH_BYTES = MAX_CHUNK * 2, LOW_BYTES = MAX_CHUNK, MAX_BYTES = MAX_CHUNK * 4;
// Frames queued before a failed read were fully decoded and remain bounded.
// They can be persisted by the lease holder even when later input is bad.
const DRAINABLE_FAILURES = new Set(['X_EDGE_WNS_SOCKET_FAILED', 'X_EDGE_WNS_SOCKET_CLOSED', 'X_EDGE_WNS_BACKPRESSURE', 'X_EDGE_WNS_FRAME_INVALID']);
/** @param {{socketFactory?: () => any, timeoutMs?: number, signal?: AbortSignal}} [options] */
function createEdgeWnsTransport({ socketFactory, timeoutMs = 15000, signal } = {}) {
    if (socketFactory !== undefined && typeof socketFactory !== 'function' || !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 100 || timeoutMs > 60000 || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_EDGE_WNS_TRANSPORT_CONFIG_INVALID');
    const makeSocket = socketFactory || (() => tls.connect({ host: 'client.wns.windows.com', port: 443,
        servername: 'client.wns.windows.com', rejectUnauthorized: true }));
    let socket;
    try { socket = makeSocket(); } catch { throw fail('X_EDGE_WNS_CONNECT_FAILED'); }
    if (!socket || typeof socket.on !== 'function' || typeof socket.write !== 'function' || typeof socket.destroy !== 'function') {
        try { socket?.destroy?.(); } catch { /* Reject invalid transports without leaving a socket open. */ }
        throw fail('X_EDGE_WNS_TRANSPORT_CONFIG_INVALID');
    }
    const decoder = createFrameDecoder({ captureCompleteOnError: true }), queue = []; let queuedBytes = 0, waiting, writePending, connected = false, closed = false, failure, paused = false;
    let resolveConnect, rejectConnect;
    const connection = new Promise((resolve, reject) => { resolveConnect = resolve; rejectConnect = reject; });
    connection.catch(() => {});
    const timer = setTimeout(() => abort('X_EDGE_WNS_CONNECT_TIMEOUT'), timeoutMs);
    function clearQueue() { for (const frame of queue) frame.fill(0); queue.length = 0; queuedBytes = 0; }
    function abort(code, preserveQueue = false) {
        if (closed) { if (!preserveQueue) clearQueue(); return; }
        closed = true; failure = fail(code); clearTimeout(timer);
        rejectConnect(failure);
        if (waiting) { const pending = waiting; waiting = undefined; clearTimeout(pending.timer); pending.reject(failure); }
        if (writePending) { const pending = writePending; writePending = undefined; clearTimeout(pending.timer); pending.reject(failure); }
        if (!preserveQueue) clearQueue();
        try { decoder.finish(); } catch { /* Incomplete buffered data is cleared. */ }
        signal?.removeEventListener('abort', onAbort);
        try { socket.destroy(); } catch { /* The transport is already closed. */ }
    }
    function onAbort() { abort('X_EDGE_WNS_STOPPED'); }
    socket.on('secureConnect', () => {
        if (closed) return;
        connected = true; clearTimeout(timer); resolveConnect();
    });
    socket.on('error', () => abort('X_EDGE_WNS_SOCKET_FAILED', true));
    socket.on('close', () => abort('X_EDGE_WNS_SOCKET_CLOSED', true));
    socket.on('data', chunk => {
        if (closed) return;
        let frames;
        try {
            if (!connected) throw fail('X_EDGE_WNS_FRAME_INVALID');
            frames = decoder.push(chunk);
            if (queue.length + frames.length > MAX_FRAMES || queuedBytes + frames.reduce((sum, frame) => sum + frame.length, 0) > MAX_BYTES) throw fail('X_EDGE_WNS_BACKPRESSURE');
            for (const frame of frames) {
                if (waiting) { const pending = waiting; waiting = undefined; clearTimeout(pending.timer); pending.resolve(frame); }
                else { queue.push(frame); queuedBytes += frame.length; }
            }
            // Ownership has moved to the waiter/queue; an error pausing the
            // socket must not wipe frames that are eligible for draining.
            frames = null;
            if (!paused && (queue.length >= HIGH_FRAMES || queuedBytes >= HIGH_BYTES) && typeof socket.pause === 'function' && typeof socket.resume === 'function') {
                paused = true; socket.pause();
            }
        } catch (error) {
            if (frames) for (const frame of frames) frame.fill(0);
            // A malformed suffix can share one TLS read with earlier complete
            // frames. Keep only the bounded prefix for lease-fenced recovery;
            // reject any pending reader rather than returning data on a failed
            // connection. A partial frame is never exposed.
            let recoveryOverflow = false;
            for (const frame of decoder.takeCompletedOnError()) {
                if (queue.length < MAX_FRAMES && queuedBytes + frame.length <= MAX_BYTES) {
                    queue.push(frame); queuedBytes += frame.length;
                } else { recoveryOverflow = true; frame.fill(0); }
            }
            abort(error?.code === 'X_EDGE_WNS_BACKPRESSURE' || recoveryOverflow ? 'X_EDGE_WNS_BACKPRESSURE' : 'X_EDGE_WNS_FRAME_INVALID', true);
        }
    });
    if (signal) {
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    return Object.freeze({
        connect: () => connection,
        hasBufferedAfterDisconnect() {
            return Boolean(failure && DRAINABLE_FAILURES.has(failure.code) && queue.length);
        },
        takeBufferedAfterDisconnect() {
            if (!failure || !DRAINABLE_FAILURES.has(failure.code)) return [];
            const buffered = queue.splice(0); queuedBytes = 0; return buffered;
        },
        next(waitMs = timeoutMs) {
            if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 60000) return Promise.reject(fail('X_EDGE_WNS_TRANSPORT_CONFIG_INVALID'));
            if (failure) return Promise.reject(failure);
            if (!connected || waiting) { abort('X_EDGE_WNS_TRANSPORT_STATE_INVALID'); return Promise.reject(failure); }
            if (queue.length) {
                const frame = queue.shift(); queuedBytes -= frame.length;
                if (paused && queue.length <= LOW_FRAMES && queuedBytes <= LOW_BYTES) { paused = false; socket.resume(); }
                return Promise.resolve(frame);
            }
            return new Promise((resolve, reject) => {
                const pending = { resolve, reject, timer: null };
                pending.timer = setTimeout(() => {
                    if (waiting !== pending) return;
                    waiting = undefined; reject(fail('X_EDGE_WNS_RECEIVE_TIMEOUT'));
                }, waitMs);
                waiting = pending;
            });
        },
        send(frame) {
            if (failure) return Promise.reject(failure);
            if (!connected || writePending || !Buffer.isBuffer(frame) || frame.length > MAX_CHUNK) { abort('X_EDGE_WNS_TRANSPORT_STATE_INVALID'); return Promise.reject(failure); }
            return new Promise((resolve, reject) => {
                const pending = { reject, timer: setTimeout(() => abort('X_EDGE_WNS_WRITE_TIMEOUT'), timeoutMs) };
                writePending = pending;
                const done = error => {
                    if (writePending !== pending) return;
                    if (error || closed) { abort('X_EDGE_WNS_WRITE_FAILED'); return; }
                    writePending = undefined; clearTimeout(pending.timer); resolve();
                };
                try { socket.write(frame, done); } catch { done(true); }
            });
        },
        close() { abort('X_EDGE_WNS_STOPPED'); },
    });
}
module.exports = { createEdgeWnsTransport };
