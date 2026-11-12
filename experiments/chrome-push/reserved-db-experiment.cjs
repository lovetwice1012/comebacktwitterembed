'use strict';

// Research only. Both ordinary and background work must use this exact pool;
// this is not wired into any worker or production DB factory. Reserving a
// client-pool connection cannot guarantee DB-server capacity or lock time.
const { AsyncLocalStorage } = require('node:async_hooks');
const failure = code => Object.assign(new Error(code), { code });
const uncertain = error => error?.fatal === true || /^PROTOCOL_|^ECONN|^ETIMEDOUT$/.test(String(error?.code || ''));

function createReservedDbExperiment({ pool, connectionLimit, reservedConnections = 1, maxWaiting = 100, queryTimeoutMs = 30000 }) {
    if (!pool || typeof pool.getConnection !== 'function' || !Number.isInteger(connectionLimit) || connectionLimit < 2 || connectionLimit > 64
        || Number(pool.config?.connectionLimit) !== connectionLimit
        || !Number.isInteger(reservedConnections) || reservedConnections < 1 || reservedConnections >= connectionLimit
        || !Number.isInteger(maxWaiting) || maxWaiting < 1 || maxWaiting > 20000
        || !Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 100 || queryTimeoutMs > 300000)
        throw failure('RESERVED_DB_CONFIG_INVALID');
    const context = new AsyncLocalStorage(), capacity = connectionLimit - reservedConnections, waiting = [];
    let active = 0, poisoned = 0, closed = false;
    function pump() {
        while (!closed && active + poisoned < capacity && waiting.length) {
            const item = waiting.shift(); item.signal?.removeEventListener('abort', item.onAbort);
            if (item.signal?.aborted) { item.reject(failure('RESERVED_DB_STOPPED')); continue; }
            active++; let returned = false;
            item.resolve(isUncertain => { if (returned) return; returned = true; active--; if (isUncertain) poisoned++; pump(); });
        }
    }
    function permit(signal) {
        if (closed || signal?.aborted) return Promise.reject(failure('RESERVED_DB_STOPPED'));
        if (waiting.length >= maxWaiting) return Promise.reject(failure('RESERVED_DB_QUEUE_FULL'));
        return new Promise((resolve, reject) => {
            const item = { resolve, reject, signal, onAbort: null };
            item.onAbort = () => { const index = waiting.indexOf(item); if (index >= 0) { waiting.splice(index, 1); reject(failure('RESERVED_DB_STOPPED')); } };
            signal?.addEventListener('abort', item.onAbort, { once: true }); waiting.push(item); pump();
            if (signal?.aborted) item.onAbort();
        });
    }
    async function checkout(root, operation) {
        const signal = root.signal;
        const returnPermit = await permit(signal); let connection, damaged = false, state;
        try {
            connection = await new Promise((resolve, reject) => pool.getConnection((error, value) => error ? reject(error) : resolve(value)));
            if (!connection) throw failure('RESERVED_DB_CONNECTION_INVALID');
            if (!root.active || signal?.aborted || closed) throw failure('RESERVED_DB_STOPPED');
            state = { invalid: false, pending: 0, rollbackOnly: false, commitSent: false };
            const run = (sql, params = [], cleanup = false) => {
                if (state.invalid || !cleanup && (!root.active || signal?.aborted || closed)) { state.rollbackOnly = true; return Promise.reject(failure('RESERVED_DB_STOPPED')); }
                state.pending++;
                return new Promise((resolve, reject) => {
                    const done = (error, rows) => {
                        state.pending--;
                        if (error) { state.rollbackOnly = true; if (uncertain(error)) damaged = true; reject(error); }
                        else if (state.invalid || !cleanup && (!root.active || signal?.aborted || closed)) { state.rollbackOnly = true; reject(failure('RESERVED_DB_STOPPED')); }
                        else resolve(rows);
                    };
                    try { connection.query({ sql, timeout: queryTimeoutMs }, params, done); }
                    catch (error) { done(error); }
                });
            };
            const result = await operation(run, state);
            // Fire-and-forget queries or a partially sent COMMIT must never be
            // returned to the common pool as a healthy connection.
            if (state.pending) { damaged = true; throw failure('RESERVED_DB_PENDING_QUERIES'); }
            state.invalid = true;
            return result;
        } catch (error) { if (uncertain(error)) damaged = true; throw error; }
        finally {
            if (state) { state.invalid = true; if (state.pending) damaged = true; }
            if (connection) {
                try { if (damaged) connection.destroy(); else connection.release(); }
                catch { damaged = true; try { connection.destroy(); } catch {} }
            }
            returnPermit(damaged);
        }
    }
    async function queryDatabase(sql, params = []) {
        const store = context.getStore();
        if (store?.transactionQuery) return store.transactionQuery(sql, params);
        if (!store) throw failure('RESERVED_DB_CONTEXT_REQUIRED');
        if (!store.root.active) throw failure('RESERVED_DB_STOPPED');
        return checkout(store.root, query => query(sql, params));
    }
    async function withDatabaseTransaction(work) {
        const store = context.getStore();
        if (!store || typeof work !== 'function') throw failure('RESERVED_DB_CONTEXT_REQUIRED');
        if (!store.root.active) throw failure('RESERVED_DB_STOPPED');
        if (store.transactionQuery) {
            try { return await work(store.transactionQuery); }
            catch (error) { store.state.rollbackOnly = true; throw error; }
        }
        return checkout(store.root, async (query, state) => {
            const transactionQuery = (sql, params) => query(sql, params);
            try {
                await query('START TRANSACTION');
                const value = await context.run({ root: store.root, transactionQuery, state }, () => work(transactionQuery));
                if (state.pending || state.rollbackOnly) throw failure('RESERVED_DB_ROLLBACK_ONLY');
                state.commitSent = true;
                try { await query('COMMIT'); } catch { const error = failure('RESERVED_DB_COMMIT_UNCERTAIN'); error.fatal = true; throw error; }
                return value;
            } catch (caught) {
                let error = caught instanceof Error ? caught : failure('RESERVED_DB_WORK_FAILED');
                if (!state.commitSent && !state.pending) {
                    try {
                        // Cleanup remains permitted after the caller aborts.
                        await query('ROLLBACK', [], true);
                    } catch { error = Object.assign(failure('RESERVED_DB_ROLLBACK_UNCERTAIN'), { fatal: true }); }
                } else error = Object.assign(failure(state.commitSent ? 'RESERVED_DB_COMMIT_UNCERTAIN' : 'RESERVED_DB_TRANSACTION_UNCERTAIN'), { fatal: true });
                throw error;
            }
        });
    }
    function runBackground(work, { signal } = {}) {
        if (typeof work !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)) throw failure('RESERVED_DB_CONFIG_INVALID');
        if (closed || signal?.aborted) return Promise.reject(failure('RESERVED_DB_STOPPED'));
        const root = { signal, active: true };
        return context.run({ root }, async () => { try { return await work(); } finally { root.active = false; } });
    }
    function stop() {
        closed = true;
        for (const item of waiting.splice(0)) { item.signal?.removeEventListener('abort', item.onAbort); item.reject(failure('RESERVED_DB_STOPPED')); }
    }
    return Object.freeze({ queryDatabase, withDatabaseTransaction, runBackground, stop,
        status: () => Object.freeze({ capacity, active, poisoned, waiting: waiting.length, stopped: closed }) });
}
module.exports = { createReservedDbExperiment };
