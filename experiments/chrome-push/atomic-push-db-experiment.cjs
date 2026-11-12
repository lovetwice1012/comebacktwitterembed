'use strict';

// Research-only adapter. NEVER wire this into a worker: destroying a local
// socket does not guarantee that an executing SQL statement stops or that its
// server-side locks are released. The real MariaDB experiment demonstrates it.
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const fault = code => Object.assign(new Error(code), { code });

function createAtomicPushDatabase(pool, { acquireTimeoutMs = 1000, transactionTimeoutMs = 5000, monotonic = () => performance.now() } = {}) {
    if (!pool || typeof pool.getConnection !== 'function' || typeof monotonic !== 'function'
        || !Number.isInteger(acquireTimeoutMs) || acquireTimeoutMs < 1 || acquireTimeoutMs > 30000
        || !Number.isInteger(transactionTimeoutMs) || transactionTimeoutMs < 1 || transactionTimeoutMs > 30000)
        throw fault('X_PUSH_ATOMIC_CONFIG_INVALID');
    const context = new AsyncLocalStorage();
    let occupied = false;

    async function acquire() {
        if (occupied) throw fault('X_PUSH_ATOMIC_BUSY');
        occupied = true;
        return new Promise((resolve, reject) => {
            let late = false;
            const timer = setTimeout(() => { late = true; reject(fault('X_PUSH_ATOMIC_ACQUIRE_TIMEOUT')); }, acquireTimeoutMs);
            const done = (error, connection) => {
                clearTimeout(timer);
                if (late) { if (connection) connection.release(); occupied = false; return; }
                if (error || !connection) { occupied = false; reject(fault('X_PUSH_ATOMIC_ACQUIRE_FAILED')); return; }
                resolve(connection);
            };
            try { pool.getConnection(done); } catch { done(fault('X_PUSH_ATOMIC_ACQUIRE_FAILED')); }
        });
    }

    async function run(work, { signal } = {}) {
        if (typeof work !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)) throw fault('X_PUSH_ATOMIC_CONFIG_INVALID');
        if (signal?.aborted) throw fault('X_PUSH_ATOMIC_STOPPED');
        const connection = await acquire();
        let valid = true, rollbackOnly = false, commitSent = false, timer, terminate;
        const deadline = monotonic() + transactionTimeoutMs;
        const scope = {
            assert() {
                if (!valid || signal?.aborted) throw fault('X_PUSH_ATOMIC_STOPPED');
                if (monotonic() >= deadline) { terminate('X_PUSH_ATOMIC_TIMEOUT'); throw fault('X_PUSH_ATOMIC_TIMEOUT'); }
            },
            async query(sql, params = []) {
                scope.assert();
                try {
                    const result = await new Promise((resolve, reject) => connection.query({ sql, timeout: transactionTimeoutMs }, params,
                        (error, rows) => error ? reject(error) : resolve(rows)));
                    scope.assert();
                    return result;
                } catch (error) { rollbackOnly = true; throw error; }
            },
            failed() { rollbackOnly = true; },
        };
        const aborted = new Promise((_, reject) => {
            terminate = code => {
                if (!valid) return;
                valid = false;
                try { connection.destroy(); } catch { /* Never reuse an uncertain connection. */ }
                reject(fault(commitSent ? 'X_PUSH_ATOMIC_COMMIT_UNCERTAIN' : code));
            };
            timer = setTimeout(() => terminate('X_PUSH_ATOMIC_TIMEOUT'), transactionTimeoutMs);
        });
        const onAbort = () => terminate('X_PUSH_ATOMIC_STOPPED');
        signal?.addEventListener('abort', onAbort, { once: true });
        const task = (async () => {
            try {
                scope.assert();
                await scope.query('START TRANSACTION');
                const value = await context.run(scope, () => work(scope.query));
                scope.assert();
                if (rollbackOnly) throw fault('X_PUSH_ATOMIC_ROLLBACK_ONLY');
                // A COMMIT already sent may succeed after cancellation or a
                // transport failure. Dedupe and cursor state remain the
                // authoritative recovery mechanism for that case.
                commitSent = true;
                try { await scope.query('COMMIT'); }
                catch { throw fault('X_PUSH_ATOMIC_COMMIT_UNCERTAIN'); }
                return value;
            } catch (error) {
                if (valid && !commitSent) {
                    try { await scope.query('ROLLBACK'); }
                    catch { try { connection.destroy(); } catch {} valid = false; }
                } else if (valid && commitSent) { try { connection.destroy(); } catch {} valid = false; }
                throw error;
            }
        })();
        try { return await Promise.race([task, aborted]); }
        finally {
            clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
            if (valid) { valid = false; connection.release(); }
            occupied = false;
        }
    }
    async function queryDatabase(sql, params) {
        const scope = context.getStore();
        if (!scope) throw fault('X_PUSH_ATOMIC_CONTEXT_REQUIRED');
        return scope.query(sql, params);
    }
    async function withDatabaseTransaction(work) {
        const scope = context.getStore();
        if (!scope) throw fault('X_PUSH_ATOMIC_CONTEXT_REQUIRED');
        scope.assert();
        try { return await work(scope.query); }
        catch (error) { scope.failed(); throw error; }
    }
    return Object.freeze({ run, queryDatabase, withDatabaseTransaction });
}
module.exports = { createAtomicPushDatabase };
