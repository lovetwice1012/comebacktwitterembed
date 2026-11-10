'use strict';

// Process-local aggregates only: never retain SQL, parameters, user IDs or
// provider payloads. Bucket upper bounds are milliseconds; the last bucket
// means greater than 30 seconds and is reported separately.
const BOUNDS = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000]);

function createDatabaseMetrics(options = {}) {
    const bounds = options.bounds || BOUNDS;
    const capMs = options.capMs || 300000;
    let count = 0, failures = 0, totalMs = 0, maximumMs = 0;
    const buckets = Array(bounds.length + 1).fill(0);
    function record(milliseconds, failed = false) {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
        const duration = Math.min(milliseconds, capMs);
        count++; if (failed) failures++;
        totalMs += duration; maximumMs = Math.max(maximumMs, duration);
        const index = bounds.findIndex(bound => milliseconds <= bound);
        buckets[index < 0 ? bounds.length : index]++;
    }
    function snapshot() {
        const rank = Math.ceil(count * 0.95);
        let cumulative = 0, percentileUpperMs = null;
        if (count) for (let i = 0; i < buckets.length; i++) {
            cumulative += buckets[i];
            if (cumulative >= rank) { percentileUpperMs = i < bounds.length ? bounds[i] : null; break; }
        }
        return { window: 'process_lifetime', count, failures, totalMs: Math.round(totalMs), maximumMs: Math.round(maximumMs),
            p95UpperMs: percentileUpperMs, overLastBucket: buckets.at(-1), bucketUpperMs: [...bounds], buckets: [...buckets] };
    }
    return { record, snapshot };
}

const shared = createDatabaseMetrics();
const xLatency = Object.freeze({ batch: createDatabaseMetrics({ bounds: [1000, 5000, 30000, 60000, 300000, 1800000, 10800000, 86400000], capMs: 86400000 }),
    realtime: createDatabaseMetrics({ bounds: [1000, 5000, 30000, 60000, 300000, 1800000, 10800000, 86400000], capMs: 86400000 }) });
const lagBounds = [1000, 5000, 30000, 60000, 300000, 1800000, 10800000, 86400000];
const deliveryLag = Object.freeze(Object.fromEntries(['auto', 'price', 'x', 'xReceived'].map(key => [key, createDatabaseMetrics({ bounds: lagBounds, capMs: 86400000 })])));
const sourceLag = Object.freeze({ auto: createDatabaseMetrics({ bounds: lagBounds, capMs: 86400000 }), price: createDatabaseMetrics({ bounds: lagBounds, capMs: 86400000 }) });
const apiLatency = Object.freeze(Object.fromEntries(['monitors', 'x', 'billing', 'plans', 'history', 'other'].map(key => [key, createDatabaseMetrics()])));
function createPoolRegistry() {
    const pools = new Set();
    function register(pool, limit) { if (pool && typeof pool === 'object') pools.add({ ref: new WeakRef(pool), limit }); }
    function snapshot() {
        let total = 0, free = 0, waiting = 0, limit = 0, observed = 0;
        for (const entry of pools) {
            const pool = entry.ref.deref(); if (!pool) { pools.delete(entry); continue; }
            if (!Array.isArray(pool._allConnections) || !Array.isArray(pool._freeConnections) || !Array.isArray(pool._connectionQueue)) continue;
            observed++; total += pool._allConnections.length; free += pool._freeConnections.length;
            waiting += pool._connectionQueue.length; limit += entry.limit;
        }
        return { available: observed > 0, total: observed ? total : null, busy: observed ? Math.max(0, total - free) : null,
            waiting: observed ? waiting : null, limit: observed ? limit : null };
    }
    return { register, snapshot };
}
const poolRegistry = createPoolRegistry();
function apiCategory(path) {
    const first = Array.isArray(path) ? path[0] : null;
    if (['x-monitors', 'x-monitor-quota', 'x-setup', 'x-processing-settings'].includes(first)) return 'x';
    return ['monitors', 'billing', 'plans', 'history'].includes(first) ? first : 'other';
}
module.exports = { createDatabaseMetrics, createPoolRegistry, poolRegistry, shared, xLatency, deliveryLag, sourceLag, apiLatency, apiCategory };
