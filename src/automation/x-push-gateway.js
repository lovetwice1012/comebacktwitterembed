'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
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
function renewalDelayMs(subscriptionId, leaseMs) {
    const interval = Math.max(25, Math.floor(leaseMs / 3)), spread = Math.floor(interval / 2);
    const offset = createHash('sha256').update(subscriptionId).digest().readUInt32BE(0) % (spread + 1);
    return { interval, firstDelay: interval + offset };
}
async function deadline(promise, timeoutMs, code) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fault(code)), timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

// A bounded serial frame queue is used instead of the compatibility client's
// recent-version cache: durable ACK codes must be read from the committed DB.
function socketTransport(createSocket, timeoutMs, userAgent, assertAllowed = () => {}) {
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
        assertAllowed();
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
    async function openSubscription(lease, { signal, authorize } = {}) {
        await deadline(store.assertLease(lease, { signal, authorize }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
        let file;
        try {
            // Intake's public-only v2 hybrid envelope is the sole worker format.
            if (lease.sealedEnvelope?.version !== 2) throw fault('X_PUSH_VAULT_INVALID');
            file = privateWorkerVault.open(lease.sealedEnvelope,
                { subscriptionId: lease.subscriptionId, ownerUserId: lease.ownerUserId, revision: lease.revision });
        } catch {
            await deadline(store.auditUse(lease, 'failed', { signal, authorize }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
            throw fault('X_PUSH_VAULT_INVALID');
        }
        await deadline(store.auditUse(lease, 'opened', { signal, authorize }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
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
    async function decryptInbox(lease, row, { signal, authorize } = {}) {
        configured();
        if (!row || row.subscriptionId !== lease.subscriptionId || row.ownerUserId !== lease.ownerUserId || row.revision !== lease.revision
            || !['received', 'routed'].includes(row.status)) throw fault('X_PUSH_INBOX_INVALID');
        const file = await openSubscription(lease, { signal, authorize }), [, crypto] = await loadProtocol();
        await store.assertLease(lease, { signal, authorize });
        return decrypt(crypto, file, row);
    }
    // Recovery reads existing ciphertext with the current worker's own lease.
    async function decryptQuarantinedInbox(lease, row, { signal, authorize } = {}) {
        configured();
        if (!row || row.subscriptionId !== lease.subscriptionId || row.ownerUserId !== lease.ownerUserId || row.revision !== lease.revision
            || row.status !== 'unsupported' || row.ackCode !== 100) throw fault('X_PUSH_INBOX_INVALID');
        const file = await openSubscription(lease, { signal, authorize }), [, crypto] = await loadProtocol();
        await store.assertLease(lease, { signal, authorize });
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
    async function notifyRecovery(callback, lease, signal) {
        if (typeof callback !== 'function' || signal?.aborted) return;
        const controller = new AbortController(); let timer, cancel;
        const stop = () => controller.abort();
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        const cancelled = new Promise(resolve => { cancel = resolve; controller.signal.addEventListener('abort', cancel, { once: true }); });
        timer = setTimeout(stop, timeoutMs);
        try {
            if (controller.signal.aborted) return;
            const work = Promise.resolve().then(() => callback({ lease, signal: controller.signal })).catch(() => {});
            await Promise.race([work, cancelled]);
        } finally {
            clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', stop);
            controller.signal.removeEventListener('abort', cancel);
        }
    }
    async function run(input) {
        configured();
        if (options.assertAllowed !== undefined && typeof options.assertAllowed !== 'function'
            || input.assertAllowed !== undefined && typeof input.assertAllowed !== 'function'
            || input.requireActiveMonitor !== undefined && typeof input.requireActiveMonitor !== 'boolean') throw fault('X_PUSH_CONFIG_INVALID');
        const authorities = [options.assertAllowed, input.assertAllowed].filter((value, index, values) => value && values.indexOf(value) === index);
        const assertAuthority = () => {
            if (input.signal?.aborted) throw fault('X_PUSH_STOPPED');
            try {
                for (const authority of authorities) {
                    const result = authority();
                    if (result && typeof result.then === 'function') {
                        // Guardian authority must be locally available and
                        // synchronous inside the DB fence; never wait under lock.
                        void Promise.resolve(result).catch(() => {});
                        throw new Error('asynchronous authority unavailable');
                    }
                }
            } catch { throw fault('X_PUSH_AUTHORITY_UNAVAILABLE'); }
        };
        const activeMonitor = async query => {
            if (input.requireActiveMonitor !== true) return;
            let rows;
            try {
                rows = await query(`SELECT id FROM automation_x_monitors WHERE owner_user_id=? AND enabled=1 AND state='ready'
                    AND CASE WHEN JSON_VALID(notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(notification_settings_json,'$.subscriptionId')) ELSE NULL END=? LIMIT 1`,
                [input.ownerUserId, input.subscriptionId]);
            } catch { throw fault('X_PUSH_MONITOR_CHECK_FAILED'); }
            if (!Array.isArray(rows)) throw fault('X_PUSH_MONITOR_CHECK_FAILED');
            if (!rows.length) throw fault('X_PUSH_MONITOR_INACTIVE');
        };
        const preClaimAuthorize = async query => { assertAuthority(); await activeMonitor(query); assertAuthority(); };
        const authorize = async query => {
            assertAuthority();
            try {
                await requireXEnrollment(query, { userId: input.ownerUserId },
                    options.rolloutMode === undefined ? {} : { mode: options.rolloutMode });
            } catch (error) {
                throw fault(['X_ROLLOUT_DISABLED', 'X_ROLLOUT_SUPPORTERS_ONLY'].includes(error?.code)
                    ? 'X_PUSH_ROLLOUT_WITHDRAWN' : 'X_PUSH_ROLLOUT_CHECK_FAILED');
            }
            await activeMonitor(query); assertAuthority();
        };
        // The store invokes this synchronous guard again after a DB operation
        // and before its transaction returns. Owner-scoped monitor/plan data
        // remains protected by the already-held owner lock.
        authorize.assertStillAllowed = assertAuthority;
        preClaimAuthorize.assertStillAllowed = assertAuthority;
        // Only server configuration chooses rollout mode; no request option can
        // enable a worker. Cleanup/status remain usable when enrollment closes.
        assertAuthority();
        await requireXEnrollment(db.queryDatabase, { userId: input.ownerUserId },
            options.rolloutMode === undefined ? {} : { mode: options.rolloutMode });
        if (input.signal?.aborted) return { state: 'stopped', reasonCode: null };
        assertAuthority();
        let lease; const claimController = new AbortController();
        const cancelClaim = () => claimController.abort();
        input.signal?.addEventListener('abort', cancelClaim, { once: true });
        if (input.signal?.aborted) cancelClaim();
        try { lease = await deadline(store.claim(input, { authorize: preClaimAuthorize, signal: claimController.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT'); }
        catch (error) {
            if (input.signal?.aborted) return { state: 'stopped', reasonCode: null };
            if (error?.code === 'X_PUSH_MONITOR_INACTIVE') return { state: 'inactive', reasonCode: null };
            if (error?.code === 'X_PUSH_AUTHORITY_UNAVAILABLE') return { state: 'authority_unavailable', reasonCode: null };
            throw error;
        } finally { claimController.abort(); input.signal?.removeEventListener('abort', cancelClaim); }
        if (!lease) return { state: 'busy', reasonCode: 'X_PUSH_LEASE_UNAVAILABLE' };
        // The supervisor records the claimed connection generation even if
        // authentication fails before onSession. It contains no credential.
        try { if (typeof input.onClaim === 'function') input.onClaim({ connectionGeneration: lease.connectionGeneration }); } catch { /* Receiver ownership remains authoritative in the database. */ }
        let transport, checkinRunner, renewal, renewalStart, expiryTimer, renewalFailure, renewing = false, finished = false, finalState = 'stopped', reasonCode = null;
        let renewalWork = Promise.resolve();
        const aborted = () => transport?.abort('X_PUSH_STOPPED');
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
            const schedule = renewalDelayMs(lease.subscriptionId, store.leaseMs), renewEvery = schedule.interval;
            const renew = () => {
                if (renewing) return;
                renewing = true;
                renewalWork = deadline(store.renew(lease, { authorize }), timeoutMs, 'X_PUSH_STORE_TIMEOUT').then(async updated => {
                    lease = updated; watchLease();
                    if (!finished && typeof input.onLease === 'function') await notify(input.onLease, { lease }, input.signal);
                }).catch(error => {
                    renewalFailure = fault(['X_PUSH_ROLLOUT_WITHDRAWN', 'X_PUSH_ROLLOUT_CHECK_FAILED', 'X_PUSH_STORE_TIMEOUT',
                        'X_PUSH_MONITOR_INACTIVE', 'X_PUSH_MONITOR_CHECK_FAILED', 'X_PUSH_AUTHORITY_UNAVAILABLE'].includes(error?.code) ? error.code : 'X_PUSH_LEASE_LOST');
                    transport?.abort(renewalFailure.code);
                }).finally(() => { renewing = false; });
            };
            // Spread the first renewal of simultaneously started sessions so
            // a large fleet does not lock the database all at the same instant.
            renewalStart = setTimeout(() => { renew(); renewal = setInterval(renew, renewEvery); }, schedule.firstDelay);
            // Eligibility or shutdown can change after the initial lookup and
            // claim. Fence the initial vault access and its audit just like
            // later inbox decryptions before opening any provider socket.
            const file = await openSubscription(lease, { signal: input.signal, authorize });
            const [protocol, crypto] = await loadProtocol();
            await assertAuthorized();
            if (renewalFailure) throw renewalFailure;
            if (input.signal?.aborted) throw fault('X_PUSH_STOPPED');
            assertAuthority();
            if (file.version === 3) {
                // The separate Edge gate defaults off. Intake remains closed
                // until its exporter and end-to-end lifecycle are ready.
                if (options.edgeEnabled !== true || !options.edgeTokenVault
                    || typeof options.edgeTokenVault.seal !== 'function' || typeof options.edgeTokenVault.open !== 'function')
                    throw fault('X_PUSH_PROTOCOL_INVALID');
                if (file.push.connectVersion === '2' && options.edgeConnectV2Enabled !== true) throw fault('X_PUSH_PROTOCOL_INVALID');
                const { runEdgeWnsGateway } = require('./edge-wns-gateway');
                const { withEdgeWnsCredentials } = require('./edge-wns-credentials');
                const controller = new AbortController();
                transport = { abort: () => controller.abort(), close: () => controller.abort() };
                input.signal?.addEventListener('abort', aborted, { once: true });
                if (input.signal?.aborted) aborted();
                // Receipt callbacks are wake-up hints: the runtime also scans
                // the durable inbox. A slow route must not hold the WNS reader
                // while more notifications accumulate in its bounded queue.
                let wakeRunning = false, pendingInbox = null;
                function wakeFor(inbox) {
                    if (controller.signal.aborted || typeof input.onReceived !== 'function') return;
                    pendingInbox = inbox;
                    if (wakeRunning) return;
                    wakeRunning = true;
                    void (async () => {
                        while (pendingInbox && !controller.signal.aborted) {
                            const current = pendingInbox; pendingInbox = null;
                            let payload;
                            assertAuthority();
                            try { payload = decrypt(crypto, file, current); } catch { continue; }
                            await notify(input.onReceived, { lease, inbox: current, payload }, controller.signal);
                        }
                    })().catch(() => {}).finally(() => { wakeRunning = false; if (pendingInbox && !controller.signal.aborted) wakeFor(pendingInbox); });
                }
                const edgeStore = Object.fromEntries(['readWnsTokenState', 'saveWnsTokenState', 'assertLease', 'recordFrame', 'getInbox']
                    .map(name => [name, (...args) => deadline(store[name](...args), timeoutMs, 'X_PUSH_STORE_TIMEOUT')]));
                await withEdgeWnsCredentials(file, credentials => runEdgeWnsGateway({
                    store: edgeStore, lease, vault: options.edgeTokenVault, authorize, credentials, signal: controller.signal,
                    transportFactory: ({ signal }) => {
                        assertAuthority();
                        const inner = options.createEdgeTransport ? options.createEdgeTransport({ signal })
                            : require('./edge-wns-transport').createEdgeWnsTransport({ signal });
                        if (!inner || typeof inner.connect !== 'function' || typeof inner.send !== 'function') return inner;
                        return { ...inner,
                            connect(...args) { assertAuthority(); return inner.connect(...args); },
                            send(...args) { assertAuthority(); return inner.send(...args); } };
                    },
                    onReady: async () => {
                        await assertAuthorized();
                        await deadline(store.markState(lease, 'listening', null, { authorize, signal: input.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                        await deadline(store.resetRetry(lease, { authorize, signal: input.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                        if (typeof input.onSession === 'function') await notify(input.onSession, { lease }, input.signal);
                    },
                    onReceived: async ({ inbox }) => {
                        wakeFor(inbox);
                    },
                }));
                if (renewalFailure) throw renewalFailure;
                return { state: 'stopped', reasonCode: null };
            }
            if (file.version === 2) {
                // A separate, explicitly enabled MCS gateway; never send a
                // Chrome device identity to the Mozilla WebSocket endpoint.
                if (options.chromeEnabled !== true) throw fault('X_PUSH_PROTOCOL_INVALID');
                const isMacChrome = file.push.productCategory === 'com.chrome.macosx';
                const isMacBrave = file.push.productCategory === 'com.brave.macosx';
                if (isMacChrome && options.chromeMacEnabled !== true) throw fault('X_PUSH_PROTOCOL_INVALID');
                if (isMacBrave && options.braveMacEnabled !== true) throw fault('X_PUSH_PROTOCOL_INVALID');
                const { createChromeMcsTransport } = require('./chrome-mcs-transport');
                const { createChromeMcsSession } = require('./chrome-mcs-session');
                const { createChromeMcsStoreAdapter } = require('./chrome-mcs-store-adapter');
                let heartbeatMs = duration(options.chromeHeartbeatMs, 900000, 25, 3600000);
                assertAuthority();
                transport = createChromeMcsTransport({ timeoutMs, ...(options.createChromeSocket ? { createSocket: options.createChromeSocket } : {}) });
                input.signal?.addEventListener('abort', aborted, { once: true });
                if (input.signal?.aborted) aborted();
                await transport.connect();
                const chromeStore = createChromeMcsStoreAdapter({ store, lease, authorize, assertAllowed: assertAuthority, decrypt: row => decrypt(crypto, file, row) });
                // The inbox is durable before this hint runs. Coalesce hints
                // while routing is slow, leaving the runtime's inbox scan to
                // recover every row without blocking the MCS reader.
                let wakeRunning = false, pendingInbox = null;
                function wakeFor(inbox) {
                    if (finished || renewalFailure || input.signal?.aborted || typeof input.onReceived !== 'function') return;
                    pendingInbox = inbox;
                    if (wakeRunning) return;
                    wakeRunning = true;
                    void (async () => {
                        while (pendingInbox && !finished && !renewalFailure && !input.signal?.aborted) {
                            const current = pendingInbox; pendingInbox = null;
                            let payload;
                            assertAuthority();
                            try { payload = decrypt(crypto, file, current); } catch { continue; }
                            await notify(input.onReceived, { lease, inbox: current, payload }, input.signal);
                        }
                    })().catch(() => {}).finally(() => { wakeRunning = false; if (pendingInbox) wakeFor(pendingInbox); });
                }
                const session = createChromeMcsSession({
                    credentials: { deviceId: file.push.deviceId, securityToken: file.push.securityToken, clientVersion: file.provenance.engineVersion || file.provenance.browserVersion },
                    route: { expectedCategory: file.push.productCategory, expectedAppId: file.push.appId, expectedSender: file.push.authorizedEntity },
                    store: chromeStore,
                    send: async wire => {
                        await assertAuthorized();
                        if (renewalFailure || input.signal?.aborted) throw renewalFailure || fault('X_PUSH_STOPPED');
                        assertAuthority();
                        await transport.send(wire);
                    },
                    onReceipt: async inbox => {
                        if (!inbox.duplicate && inbox.status === 'received' && typeof input.onReceived === 'function') {
                            wakeFor(inbox);
                        }
                    },
                });
                let chromeEstablished = false;
                try {
                    await session.start();
                    const hello = await transport.read(timeoutMs);
                    if (!hello) throw fault('X_PUSH_HELLO_FAILED');
                    const connected = await session.receive(hello);
                    if (connected.state !== 'listening') throw fault('X_PUSH_HELLO_FAILED');
                    chromeEstablished = true;
                    if (connected.heartbeatIntervalMs) heartbeatMs = connected.heartbeatIntervalMs;
                    await deadline(store.markState(lease, 'listening', null, { authorize, signal: input.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                    await deadline(store.resetRetry(lease, { authorize, signal: input.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                    const { createChromeCheckinRunner } = require('./chrome-checkin-runner');
                    checkinRunner = createChromeCheckinRunner({ lease, store, authorize, now,
                        credentials: { deviceId: file.push.deviceId, securityToken: file.push.securityToken, browserVersion: file.provenance.engineVersion || file.provenance.browserVersion,
                            ...(isMacChrome || isMacBrave ? { platform: 'macos' } : {}) },
                        ...(options.chromeCheckin ? { send: options.chromeCheckin } : {}),
                        ...(options.chromeCheckinSetTimer ? { setTimer: options.chromeCheckinSetTimer } : {}),
                        ...(options.chromeCheckinClearTimer ? { clearTimer: options.chromeCheckinClearTimer } : {}),
                        onFailure: async error => {
                            if (finished || input.signal?.aborted) return;
                            let code = /^X_PUSH_[A-Z_]+$/.test(error?.code || '') ? error.code : 'X_PUSH_CHECKIN_FAILED';
                            if (code === 'X_PUSH_CHECKIN_UNAUTHORIZED' || code === 'X_PUSH_CHECKIN_ID_CHANGED') {
                                try {
                                    // A provider rejection does not authorize a
                                    // stale worker to overwrite current state.
                                    await deadline(store.markState(lease, 'requires_reenrollment', code, { authorize, signal: input.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                                    assertAuthority();
                                    if (finished || input.signal?.aborted) return;
                                    finalState = 'requires_reenrollment'; reasonCode = code;
                                } catch (guardError) {
                                    code = /^X_PUSH_[A-Z_]+$/.test(guardError?.code || '') ? guardError.code : 'X_PUSH_CHECKIN_FAILED';
                                }
                            }
                            renewalFailure = fault(code);
                            transport?.abort(code);
                        },
                    });
                    await deadline(checkinRunner.start(), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                    if (typeof input.onSession === 'function') await notify(input.onSession, { lease }, input.signal);
                    let nextPing = now() + heartbeatMs, pingDeadline = null, receiptsSincePing = 0;
                    while (!input.signal?.aborted) {
                        if (renewalFailure) throw renewalFailure;
                        const frame = await transport.read(Math.max(1, (pingDeadline || nextPing) - now()));
                        if (!frame) {
                            if (pingDeadline !== null) throw fault('X_PUSH_PONG_TIMEOUT');
                            await session.ping(); pingDeadline = now() + Math.max(timeoutMs, 60000); continue;
                        }
                        const outcome = await session.receive(frame);
                        pingDeadline = null; nextPing = now() + heartbeatMs;
                        // Under sustained traffic, request confirmations before
                        // the durable replay-ID limit is reached. This does not
                        // acknowledge any receipt before its DB commit.
                        if (outcome.state === 'received' && ++receiptsSincePing >= 25) {
                            await session.ping(); receiptsSincePing = 0;
                            pingDeadline = now() + Math.max(timeoutMs, 60000);
                        }
                    }
                    return { state: 'stopped', reasonCode: null };
                } catch (error) {
                    // Only a successfully authenticated session may recover
                    // complete frames that were queued before socket failure.
                    // No ACK is sent; persisted IDs are replayed on reconnect.
                    if (chromeEstablished && !renewalFailure && !input.signal?.aborted
                        && ['X_PUSH_SOCKET_FAILED', 'X_PUSH_SOCKET_CLOSED', 'X_PUSH_SEND_TIMEOUT', 'X_PUSH_BACKPRESSURE', 'X_PUSH_PROTOCOL_INVALID'].includes(error?.code)) {
                        const frames = transport.takeBufferedAfterDisconnect(); let recoveryError = null, recovered = false;
                        try {
                            if (frames.length) session.beginRecovery();
                            for (const frame of frames) {
                                if (renewalFailure || input.signal?.aborted) throw renewalFailure || fault('X_PUSH_STOPPED');
                                await assertAuthorized();
                                const result = await deadline(session.recover(frame), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
                                if (result.state === 'received' && result.inbox?.status === 'received') recovered = true;
                                await assertAuthorized();
                            }
                        } catch (cause) {
                            recoveryError = ['X_PUSH_LEASE_LOST', 'X_PUSH_ROLLOUT_WITHDRAWN', 'X_PUSH_ROLLOUT_CHECK_FAILED', 'X_PUSH_STORE_TIMEOUT', 'X_PUSH_STOPPED',
                                'X_PUSH_MONITOR_INACTIVE', 'X_PUSH_MONITOR_CHECK_FAILED', 'X_PUSH_AUTHORITY_UNAVAILABLE'].includes(cause?.code)
                                ? cause : fault('X_PUSH_BUFFERED_RECOVERY_FAILED');
                        } finally { for (const frame of frames) frame.payload.fill(0); }
                        if (recovered && !renewalFailure && !input.signal?.aborted && !['X_PUSH_LEASE_LOST', 'X_PUSH_ROLLOUT_WITHDRAWN', 'X_PUSH_ROLLOUT_CHECK_FAILED', 'X_PUSH_STORE_TIMEOUT', 'X_PUSH_STOPPED',
                            'X_PUSH_MONITOR_INACTIVE', 'X_PUSH_MONITOR_CHECK_FAILED', 'X_PUSH_AUTHORITY_UNAVAILABLE'].includes(recoveryError?.code)) {
                            await assertAuthorized();
                            await notifyRecovery(input.onRecovery, lease, input.signal);
                        }
                        if (recoveryError) throw recoveryError;
                    }
                    throw error;
                } finally { session.close(); }
            }
            if (file.version !== 1) throw fault('X_PUSH_PROTOCOL_INVALID');
            assertAuthority();
            transport = socketTransport(createSocket, timeoutMs, protocol.AUTOPUSH_USER_AGENT, assertAuthority);
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
                await store.markState(lease, 'requires_reenrollment', 'X_PUSH_UAID_CHANGED', { authorize, signal: input.signal });
                assertAuthority();
                finalState = 'requires_reenrollment'; reasonCode = 'X_PUSH_UAID_CHANGED';
                throw fault(reasonCode);
            }
            if (hello.use_webpush === false) throw fault('X_PUSH_PROTOCOL_INVALID');
            await deadline(store.markState(lease, 'listening', null, { authorize, signal: input.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
            await deadline(store.resetRetry(lease, { authorize, signal: input.signal }), timeoutMs, 'X_PUSH_STORE_TIMEOUT');
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
                if (frame.type === 'ping') { assertAuthority(); await transport.send(frame.data, 'pong'); continue; }
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
                assertAuthority();
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
            if (error?.code === 'X_PUSH_MONITOR_INACTIVE') return { state: 'inactive', reasonCode: null };
            if (error?.code === 'X_PUSH_AUTHORITY_UNAVAILABLE') return { state: 'authority_unavailable', reasonCode: null };
            if (finalState !== 'requires_reenrollment') {
                finalState = 'error';
                // A single MCS login rejection is not proof that the user's
                // subscription is invalid. Keep the normal bounded retry path
                // while exposing a fixed, non-sensitive reason to operators.
                reasonCode = error?.code === 'X_CHROME_SESSION_LOGIN_FAILED' ? 'X_PUSH_CHROME_LOGIN_FAILED'
                    : /^X_PUSH_[A-Z_]+$/.test(error?.code || '') ? error.code : 'X_PUSH_RECEIVER_FAILED';
            }
            throw fault(reasonCode);
        } finally {
            finished = true;
            clearTimeout(renewalStart);
            clearInterval(renewal);
            clearTimeout(expiryTimer);
            input.signal?.removeEventListener('abort', aborted);
            // End session-owned routing before releasing its receiver lease.
            // This callback is synchronous; it cannot delay shutdown.
            try { if (typeof input.onStopping === 'function') input.onStopping(); } catch { /* Shutdown still releases the lease. */ }
            if (checkinRunner) try { await deadline(checkinRunner.stop(), timeoutMs, 'X_PUSH_STORE_TIMEOUT'); } catch { /* A stale worker is fenced by its lease. */ }
            await transport?.close();
            try { await deadline(renewalWork, timeoutMs, 'X_PUSH_STORE_TIMEOUT'); } catch { /* A stalled DB cannot hold shutdown indefinitely. */ }
            try { await deadline(store.release(lease, { state: finalState, reasonCode }), timeoutMs, 'X_PUSH_STORE_TIMEOUT'); } catch { /* Expiry/deletion fences this worker; never overwrite its successor. */ }
        }
    }
    return { run, decryptInbox, decryptQuarantinedInbox, store };
}

module.exports = { createXPushGateway, AUTOPUSH_URL, renewalDelayMs };
