'use strict';

const { randomUUID, randomInt } = require('node:crypto');
const { evaluateXRollout } = require('./x-rollout-policy');
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
    const router = options.router || (enabled ? createXEventRouter(db, queue, { clock }) : null);
    const mode = resolveXProcessingPolicy(options.processingPolicy);
    const cadenceConfigured = mode !== null;
    const maxConnections = options.maxConnections ?? 1000, pageSize = options.pageSize ?? 100;
    const intervalMs = options.tickMs ?? 5000;
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 10000
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error('X_PUSH_RUNTIME_CONFIG_INVALID');
    const sessions = new Map(), leases = new Map(), draining = new Map(), cooldowns = new Map(), drainAgain = new Set();
    const controller = new AbortController(), workerId = `node-${randomUUID()}`;
    const rolloutOptions = options.rolloutMode === undefined ? {} : { mode: options.rolloutMode };
    let timer, ticking = null, stopped = false, cursor = '';
    const assertAllowed = options.assertAllowed || (() => { throw new Error('X_PUSH_AUTHORITY_UNAVAILABLE'); });
    const listCandidates = options.listCandidates || (async afterId => db.queryDatabase(`SELECT s.id,s.owner_user_id,s.revision FROM automation_x_subscriptions s
        LEFT JOIN automation_x_push_receivers r ON r.subscription_id=s.id
        WHERE s.id>? AND COALESCE(r.state,'awaiting')<>'requires_reenrollment' AND COALESCE(r.retry_at_ms,0)<=? AND EXISTS (SELECT 1 FROM automation_x_monitors m WHERE m.owner_user_id=s.owner_user_id AND m.enabled=1 AND m.state='ready'
          AND CASE WHEN JSON_VALID(m.notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(m.notification_settings_json,'$.subscriptionId')) ELSE NULL END=s.id)
        ORDER BY s.id LIMIT ?`, [afterId, clock(), pageSize]));

    async function drain(lease, trigger = {}) {
        if (!enabled || stopped || controller.signal.aborted || !cadenceConfigured) return { state: 'not_configured' };
        if (draining.has(lease.subscriptionId)) {
            if (trigger.received === true) drainAgain.add(lease.subscriptionId);
            return draining.get(lease.subscriptionId);
        }
        const work = (async () => {
            assertAllowed();
            const policy = await evaluateXRollout(db.queryDatabase, { userId: lease.ownerUserId }, rolloutOptions);
            if (!policy.eligible) return { state: 'pending', code: policy.reasonCode };
            let processed = 0;
            const resolveProcessing = query => inspectXProcessingSettings(query, lease.ownerUserId, clock(), {
                useLegacyUserInterval: options.useLegacyUserInterval === true,
            });
            for (;;) {
                const window = await gateway.store.beginProcessing(lease, undefined, {
                    resolveProcessing,
                });
                if (!window.ready) return { state: 'pending', ...(processed ? { processed } : {}), ...(window.code ? { code: window.code } : {}), ...(window.dueAtMs === undefined ? {} : { dueAtMs: window.dueAtMs }) };
                const rows = await gateway.store.listInbox({ ...lease, afterId: window.cursorId, limit: pageSize });
                let reachedCutoff = false;
                for (const inbox of rows) {
                    if (stopped || controller.signal.aborted) return { state: 'stopped' };
                    if (inbox.receivedAtMs > window.windowAtMs) { reachedCutoff = true; break; }
                    assertAllowed();
                    if (window.processingMode === 'realtime') {
                        // A mode/contract change between two receipts applies to
                        // the next admission, including within one loaded page.
                        const current = await gateway.store.beginProcessing(lease, undefined, { resolveProcessing });
                        if (!current.ready) return { state: 'pending', processed,
                            ...(current.code ? { code: current.code } : {}), ...(current.dueAtMs === undefined ? {} : { dueAtMs: current.dueAtMs }) };
                    }
                    await gateway.store.assertLease(lease);
                    try {
                        const payload = await gateway.decryptInbox(lease, inbox);
                        if (stopped || controller.signal.aborted) return { state: 'stopped' };
                        assertAllowed();
                        const result = await router.routeReceived({ lease, inbox, payload });
                        if (stopped || controller.signal.aborted) return { state: 'stopped' };
                        if (result.state === 'routed') await gateway.store.markRouted(lease, inbox.id);
                    } catch (error) {
                        if (stopped || controller.signal.aborted) return { state: 'stopped' };
                        assertAllowed();
                        // Unknown/DM/unsupported application payload is quarantined,
                        // never guessed to be a post and never reflected to Discord.
                        if (/^X_NOTIFICATION_(?:INVALID|UNSUPPORTED)/.test(String(error?.code || '')))
                            await gateway.store.markUnsupported(lease, inbox.id);
                        else throw error;
                    }
                    if (stopped || controller.signal.aborted) return { state: 'stopped' };
                    await gateway.store.advanceProcessing(lease, { windowAtMs: window.windowAtMs, cursorId: inbox.id });
                    processed++;
                }
                if (stopped || controller.signal.aborted) return { state: 'stopped' };
                if (reachedCutoff || rows.length < pageSize)
                    await gateway.store.completeProcessing(lease, { windowAtMs: window.windowAtMs });
                // Realtime recovers every retained page in this window immediately.
                // Each page rechecks current permission and owner mode under lock.
                // Batching keeps its existing finite page/cutoff behavior.
                // A new receipt can arrive while a batch window is already active
                // and its owner switches to realtime. Always revisit the trusted
                // resolver after that callback, irrespective of the old mode.
                if (drainAgain.delete(lease.subscriptionId)) continue;
                if (window.processingMode === 'realtime' && reachedCutoff
                    && rows.find(row => row.receivedAtMs > window.windowAtMs).receivedAtMs <= clock()) continue;
                if (window.processingMode !== 'realtime' || reachedCutoff || rows.length < pageSize)
                    return { state: 'processed', processed };
            }
        })();
        draining.set(lease.subscriptionId, work);
        try { return await work; } finally { if (draining.get(lease.subscriptionId) === work) { draining.delete(lease.subscriptionId); drainAgain.delete(lease.subscriptionId); } }
    }
    function remember({ lease }) { if (!stopped) { leases.set(lease.subscriptionId, lease); cooldowns.delete(lease.subscriptionId); } }
    async function tick() {
        if (!enabled || stopped || controller.signal.aborted) return { state: 'disabled' };
        if (!cadenceConfigured) return { state: 'not_configured', code: 'X_PUSH_PROCESSING_NOT_CONFIGURED' };
        if (ticking) return ticking;
        const work = (async () => {
            if (!gateway || typeof gateway.run !== 'function') throw new Error('X_PUSH_GATEWAY_UNAVAILABLE');
            assertAllowed();
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
                const rememberSession = value => { if (active && sessions.get(candidate.id) === pending) remember(value); };
                const pending = Promise.resolve().then(() => gateway.run({ subscriptionId: candidate.id, ownerUserId: candidate.owner_user_id,
                    workerId, signal: controller.signal, onSession: rememberSession, onLease: rememberSession,
                    onReceived: async ({ lease }) => { if (!active || sessions.get(candidate.id) !== pending || stopped) return; rememberSession({ lease }); await drain(lease, { received: true }); } }))
                    .catch(error => ({ state: 'error', reasonCode: /^X_PUSH_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'X_PUSH_CONNECTION_FAILED' }))
                    .then(async result => {
                        if (stopped || controller.signal.aborted || ['busy', 'requires_reenrollment'].includes(result?.state)) return;
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
                        if (!stopped) cooldowns.set(candidate.id, Math.max(cooldowns.get(candidate.id) || 0, clock() + 300000));
                    })
                    .finally(() => { active = false; if (sessions.get(candidate.id) === pending) { sessions.delete(candidate.id); leases.delete(candidate.id); } });
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
