'use strict';

// Optional processing of durable receipts while the push socket is absent.
// A caller must supply an enabled lease manager with verified fleet compatibility.
// No browser connection is opened and network retry state is not modified.
function createOfflineProcessingScheduler({ db, leaseManager, workerId, drain, authorize, assertAllowed,
    signal, clock = Date.now, pageSize = 100, concurrency = 16, listCandidates, isLocalSession = () => false,
    processingSnapshot, maxCooldowns = 2000, snapshotTimeoutMs = 1000 }) {
    if (!db || !leaseManager || typeof workerId !== 'string' || typeof drain !== 'function'
        || typeof authorize !== 'function' || typeof assertAllowed !== 'function' || !(signal instanceof AbortSignal)
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(concurrency)
        || concurrency < 1 || concurrency > 100 || typeof clock !== 'function' || processingSnapshot !== undefined && typeof processingSnapshot !== 'function'
        || !Number.isInteger(maxCooldowns) || maxCooldowns < 1 || maxCooldowns > 20000
        || !Number.isInteger(snapshotTimeoutMs) || snapshotTimeoutMs < 1 || snapshotTimeoutMs > 60000) throw new Error('X_PUSH_OFFLINE_CONFIG_INVALID');
    const active = new Map(), cooldowns = new Map(), snapshots = new Map();
    let cursor = '', stopped = false, scanning = null;
    const list = listCandidates || (async afterId => db.queryDatabase(`SELECT s.id,s.owner_user_id FROM automation_x_subscriptions s
        JOIN automation_x_push_receivers r ON r.subscription_id=s.id
        WHERE s.id>? AND r.state<>'requires_reenrollment' AND r.subscription_revision=s.revision
          AND (r.lease_token IS NULL OR r.lease_expires_at_ms<=?)
          AND (r.processing_lease_token IS NULL OR r.processing_lease_expires_at_ms<=?)
          AND EXISTS (SELECT 1 FROM automation_x_push_inbox i WHERE i.subscription_id=s.id AND i.subscription_revision=s.revision AND i.status='received')
          AND EXISTS (SELECT 1 FROM automation_x_monitors m WHERE m.owner_user_id=s.owner_user_id AND m.enabled=1 AND m.state='ready'
            AND CASE WHEN JSON_VALID(m.notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(m.notification_settings_json,'$.subscriptionId')) ELSE NULL END=s.id)
        ORDER BY s.id LIMIT ?`, [afterId, clock(), clock(), pageSize]));
    function readSnapshot(candidate) {
        if (!processingSnapshot) return Promise.resolve(null);
        const existing = snapshots.get(candidate.id);
        if (existing) return existing;
        // Timed-out reads retain their single flight until completion. When
        // that bounded set is full, skip the optimization and use the normal
        // transactional authorization and cadence checks instead.
        if (snapshots.size >= concurrency) return Promise.resolve(null);
        let timer, finish;
        const bounded = new Promise(resolve => { finish = resolve; timer = setTimeout(() => resolve(null), snapshotTimeoutMs); timer.unref?.(); });
        snapshots.set(candidate.id, bounded);
        Promise.resolve().then(() => processingSnapshot(candidate)).then(value => finish(value), () => finish(null)).finally(() => {
            clearTimeout(timer); if (snapshots.get(candidate.id) === bounded) snapshots.delete(candidate.id);
        });
        return bounded;
    }
    function start(candidate) {
        const local = new AbortController();
        const authorizeCandidate = query => authorize(query, candidate);
        const abort = () => local.abort();
        signal.addEventListener('abort', abort, { once: true });
        let timeout, renewTimer, lease;
        const stopTimers = () => { clearTimeout(timeout); clearTimeout(renewTimer); };
        function arm() {
            stopTimers();
            if (local.signal.aborted || !lease) return;
            const remaining = lease.expiresAtMs - clock();
            if (!Number.isFinite(remaining) || remaining <= 0) return abort();
            timeout = setTimeout(abort, remaining);
            timeout.unref?.();
            renewTimer = setTimeout(async () => {
                if (local.signal.aborted) return;
                try {
                    assertAllowed();
                    const updated = await leaseManager.renew(lease, { authorize: authorizeCandidate });
                    if (local.signal.aborted) return;
                    lease = updated;
                    arm();
                } catch { abort(); }
            }, Math.max(1, Math.floor(remaining / 3)));
            renewTimer.unref?.();
        }
        // Register the task before running any user-supplied authority check;
        // even a synchronous exception must remove the registered entry.
        const task = Promise.resolve().then(async () => {
            try {
                if (local.signal.aborted || stopped || signal.aborted) return;
                assertAllowed();
                const before = await readSnapshot(candidate);
                if (local.signal.aborted || stopped || signal.aborted) return;
                lease = await leaseManager.claim({ subscriptionId: candidate.id, ownerUserId: candidate.owner_user_id, workerId }, { authorize: authorizeCandidate });
                if (!lease || local.signal.aborted || stopped || signal.aborted) return;
                arm();
                // Bound a single turn so one backlog cannot monopolize a worker.
                const passes = Math.ceil(1040 / pageSize) + 2;
                for (let n = 0; n < passes && !local.signal.aborted && !stopped && !signal.aborted; n++) {
                    assertAllowed();
                    const result = await drain(lease, { recoverySignal: local.signal });
                    if (result.state === 'pending' && Number.isSafeInteger(result.dueAtMs) && result.dueAtMs > clock()
                        && before && before.realtime === false && processingSnapshot) {
                        const after = await readSnapshot(candidate);
                        if (!local.signal.aborted && !stopped && !signal.aborted && after && JSON.stringify(before) === JSON.stringify(after)) {
                            cooldowns.delete(candidate.id);
                            cooldowns.set(candidate.id, { dueAtMs: result.dueAtMs, snapshot: after });
                            while (cooldowns.size > maxCooldowns) cooldowns.delete(cooldowns.keys().next().value);
                        }
                    }
                    if (result.state !== 'processed' || Number(result.processed || 0) < pageSize) break;
                }
            } catch { /* Durable inbox and cursor remain for a later pass. */ }
            finally {
                abort(); stopTimers();
                if (lease) { try { await leaseManager.release(lease); } catch { /* Expiry or a newer owner is authoritative. */ } }
                signal.removeEventListener('abort', abort);
                active.delete(candidate.id);
            }
        });
        active.set(candidate.id, { task, abort });
    }
    async function tick() {
        if (stopped || signal.aborted) return { state: 'stopped', active: active.size };
        if (scanning) return scanning;
        const work = (async () => {
            assertAllowed();
            for (const [id, entry] of cooldowns) if (entry.dueAtMs <= clock()) cooldowns.delete(id);
            if (active.size >= concurrency) return { state: 'running', active: active.size };
            const page = await list(cursor);
            if (!Array.isArray(page) || page.length > pageSize) throw new Error('X_PUSH_RUNTIME_CANDIDATES_INVALID');
            // Do not advance past unstarted candidates when capacity fills.
            let examined = 0;
            for (const candidate of page) {
                if (stopped || signal.aborted || active.size >= concurrency) break;
                if (!candidate || typeof candidate.id !== 'string' || typeof candidate.owner_user_id !== 'string')
                    throw new Error('X_PUSH_RUNTIME_CANDIDATES_INVALID');
                cursor = candidate.id; examined++;
                if (active.has(candidate.id) || isLocalSession(candidate.id)) continue;
                const cooling = cooldowns.get(candidate.id);
                if (cooling && processingSnapshot) {
                    let current;
                    current = await readSnapshot(candidate);
                    if (stopped || signal.aborted) break;
                    if (current && JSON.stringify(current) === JSON.stringify(cooling.snapshot)) continue;
                    cooldowns.delete(candidate.id);
                }
                start(candidate);
            }
            if (examined === page.length && page.length < pageSize) cursor = '';
            return { state: 'running', active: active.size };
        })();
        scanning = work;
        try { return await work; } finally { if (scanning === work) scanning = null; }
    }
    function stop() { stopped = true; cooldowns.clear(); for (const value of active.values()) value.abort(); }
    return Object.freeze({ tick, stop, pending: () => [...active.values()].map(value => value.task), active: () => active.size });
}
module.exports = { createOfflineProcessingScheduler };
