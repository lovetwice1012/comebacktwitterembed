'use strict';

const { randomUUID, randomInt } = require('node:crypto');
const { evaluateXRollout, requireXEnrollment } = require('./x-rollout-policy');
const { inspectXProcessingSettings } = require('./x-processing-settings');
const { createXEventRouter } = require('./x-event-router');
const { resolveXProcessingPolicy } = require('./x-processing-policy');

function reconnectDelay(attempt, reasonCode, jitter = randomInt) {
    // Preserve the pinned Rust/Node listener policy: 5s exponential to 300s;
    // AutoPush close 4774 requests at least 1,800s. Jitter only adds delay.
    const base = reasonCode === 'X_PUSH_BACKOFF' ? 1800000 : Math.min(300000, 5000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
    return base + jitter(0, Math.floor(base / 5) + 1);
}

// This supervisor does not import a browser or any X HTTP client. The only
// external connection belongs to the explicitly enabled AutoPush gateway.
function createXPushRuntime(db, queue, options = {}) {
    const enabled = options.enabled === true, clock = options.clock || Date.now;
    const gateway = options.gateway || null;
    const router = options.router || (enabled ? createXEventRouter(db, queue, { clock, useLegacyUserInterval: options.useLegacyUserInterval === true }) : null);
    const mode = resolveXProcessingPolicy(options.processingPolicy);
    const cadenceConfigured = mode !== null;
    const maxConnections = options.maxConnections ?? 1000, pageSize = options.pageSize ?? 100;
    const intervalMs = options.tickMs ?? 5000;
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 10000
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error('X_PUSH_RUNTIME_CONFIG_INVALID');
    const sessions = new Map(), sessionControls = new Map(), leases = new Map(), draining = new Map(), cooldowns = new Map(), drainAgain = new Set(), receiptIds = new Map();
    // Recovered/processed states are durable; this bounded cache merely avoids
    // retrying still-unknown formats on every tick during the same process.
    const quarantineCursors = new Map(), realtimeCursors = new Map();
    const controller = new AbortController(), workerId = `node-${randomUUID()}`;
    const rolloutOptions = options.rolloutMode === undefined ? {} : { mode: options.rolloutMode };
    let timer, ticking = null, stopped = false, cursor = '';
    const assertAllowed = options.assertAllowed || (() => { throw new Error('X_PUSH_AUTHORITY_UNAVAILABLE'); });
    const listCandidates = options.listCandidates || (async afterId => db.queryDatabase(`SELECT s.id,s.owner_user_id,s.revision FROM automation_x_subscriptions s
        LEFT JOIN automation_x_push_receivers r ON r.subscription_id=s.id
        WHERE s.id>? AND COALESCE(r.state,'awaiting')<>'requires_reenrollment' AND COALESCE(r.retry_at_ms,0)<=? AND EXISTS (SELECT 1 FROM automation_x_monitors m WHERE m.owner_user_id=s.owner_user_id AND m.enabled=1 AND m.state='ready'
          AND CASE WHEN JSON_VALID(m.notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(m.notification_settings_json,'$.subscriptionId')) ELSE NULL END=s.id)
        ORDER BY s.id LIMIT ?`, [afterId, clock(), pageSize]));
    const listActiveSessions = options.listActiveSessions || (async ids => db.queryDatabase(`SELECT s.id,s.owner_user_id,s.revision
        FROM automation_x_subscriptions s WHERE s.id IN (?) AND EXISTS (
            SELECT 1 FROM automation_x_monitors m WHERE m.owner_user_id=s.owner_user_id AND m.enabled=1 AND m.state='ready'
            AND CASE WHEN JSON_VALID(m.notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(m.notification_settings_json,'$.subscriptionId')) ELSE NULL END=s.id)`, [ids]));

    async function reconcileSessions() {
        if (!sessions.size) return;
        const eligible = await listActiveSessions([...sessions.keys()]);
        if (!Array.isArray(eligible)) throw new Error('X_PUSH_RUNTIME_CANDIDATES_INVALID');
        const current = new Map(eligible.map(row => [row.id, row]));
        const closing = [];
        for (const [id, record] of sessionControls) {
            const row = current.get(id);
            if (row && row.owner_user_id === record.ownerUserId && Number(row.revision || 1) === record.revision) continue;
            record.controller.abort();
            closing.push(sessions.get(id));
        }
        if (!closing.length) return;
        let deadline;
        try {
            await Promise.race([Promise.allSettled(closing), new Promise(resolve => { deadline = setTimeout(resolve, 5000); })]);
        } finally { clearTimeout(deadline); }
    }

    async function recoverQuarantined(lease) {
        if (typeof gateway.store.listQuarantinedInbox !== 'function' || typeof gateway.decryptQuarantinedInbox !== 'function'
            || typeof gateway.store.restoreQuarantinedInbox !== 'function') return;
        const key = `${lease.subscriptionId}:${lease.revision}`;
        const rows = await gateway.store.listQuarantinedInbox(lease, { afterId: quarantineCursors.get(key) || '0', limit: Math.min(pageSize, 20) });
        for (const row of rows) {
            if (stopped || controller.signal.aborted) return;
            assertAllowed();
            if (!require('./recovery-origin').inboxAllowed(row)) { await gateway.store.markRecoveryQuarantined(lease, row.id); continue; }
            try {
                const payload = await gateway.decryptQuarantinedInbox(lease, row);
                if (stopped || controller.signal.aborted) return;
                require('./x-event-router').normalizeXNotification(payload, { receivedAtMs: row.receivedAtMs });
                assertAllowed();
                await gateway.store.restoreQuarantinedInbox(lease, row.id, { authorize: async query => {
                    assertAllowed();
                    await requireXEnrollment(query, { userId: lease.ownerUserId }, rolloutOptions);
                } });
            } catch (error) {
                if (!/^X_NOTIFICATION_(?:INVALID|UNSUPPORTED)/.test(String(error?.code || ''))) throw error;
            }
            quarantineCursors.delete(key);
            quarantineCursors.set(key, row.id);
            while (quarantineCursors.size > maxConnections * 2) quarantineCursors.delete(quarantineCursors.keys().next().value);
        }
    }
    function rememberCursor(cache, key, value) {
        cache.delete(key); cache.set(key, value);
        while (cache.size > maxConnections * 2) cache.delete(cache.keys().next().value);
    }
    function enqueueReceipt(lease, trigger) {
        if (trigger.received !== true) return;
        drainAgain.add(lease.subscriptionId);
        const id = trigger.inbox?.id;
        if (!/^[1-9]\d{0,19}$/.test(String(id || ''))) return;
        let pending = receiptIds.get(lease.subscriptionId);
        if (!pending) receiptIds.set(lease.subscriptionId, pending = new Set());
        while (receiptIds.size > maxConnections * 2) receiptIds.delete(receiptIds.keys().next().value);
        // These IDs accelerate delivery only. Overflow is still encrypted in
        // the inbox and is recovered by the independent rotating RT scan.
        if (pending.size < 100) pending.add(String(id));
    }
    async function drain(lease, trigger = {}) {
        if (!enabled || stopped || controller.signal.aborted || !cadenceConfigured) return { state: 'not_configured' };
        enqueueReceipt(lease, trigger);
        if (draining.has(lease.subscriptionId)) return draining.get(lease.subscriptionId);
        const sessionSignal = sessionControls.get(lease.subscriptionId)?.controller.signal;
        const work = (async () => {
            const processed = new Set();
            const halted = () => stopped || controller.signal.aborted || sessionSignal?.aborted === true;
            async function permitted() {
                if (halted()) return false;
                assertAllowed();
                const policy = await evaluateXRollout(db.queryDatabase, { userId: lease.ownerUserId }, rolloutOptions);
                return policy.eligible;
            }
            if (!await permitted()) return { state: halted() ? 'stopped' : 'pending' };
            await gateway.store.assertLease(lease);
            await recoverQuarantined(lease);
            if (halted()) return { state: 'stopped' };
            async function route(inbox, processingMode) {
                if (halted() || inbox.status !== 'received') return;
                assertAllowed(); await gateway.store.assertLease(lease);
                // Restored ciphertext is retained for investigation. Its
                // original receipt time is checked before any decryption or
                // creation of a post-recovery run/job.
                if (!require('./recovery-origin').inboxAllowed(inbox)) {
                    await gateway.store.markRecoveryQuarantined(lease, inbox.id);
                    if (!halted()) processed.add(inbox.id);
                    return;
                }
                try {
                    const payload = await gateway.decryptInbox(lease, inbox);
                    if (halted()) return;
                    assertAllowed();
                    const result = await router.routeReceived({ lease, inbox, payload, processingMode });
                    if (halted()) return;
                    if (result.state === 'routed') await gateway.store.markRouted(lease, inbox.id);
                    else if (result.state === 'unmatched') await gateway.store.markUnmatched(lease, inbox.id);
                } catch (error) {
                    if (halted()) return;
                    assertAllowed();
                    if (/^X_NOTIFICATION_(?:INVALID|UNSUPPORTED)/.test(String(error?.code || '')))
                        await gateway.store.markUnsupported(lease, inbox.id);
                    else throw error;
                }
                if (!halted()) processed.add(inbox.id);
            }
            async function realtimePass() {
                drainAgain.delete(lease.subscriptionId);
                const pending = receiptIds.get(lease.subscriptionId);
                receiptIds.delete(lease.subscriptionId);
                try {
                    if (!await router.hasRealtimeTargets(lease)) return;
                    // The callback is only a wake-up/identity hint. Read owned,
                    // persisted ciphertext again; never route its supplied payload.
                    for (const id of pending || []) {
                        if (halted() || !await permitted()) return;
                        const inbox = await gateway.store.getInbox({ ...lease, id });
                        if (inbox) await route(inbox, 'realtime');
                    }
                    const key = `${lease.subscriptionId}:${lease.revision}`;
                    // A bounded rotating cursor is separate from the durable batch
                    // cursor. Batch backlog cannot indefinitely hide a later RT
                    // receipt, and pending rules are revisited after scan wrap.
                    for (let page = 0; page < 10 && !halted(); page++) {
                        if (!await permitted()) return;
                        const rows = await gateway.store.listInbox({ ...lease, afterId: realtimeCursors.get(key) || '0', limit: pageSize });
                        for (const inbox of rows) {
                            if (halted()) return;
                            await route(inbox, 'realtime');
                            rememberCursor(realtimeCursors, key, inbox.id);
                        }
                        if (rows.length < pageSize) { rememberCursor(realtimeCursors, key, '0'); break; }
                    }
                } catch (error) {
                    // Preserve the direct receipt wake-ups as well as durable
                    // ciphertext when a read/admission/marker write fails.
                    for (const id of pending || []) enqueueReceipt(lease, { received: true, inbox: { id } });
                    throw error;
                }
            }
            await realtimePass();
            let result = { state: 'processed' };
            if (!halted() && trigger.received !== true && await router.hasBatchTargets(lease)) {
                // Owner realtime is merely a legacy per-monitor default. Every
                // batch target uses the current plan interval, even when another
                // monitor on this subscription is being delivered immediately.
                const resolveProcessing = async query => ({ ...await inspectXProcessingSettings(query, lease.ownerUserId, clock(), {
                    useLegacyUserInterval: options.useLegacyUserInterval === true,
                }), effectiveMode: 'batch' });
                const window = await gateway.store.beginProcessing(lease, undefined, { resolveProcessing });
                if (!window.ready) result = { state: 'pending', ...(window.code ? { code: window.code } : {}),
                    ...(window.dueAtMs === undefined ? {} : { dueAtMs: window.dueAtMs }) };
                else {
                    const rows = await gateway.store.listInbox({ ...lease, afterId: window.cursorId, limit: pageSize });
                    let reachedCutoff = false;
                    for (const inbox of rows) {
                        if (halted()) break;
                        if (inbox.receivedAtMs > window.windowAtMs) { reachedCutoff = true; break; }
                        await route(inbox, 'batch');
                        if (halted()) break;
                        await gateway.store.advanceProcessing(lease, { windowAtMs: window.windowAtMs, cursorId: inbox.id });
                    }
                    if (!halted() && (reachedCutoff || rows.length < pageSize))
                        await gateway.store.completeProcessing(lease, { windowAtMs: window.windowAtMs });
                }
            }
            // New callbacks can arrive during any awaited DB/decryption/queue
            // operation. Drain their exact IDs before releasing this mutex.
            while (!halted() && drainAgain.has(lease.subscriptionId)) await realtimePass();
            return halted() ? { state: 'stopped' } : { ...result, ...(result.state === 'processed' || processed.size ? { processed: processed.size } : {}) };
        })();
        draining.set(lease.subscriptionId, work);
        try { return await work; }
        finally {
            if (draining.get(lease.subscriptionId) === work) draining.delete(lease.subscriptionId);
            // Failure leaves receipt hints and all ciphertext intact. A periodic
            // drain retries; shutdown intentionally performs no later work.
        }
    }
    function remember({ lease }) { if (!stopped) { leases.set(lease.subscriptionId, lease); cooldowns.delete(lease.subscriptionId); } }
    async function tick() {
        if (!enabled || stopped || controller.signal.aborted) return { state: 'disabled' };
        if (!cadenceConfigured) return { state: 'not_configured', code: 'X_PUSH_PROCESSING_NOT_CONFIGURED' };
        if (ticking) return ticking;
        const work = (async () => {
            if (!gateway || typeof gateway.run !== 'function') throw new Error('X_PUSH_GATEWAY_UNAVAILABLE');
            assertAllowed();
            await reconcileSessions();
            const candidates = await listCandidates(cursor);
            if (!Array.isArray(candidates)) throw new Error('X_PUSH_RUNTIME_CANDIDATES_INVALID');
            cursor = candidates.length === pageSize ? candidates.at(-1).id : '';
            for (const candidate of candidates) {
                if (stopped || sessions.size >= maxConnections) break;
                if (sessions.has(candidate.id)) continue;
                if ((cooldowns.get(candidate.id) || 0) > clock()) continue;
                const policy = await evaluateXRollout(db.queryDatabase, { userId: candidate.owner_user_id }, rolloutOptions);
                if (!policy.eligible) continue;
                let active = true;
                const revision = Number(candidate.revision || 1);
                const localController = new AbortController();
                const record = { controller: localController, ownerUserId: candidate.owner_user_id, revision };
                sessionControls.set(candidate.id, record);
                const rememberSession = value => { if (active && !localController.signal.aborted && sessions.get(candidate.id) === pending) remember(value); };
                const pending = Promise.resolve().then(() => gateway.run({ subscriptionId: candidate.id, ownerUserId: candidate.owner_user_id,
                    workerId, signal: localController.signal, onSession: rememberSession, onLease: rememberSession,
                    onReceived: async ({ lease, inbox }) => { if (!active || localController.signal.aborted || sessions.get(candidate.id) !== pending || stopped) return; rememberSession({ lease }); await drain(lease, { received: true, inbox }); } }))
                    .catch(error => ({ state: 'error', reasonCode: /^X_PUSH_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'X_PUSH_CONNECTION_FAILED' }))
                    .then(async result => {
                        if (stopped || controller.signal.aborted || localController.signal.aborted || ['busy', 'requires_reenrollment'].includes(result?.state)) return;
                        const lease = leases.get(candidate.id);
                        const identity = { subscriptionId: candidate.id, ownerUserId: candidate.owner_user_id, revision: lease?.revision || revision };
                        const status = await gateway.store.status(identity);
                        if (!status || status.revision !== identity.revision) return;
                        const delay = reconnectDelay((status?.retryAttempt || 0) + 1, result?.reasonCode, options.jitter || randomInt);
                        cooldowns.set(candidate.id, clock() + delay);
                        await gateway.store.recordRetry(identity, result?.reasonCode || 'X_PUSH_DISCONNECTED', delay);
                    })
                    .catch(() => {
                        // A failed metadata write must not cause an immediate
                        // reconnect storm. The next successful DB access persists it.
                        if (!stopped && !localController.signal.aborted) cooldowns.set(candidate.id, Math.max(cooldowns.get(candidate.id) || 0, clock() + 300000));
                    })
                    .finally(() => {
                        active = false;
                        if (sessions.get(candidate.id) === pending) { sessions.delete(candidate.id); leases.delete(candidate.id); }
                        if (sessionControls.get(candidate.id) === record) sessionControls.delete(candidate.id);
                    });
                sessions.set(candidate.id, pending);
            }
            const results = await Promise.allSettled([...leases.values()].map(drain));
            return { state: 'running', sessions: sessions.size, pending: results.filter(row => row.status === 'rejected').length };
        })();
        ticking = work;
        try { return await work; } finally { if (ticking === work) ticking = null; }
    }
    function start() {
        if (!enabled || !cadenceConfigured || stopped || timer) return;
        const schedule = () => {
            if (stopped) return;
            timer = setTimeout(async () => {
                timer = null;
                try { await tick(); } catch { /* The next bounded tick retries; no plaintext or endpoint is logged. */ }
                schedule();
            }, intervalMs);
            timer.unref?.();
        };
        schedule();
    }
    async function stop() {
        stopped = true; clearTimeout(timer); timer = null; controller.abort();
        for (const record of sessionControls.values()) record.controller.abort();
        let deadline;
        try { await Promise.race([Promise.allSettled([...sessions.values(), ...draining.values(), ...(ticking ? [ticking] : [])]),
            new Promise(resolve => { deadline = setTimeout(resolve, 5000); })]); }
        finally { clearTimeout(deadline); }
    }
    return { start, stop, tick, drain, status: () => ({ enabled, processingConfigured: cadenceConfigured, processingPolicy: mode, sessions: sessions.size, stopped }) };
}

// Web intake deliberately never imports or calls this constructor. Only the
// Bot's worker process may read a private key file, and only after explicit opt-in.
function createXPushRuntimeFromEnvironment(db, queue, options = {}) {
    const env = options.env || process.env;
    if (env.X_NOTIFICATION_RECEIVER_ENABLED !== '1') return createXPushRuntime(db, queue, { enabled: false });
    try {
        const fs = require('node:fs');
        const filename = env.X_NOTIFICATION_RECEIVER_KEY_FILE;
        if (typeof filename !== 'string' || !require('node:path').isAbsolute(filename)) throw new Error();
        const handle = fs.openSync(filename, 'r');
        let config;
        try {
            const stat = fs.fstatSync(handle);
            if (!stat.isFile() || stat.size < 1 || stat.size > 65536 || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error();
            const bytes = Buffer.alloc(stat.size + 1), length = fs.readSync(handle, bytes, 0, bytes.length, 0);
            if (length !== stat.size) throw new Error();
            config = JSON.parse(bytes.subarray(0, length).toString('utf8'));
        } finally { fs.closeSync(handle); }
        if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['activeKeyId', 'privateKeys'].includes(key))) throw new Error();
        const privateWorkerVault = require('./x-setup-transfer').createTransferPrivateWorkerVault(config);
        const gateway = require('./x-push-gateway').createXPushGateway(db, { enabled: true, privateWorkerVault });
        return createXPushRuntime(db, queue, { enabled: true, gateway, processingPolicy: env.X_NOTIFICATION_PROCESSING_POLICY,
            useLegacyUserInterval: env.ANGELIC_X_USE_LEGACY_USER_INTERVAL === '1',
            assertAllowed: options.assertAllowed || require('../recoveryLease').assertAllowed });
    } catch { throw Object.assign(new Error('X notification receiver configuration is unavailable'), { code: 'X_PUSH_WORKER_KEY_UNAVAILABLE' }); }
}

module.exports = { createXPushRuntime, createXPushRuntimeFromEnvironment, reconnectDelay };
