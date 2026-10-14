'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { TextDecoder } = require('node:util');
const { createXPushStore, MAX_FRAME_BYTES, validateFrame } = require('./x-push-store');
const { requireXEnrollment } = require('./x-rollout-policy');

const AUTOPUSH_URL = 'wss://push.services.mozilla.com/';
const CHANNEL_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const PACKAGE = path.resolve(__dirname, '../../packages/angelic-angel');
const fault = code => Object.assign(new Error(code), { code });
let protocolPromise;
function loadProtocol() {
    // Import only protocol parsing and ECE crypto. listener/index/legacy import
    // paths can register a subscription with X and are intentionally excluded.
    protocolPromise ||= Promise.all(['autopush', 'crypto'].map(name => import(pathToFileURL(path.join(PACKAGE, 'dist', name + '.js')).href)));
    return protocolPromise;
}
function defaultSocket({ url, options }) {
    const WebSocket = createRequire(path.join(PACKAGE, 'package.json'))('ws');
    return new WebSocket(url, options);
}
function duration(value, fallback, minimum, maximum) {
    const result = value === undefined ? fallback : value;
    if (!Number.isInteger(result) || result < minimum || result > maximum) throw fault('X_PUSH_CONFIG_INVALID');
    return result;
}
async function deadline(promise, timeoutMs, code) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fault(code)), timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

// A bounded serial frame queue is used instead of the compatibility client's
// recent-version cache: durable ACK codes must be read from the committed DB.
function socketTransport(createSocket, timeoutMs, userAgent) {
    const socket = createSocket({ url: AUTOPUSH_URL, options: {
        headers: { 'User-Agent': userAgent, Origin: 'https://x.com' },
        perMessageDeflate: false, autoPong: false, maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: timeoutMs,
    } });
    const queue = [];
    let queuedBytes = 0, waiting, failed, opened = socket.readyState === 1, ended = false;
    /** @type {any} */
    let settleConnect;
    const connection = new Promise((resolve, reject) => { settleConnect = { resolve, reject }; });
    // An error can arrive before connect() is awaited by the caller.
    connection.catch(() => {});
    const connectTimer = setTimeout(() => abort('X_PUSH_CONNECT_TIMEOUT'), timeoutMs);
    function finishWaiting(value) {
        if (!waiting) return false;
        const current = waiting; waiting = undefined; clearTimeout(current.timer); current.resolve(value); return true;
    }
    function abort(code) {
        if (failed) return;
        failed = fault(code); clearTimeout(connectTimer);
        settleConnect.reject(failed);
        queue.length = 0; queuedBytes = 0;
        if (waiting) { const current = waiting; waiting = undefined; clearTimeout(current.timer); current.reject(failed); }
        socket.terminate?.();
    }
    function enqueue(frame, bytes = 0) {
        if (failed || ended) return;
        if (bytes > MAX_FRAME_BYTES || queue.length >= 16 || queuedBytes + bytes > MAX_FRAME_BYTES * 4) { abort('X_PUSH_BACKPRESSURE'); return; }
        if (finishWaiting(frame)) return;
        queue.push({ frame, bytes }); queuedBytes += bytes;
        if (queue.length >= 8) socket.pause?.();
    }
    socket.on('open', () => { opened = true; clearTimeout(connectTimer); settleConnect.resolve(); });
    socket.on('message', (data, binary) => {
        if (binary) { abort('X_PUSH_PROTOCOL_INVALID'); return; }
        const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (bytes.length > MAX_FRAME_BYTES) { abort('X_PUSH_FRAME_TOO_LARGE'); return; }
        try { enqueue({ type: 'text', data: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }, bytes.length); }
        catch { abort('X_PUSH_PROTOCOL_INVALID'); }
    });
    socket.on('ping', data => enqueue({ type: 'ping', data }, data.length));
    socket.on('pong', () => enqueue({ type: 'pong' }));
    socket.on('error', () => abort('X_PUSH_SOCKET_FAILED'));
    socket.on('close', code => {
        if (!opened) { abort('X_PUSH_SOCKET_FAILED'); return; }
        enqueue({ type: 'close', code }); ended = true; clearTimeout(connectTimer);
    });
    if (opened) { clearTimeout(connectTimer); settleConnect.resolve(); }
    async function send(data, kind = 'text') {
        if (failed) throw failed;
        if (socket.readyState !== 1) throw fault('X_PUSH_SOCKET_CLOSED');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { abort('X_PUSH_SEND_TIMEOUT'); reject(fault('X_PUSH_SEND_TIMEOUT')); }, timeoutMs);
            const complete = error => { clearTimeout(timer); error ? reject(fault('X_PUSH_SOCKET_FAILED')) : resolve(); };
            try {
                if (kind === 'ping') socket.ping(data, true, complete);
                else if (kind === 'pong') socket.pong(data, true, complete);
                else socket.send(data, { binary: false }, complete);
            } catch { clearTimeout(timer); reject(fault('X_PUSH_SOCKET_FAILED')); }
        });
    }
    async function read(timeout) {
        if (failed) throw failed;
        if (queue.length) {
            const entry = queue.shift(); queuedBytes -= entry.bytes;
            if (queue.length < 8) socket.resume?.();
            return entry.frame;
        }
        if (ended) return { type: 'close', code: 1000 };
        if (waiting) throw fault('X_PUSH_CONCURRENT_RECEIVE');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finishWaiting(undefined), Math.max(1, timeout));
            waiting = { resolve, reject, timer };
            socket.resume?.();
        });
    }
    async function close() {
        clearTimeout(connectTimer);
        finishWaiting({ type: 'close', code: 1000 });
        if (socket.readyState === 3) return;
        await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); socket.off('close', finish); resolve(); };
            const timer = setTimeout(() => { socket.terminate?.(); finish(); }, Math.min(1000, timeoutMs));
            socket.once('close', finish);
            try { if (socket.readyState === 1) socket.close(1000); else socket.terminate?.(); }
            catch { finish(); }
        });
    }
    return { connect: () => connection, read, send, close, abort };
}

/** A trusted worker capability. Construction and module import never connect. */
function createXPushGateway(db, options = {}) {
    const store = options.store || createXPushStore(db, { now: options.now, leaseMs: options.leaseMs });
    const now = options.now || Date.now;
    const timeoutMs = duration(options.requestTimeoutMs, 10000, 25, 60000);
    const pingMs = duration(options.pingIntervalMs, 60000, 25, 300000);
    const privateWorkerVault = options.privateWorkerVault;
    const createSocket = options.createSocket || defaultSocket;
    function configured() {
        if (options.enabled !== true) throw fault('X_PUSH_RECEIVER_DISABLED');
        if (!privateWorkerVault || typeof privateWorkerVault.open !== 'function') throw fault('X_PUSH_WORKER_KEY_UNAVAILABLE');
    }
    async function openSubscription(lease) {
        await deadline(store.assertLease(lease), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
        let file;
        try {
            // Intake's public-only v2 hybrid envelope is the sole worker format.
            if (lease.sealedEnvelope?.version !== 2) throw fault('X_PUSH_VAULT_INVALID');
            file = privateWorkerVault.open(lease.sealedEnvelope,
                { subscriptionId: lease.subscriptionId, ownerUserId: lease.ownerUserId, revision: lease.revision });
        } catch {
            await deadline(store.auditUse(lease, 'failed'), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
            throw fault('X_PUSH_VAULT_INVALID');
        }
        await deadline(store.auditUse(lease, 'opened'), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
        return file;
    }
    function decrypt(crypto, file, row) {
        try {
            return crypto.decryptNotification(row.data, row.headers, {
                public_key: [...Buffer.from(file.push.p256dhPublicKey, 'base64url')],
                private_key: [...Buffer.from(file.push.p256dhPrivateKey.d, 'base64url')],
                auth_secret: [...Buffer.from(file.push.authenticationSecret, 'base64url')],
            });
        } catch { throw fault('X_PUSH_DECRYPTION_FAILED'); }
    }
    async function decryptInbox(lease, row) {
        configured();
        if (!row || row.subscriptionId !== lease.subscriptionId || row.ownerUserId !== lease.ownerUserId || row.revision !== lease.revision
            || !['received', 'routed'].includes(row.status)) throw fault('X_PUSH_INBOX_INVALID');
        const file = await openSubscription(lease), [, crypto] = await loadProtocol();
        await store.assertLease(lease);
        return decrypt(crypto, file, row);
    }
    async function notify(callback, value, signal) {
        // A slow application router must not prevent shutdown or grow the frame
        // queue indefinitely. The durable received row remains retryable.
        if (signal?.aborted) return;
        let timer;
        let cancel;
        const done = new Promise(resolve => {
            cancel = resolve;
            timer = setTimeout(resolve, timeoutMs);
            signal?.addEventListener('abort', cancel, { once: true });
        });
        try { await Promise.race([Promise.resolve().then(() => callback(value)).catch(() => {}), done]); }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    }
    async function run(input) {
        configured();
        // Only server configuration chooses rollout mode; no request option can
        // enable a worker. Cleanup/status remain usable when enrollment closes.
        await requireXEnrollment(db.queryDatabase, { userId: input.ownerUserId },
            options.rolloutMode === undefined ? {} : { mode: options.rolloutMode });
        if (input.signal?.aborted) return { state: 'stopped', reasonCode: null };
        let lease = await deadline(store.claim(input), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
        if (!lease) return { state: 'busy', reasonCode: 'X_PUSH_LEASE_UNAVAILABLE' };
        let transport, renewal, expiryTimer, renewalFailure, renewing = false, finished = false, finalState = 'stopped', reasonCode = null;
        let renewalWork = Promise.resolve();
        const aborted = () => transport?.abort('X_PUSH_STOPPED');
        const authorize = async query => {
            try {
                await requireXEnrollment(query, { userId: lease.ownerUserId },
                    options.rolloutMode === undefined ? {} : { mode: options.rolloutMode });
            } catch (error) {
                throw fault(['X_ROLLOUT_DISABLED', 'X_ROLLOUT_SUPPORTERS_ONLY'].includes(error?.code)
                    ? 'X_PUSH_ROLLOUT_WITHDRAWN' : 'X_PUSH_ROLLOUT_CHECK_FAILED');
            }
        };
        function watchLease() {
            clearTimeout(expiryTimer);
            if (finished) return;
            expiryTimer = setTimeout(() => {
                renewalFailure = fault('X_PUSH_LEASE_LOST'); transport?.abort('X_PUSH_LEASE_LOST');
            }, Math.max(1, lease.expiresAtMs - now()));
        }
        const assertAuthorized = () => deadline(store.assertLease(lease, { authorize }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
        try {
            watchLease();
            renewal = setInterval(() => {
                if (renewing) return;
                renewing = true;
                renewalWork = deadline(store.renew(lease, { authorize }), timeoutMs, 'X_PUSH_STORE_TIMEOUT').then(async updated => {
                    lease = updated; watchLease();
                    if (!finished && typeof input.onLease === 'function') await notify(input.onLease, { lease }, input.signal);
                }).catch(error => {
                    renewalFailure = fault(['X_PUSH_ROLLOUT_WITHDRAWN', 'X_PUSH_ROLLOUT_CHECK_FAILED', 'X_PUSH_STORE_TIMEOUT'].includes(error?.code) ? error.code : 'X_PUSH_LEASE_LOST');
                    transport?.abort(renewalFailure.code);
                }).finally(() => { renewing = false; });
            }, Math.max(25, Math.floor(store.leaseMs / 3)));
            const file = await openSubscription(lease);
            const [protocol, crypto] = await loadProtocol();
            await assertAuthorized();
            if (renewalFailure) throw renewalFailure;
            if (input.signal?.aborted) throw fault('X_PUSH_STOPPED');
            transport = socketTransport(createSocket, timeoutMs, protocol.AUTOPUSH_USER_AGENT);
            input.signal?.addEventListener('abort', aborted, { once: true });
            if (input.signal?.aborted) aborted();
            await transport.connect();
            await assertAuthorized();
            await transport.send(protocol.serializeMessage({ messageType: 'hello', uaid: file.push.uaid, use_webpush: true, broadcasts: {} }));
            const helloFrame = await transport.read(timeoutMs);
            if (helloFrame?.type === 'close' && helloFrame.code === 4774) throw fault('X_PUSH_BACKOFF');
            if (!helloFrame || helloFrame.type !== 'text') throw fault('X_PUSH_HELLO_FAILED');
            let hello;
            try { hello = protocol.parseResponse(helloFrame.data); } catch { throw fault('X_PUSH_PROTOCOL_INVALID'); }
            if (hello.messageType !== 'hello' || hello.status !== 200) throw fault('X_PUSH_HELLO_FAILED');
            // Changing a UAID would detach Firefox's real X subscription. Never
            // REGISTER, recreate keys, or call X when Mozilla rejects that UAID.
            if (hello.uaid !== file.push.uaid) {
                finalState = 'requires_reenrollment'; reasonCode = 'X_PUSH_UAID_CHANGED';
                await store.markState(lease, finalState, reasonCode);
                throw fault(reasonCode);
            }
            if (hello.use_webpush === false) throw fault('X_PUSH_PROTOCOL_INVALID');
            await deadline(store.markState(lease, 'listening'), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
            await deadline(store.resetRetry(lease), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
            if (typeof input.onSession === 'function') await notify(input.onSession, { lease }, input.signal);
            let nextPing = now() + pingMs, pongDeadline = null;
            while (!input.signal?.aborted) {
                if (renewalFailure) throw renewalFailure;
                const frame = await transport.read(Math.max(1, (pongDeadline || nextPing) - now()));
                if (!frame) {
                    if (pongDeadline !== null) throw fault('X_PUSH_PONG_TIMEOUT');
                    await assertAuthorized();
                    await transport.send('{}'); await transport.send(Buffer.alloc(0), 'ping');
                    pongDeadline = now() + timeoutMs;
                    continue;
                }
                if (frame.type === 'close') {
                    if (frame.code !== 1000 && frame.code !== 1005) throw fault(frame.code === 4774 ? 'X_PUSH_BACKOFF' : 'X_PUSH_SOCKET_CLOSED');
                    break;
                }
                if (frame.type === 'ping') { await transport.send(frame.data, 'pong'); continue; }
                if (frame.type === 'pong') continue;
                if (protocol.isPong(frame.data)) { pongDeadline = null; nextPing = now() + pingMs; continue; }
                let notification;
                try { notification = protocol.parseResponse(frame.data); } catch { throw fault('X_PUSH_PROTOCOL_INVALID'); }
                if (notification.messageType !== 'notification') throw fault('X_PUSH_PROTOCOL_INVALID');
                if (!CHANNEL_ID.test(notification.channelID)) throw fault('X_PUSH_PROTOCOL_INVALID');
                if (notification.channelID !== file.push.channelID) {
                    // Firefox identifies the connection by its profile-wide
                    // UAID. Even though the export contains only X's keys,
                    // another site's encrypted notification can arrive here.
                    // Validate only the bounded transport envelope, then drop
                    // it without decrypting, deduplicating, persisting, logging
                    // its contents or passing it to an application callback.
                    // In particular, a matching X version must not turn a
                    // foreign notification into an accepted X receipt.
                    validateFrame({ version: notification.version, data: notification.data || '',
                        headers: {}, status: 'decryption_failed', ackCode: 101 });
                    await assertAuthorized();
                    if (renewalFailure || input.signal?.aborted) throw renewalFailure || fault('X_PUSH_STOPPED');
                    // Mozilla's ACK 102 means NotDelivered. ACKing a discarded
                    // frame releases the provider's pending delivery batch so
                    // an unrelated subscription cannot stall X notifications.
                    // This does not unregister or delete that subscription.
                    await transport.send(protocol.serializeMessage({ messageType: 'ack', updates: [{
                        channelID: notification.channelID, version: notification.version, code: 102,
                    }] }));
                    if (pongDeadline !== null && now() >= pongDeadline) throw fault('X_PUSH_PONG_TIMEOUT');
                    continue;
                }
                const entry = { version: notification.version, data: notification.data || '', headers: notification.headers || {}, status: 'decryption_failed', ackCode: 101 };
                entry.headers = validateFrame(entry);
                let payload;
                try { payload = decrypt(crypto, file, entry); entry.status = 'received'; entry.ackCode = 100; } catch { /* Persist ciphertext and safe decryption status. */ }
                const inbox = await deadline(store.recordFrame(lease, entry, { authorize }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                await assertAuthorized();
                if (renewalFailure || input.signal?.aborted) throw renewalFailure || fault('X_PUSH_STOPPED');
                await transport.send(protocol.serializeMessage({ messageType: 'ack', updates: [{ channelID: file.push.channelID, version: entry.version, code: inbox.ackCode }] }));
                // Routing failure leaves ciphertext recoverable. Receipt and ACK
                // are independent of Discord or an application payload adapter.
                if (!inbox.duplicate && inbox.status === 'received' && typeof input.onReceived === 'function') {
                    await notify(input.onReceived, { lease, inbox, payload }, input.signal);
                }
                if (pongDeadline !== null && now() >= pongDeadline) throw fault('X_PUSH_PONG_TIMEOUT');
            }
            return { state: 'stopped', reasonCode: null };
        } catch (error) {
            if (input.signal?.aborted) return { state: 'stopped', reasonCode: null };
            if (finalState !== 'requires_reenrollment') { finalState = 'error'; reasonCode = /^X_PUSH_[A-Z_]+$/.test(error?.code || '') ? error.code : 'X_PUSH_RECEIVER_FAILED'; }
            throw fault(reasonCode);
        } finally {
            finished = true;
            clearInterval(renewal);
            clearTimeout(expiryTimer);
            input.signal?.removeEventListener('abort', aborted);
            await transport?.close();
            try { await deadline(renewalWork, timeoutMs, 'X_PUSH_STORE_TIMEOUT'); } catch { /* A stalled DB cannot hold shutdown indefinitely. */ }
            try { await deadline(store.release(lease, { state: finalState, reasonCode }), timeoutMs, 'X_PUSH_STORE_TIMEOUT'); } catch { /* Expiry/deletion fences this worker; never overwrite its successor. */ }
        }
    }
    return { run, decryptInbox, store };
}

module.exports = { createXPushGateway, AUTOPUSH_URL };
