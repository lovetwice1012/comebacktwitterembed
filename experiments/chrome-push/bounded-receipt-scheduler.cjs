'use strict';

// Experimental only: this scheduler is not connected to a production worker.
// A deferred wake is only a hint; the caller must retain the durable inbox and
// revisit it fairly. Its executor must fence each database write and guard any
// COMMIT that was already sent when cancellation is observed.
function createBoundedReceiptScheduler({ concurrency, maxPending, execute, isCurrent, executionTimeoutMs, now = () => require('node:perf_hooks').performance.now() }) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100
        || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 20000
        || typeof execute !== 'function' || typeof isCurrent !== 'function' || typeof now !== 'function'
        || executionTimeoutMs !== undefined && (!Number.isInteger(executionTimeoutMs) || executionTimeoutMs < 1 || executionTimeoutMs > 300000))
        throw new Error('SCHEDULER_CONFIG_INVALID');
    const urgent = new Map(), periodic = new Map(), recoveryWait = new Map(), active = new Map();
    let stopped = false, pumpScheduled = false, preferUrgent = true, maxObserved = 0, timedOut = 0;
    const isUrgent = job => job.received || job.recovery;
    const queueFor = job => isUrgent(job) ? urgent : periodic;
    const totalPending = () => urgent.size + periodic.size;
    function queued(key) { return urgent.get(key) || periodic.get(key) || recoveryWait.get(key); }
    function remove(job) { urgent.delete(job.key); periodic.delete(job.key); recoveryWait.delete(job.key); }
    function settle(job, value) {
        if (job.settled) return;
        job.settled = true;
        for (const [signal, listener] of job.signals) signal.removeEventListener('abort', listener);
        job.signals.clear();
        job.resolve(value);
    }
    function bindSignal(job, signal) {
        if (!signal || job.signals.has(signal)) return;
        const listener = () => job.controller.abort();
        job.signals.set(signal, listener); signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) job.controller.abort();
    }
    function schedulePump() {
        if (stopped || pumpScheduled) return;
        pumpScheduled = true;
        queueMicrotask(() => { pumpScheduled = false; pump(); });
    }
    function current(key, token) {
        // The caller must consult a trusted in-process session identity. Never
        // infer ordering from random token bytes. DB fences remain mandatory.
        try { return isCurrent({ key, token }) === true; } catch { return false; }
    }
    const ticket = (accepted, promise, reason = null) => Object.freeze({ accepted, promise, reason });
    function offer({ key, token, received = false, periodic: batch = false, recovery = false, signal } = {}) {
        if (typeof key !== 'string' || !key || key.length > 128 || typeof token !== 'string' || !token || token.length > 128
            || typeof received !== 'boolean' || typeof batch !== 'boolean' || typeof recovery !== 'boolean'
            || !received && !batch && !recovery || signal !== undefined && !(signal instanceof AbortSignal)
            || recovery && !signal)
            throw new Error('SCHEDULER_REQUEST_INVALID');
        if (stopped || signal?.aborted) return ticket(false, Promise.resolve({ state: 'stopped' }), 'stopped');
        if (!current(key, token)) return ticket(false, Promise.resolve({ state: 'stale' }), 'stale');
        const running = active.get(key);
        if (running && running.job.token !== token) running.controller.abort();
        let item = queued(key);
        if (item && item.token !== token) {
            remove(item); item.controller.abort(); settle(item, { state: 'superseded' }); item = undefined;
        }
        if (item) {
            // Reserve a signal slot specifically for the sole recovery
            // callback for this lease. A second distinct recovery is an
            // explicit error, never a falsely successful deferred wake.
            if (recovery && item.recoverySignal && item.recoverySignal !== signal)
                return ticket(false, Promise.resolve({ state: 'recovery_failed', code: 'SCHEDULER_DUPLICATE_RECOVERY' }), 'recovery_conflict');
            const nonRecoverySignals = item.signals.size - (item.recoverySignal && item.signals.has(item.recoverySignal) ? 1 : 0);
            if (!recovery && signal && !item.signals.has(signal) && nonRecoverySignals >= 2) return ticket(false, Promise.resolve({ state: 'deferred' }), 'signal_limit');
            const previousUrgent = isUrgent(item);
            item.received ||= received; item.periodic ||= batch; item.recovery ||= recovery;
            if (recovery) item.recoverySignal = signal;
            // A coalesced recovery awaits the same work as prior hints. Any
            // owner/recovery cancellation cancels the work for all callers;
            // the durable inbox remains available for the next lease.
            bindSignal(item, signal);
            if (item.settled) return ticket(false, item.promise, 'stopped');
            if (!previousUrgent && isUrgent(item) && periodic.has(key)) { periodic.delete(key); urgent.set(key, item); }
            schedulePump(); return ticket(true, item.promise);
        }
        // Use an available worker before rejecting an ordinary wake. A queue
        // can be full solely with follow-ups to subscriptions already active.
        if (totalPending() >= maxPending && active.size < concurrency) pump();
        const waitingForCapacity = totalPending() >= maxPending;
        const directSlot = waitingForCapacity && !recovery && active.size < concurrency && !active.has(key);
        if (waitingForCapacity && !recovery && !directSlot) return ticket(false, Promise.resolve({ state: 'deferred' }), 'full');
        if (waitingForCapacity && recoveryWait.size >= maxPending)
            return ticket(false, Promise.resolve({ state: 'recovery_failed', code: 'SCHEDULER_RECOVERY_CAPACITY' }), 'recovery_capacity');
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        item = { key, token, received, periodic: batch, recovery, recoverySignal: recovery ? signal : undefined,
            controller: new AbortController(), signals: new Map(), promise, resolve, settled: false };
        item.controller.signal.addEventListener('abort', () => {
            if (queued(key) === item) { remove(item); settle(item, { state: 'stopped' }); }
        }, { once: true });
        if (waitingForCapacity && recovery) recoveryWait.set(key, item); else queueFor(item).set(key, item);
        bindSignal(item, signal);
        if (directSlot) {
            // Synchronous pump removes a runnable item before returning, so
            // the externally observable queue never exceeds its bound.
            pump();
            if (totalPending() > maxPending) { remove(item); settle(item, { state: 'deferred' }); return ticket(false, promise, 'full'); }
        }
        maxObserved = Math.max(maxObserved, totalPending() + recoveryWait.size);
        schedulePump(); return ticket(true, promise);
    }
    function promoteRecoveryWaiters() {
        while (recoveryWait.size && totalPending() < maxPending) {
            const item = recoveryWait.values().next().value;
            recoveryWait.delete(item.key);
            if (item.controller.signal.aborted) settle(item, { state: 'stopped' });
            else urgent.set(item.key, item);
        }
    }
    function pump() {
        if (stopped) return;
        promoteRecoveryWaiters();
        while (active.size < concurrency && (totalPending() || recoveryWait.size)) {
            let job;
            // A queued wake can belong to an already-running subscription.
            // Do not let it hide a runnable recovery waiter from a free slot.
            for (const group of preferUrgent ? [recoveryWait, urgent, periodic] : [periodic, recoveryWait, urgent]) {
                for (const candidate of group.values()) {
                    if (!active.has(candidate.key)) { job = candidate; break; }
                }
                if (job) break;
            }
            if (!job) return;
            remove(job); promoteRecoveryWaiters(); preferUrgent = !isUrgent(job);
            if (job.controller.signal.aborted) { settle(job, { state: 'stopped' }); continue; }
            if (!current(job.key, job.token)) { settle(job, { state: 'stale' }); continue; }
            const controller = job.controller;
            active.set(job.key, { job, controller, startedAt: now() });
            // A timeout requests cancellation but never fabricates a free slot.
            // The underlying DB operation may continue after socket closure.
            const timer = executionTimeoutMs === undefined ? null : setTimeout(() => {
                if (!controller.signal.aborted) { timedOut++; controller.abort(); }
            }, executionTimeoutMs);
            Promise.resolve().then(() => {
                if (stopped || controller.signal.aborted) return { state: 'stopped' };
                if (!current(job.key, job.token)) return { state: 'stale' };
                return execute({ key: job.key, token: job.token, received: job.received,
                    periodic: job.periodic, recovery: job.recovery, signal: controller.signal });
            }).then(value => settle(job, controller.signal.aborted ? { state: 'cancelled_uncertain' } : value),
                () => settle(job, controller.signal.aborted ? { state: 'cancelled_uncertain' } : { state: 'failed' })).finally(() => {
                if (timer) clearTimeout(timer);
                if (active.get(job.key)?.job === job) active.delete(job.key);
                schedulePump();
            });
        }
    }
    function stop() {
        if (stopped) return;
        stopped = true;
        for (const job of [...urgent.values(), ...periodic.values(), ...recoveryWait.values()]) { remove(job); job.controller.abort(); settle(job, { state: 'stopped' }); }
        for (const value of active.values()) value.controller.abort();
    }
    function cancel(key, token) {
        if (typeof key !== 'string' || !key || typeof token !== 'string' || !token) throw new Error('SCHEDULER_REQUEST_INVALID');
        const running = active.get(key), item = queued(key);
        if (running?.job.token === token) running.controller.abort();
        if (item?.token === token) { remove(item); item.controller.abort(); settle(item, { state: 'stopped' }); }
        schedulePump();
    }
    function status() {
        const earliest = Math.min(...[...active.values()].map(item => item.startedAt));
        return Object.freeze({ stopped, active: active.size, pending: totalPending(), recoveryWaiting: recoveryWait.size, maxObserved,
            saturated: active.size >= concurrency, oldestActiveMs: active.size ? Math.max(0, now() - earliest) : 0, timedOut });
    }
    return Object.freeze({ offer, enqueue: input => offer(input).promise, cancel, stop, status });
}

// Experimental scan over the caller's current owned sessions. A full queue
// leaves the next key unvisited; the next scan resumes immediately after the
// last accepted key instead of repeatedly starting at the beginning.
function createFairLeaseScanner(scheduler) {
    if (!scheduler || typeof scheduler.offer !== 'function') throw new Error('SCANNER_CONFIG_INVALID');
    let cursor = '';
    function scan(sessions) {
        if (!Array.isArray(sessions) || sessions.length > 10000 || sessions.some(row => !row || typeof row.key !== 'string' || !row.key || row.key.length > 128
            || typeof row.token !== 'string' || !row.token || row.token.length > 128 || row.signal !== undefined && !(row.signal instanceof AbortSignal))) throw new Error('SCANNER_INPUT_INVALID');
        const sorted = [...sessions].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        if (sorted.some((row, i) => i > 0 && sorted[i - 1].key === row.key)) throw new Error('SCANNER_INPUT_INVALID');
        if (!sorted.length) { cursor = ''; return { accepted: 0, full: false }; }
        let start = sorted.findIndex(row => row.key > cursor);
        if (start < 0) start = 0;
        let accepted = 0;
        for (let offset = 0; offset < sorted.length; offset++) {
            const row = sorted[(start + offset) % sorted.length];
            if (row.signal?.aborted) { cursor = row.key; continue; }
            const result = scheduler.offer({ key: row.key, token: row.token, periodic: true, signal: row.signal });
            // Every periodic offer resolves to a fixed state, including an
            // executor failure. Reattaching catch on each scan would retain
            // unbounded handlers while a coalesced job is stalled.
            if (!result.accepted && result.reason === 'full') return { accepted, full: true };
            if (!result.accepted && result.reason === 'stopped' && scheduler.status().stopped) return { accepted, full: false };
            if (!result.accepted) { cursor = row.key; continue; }
            accepted++; cursor = row.key;
        }
        return { accepted, full: false };
    }
    return Object.freeze({ scan, cursor: () => cursor });
}
module.exports = { createBoundedReceiptScheduler, createFairLeaseScanner };
