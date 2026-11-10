'use strict';
// Child-side receiver for a disposable loopback database and synthetic FCM
// credentials only. Private material is supplied by parent IPC, never argv.
const mysql = require('mysql');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');

process.once('message', async input => {
    let pool;
    try {
        if (!input || !/^cbte_automation_test_[0-9a-f]{20}$/.test(input.schema || '') || !['first', 'contender', 'successor'].includes(input.worker)
            || typeof input.privateKey !== 'string' || !input.subscriptionId || !input.ownerUserId) throw new Error('FIXTURE_INPUT_INVALID');
        pool = mysql.createPool({ host: '127.0.0.1', port: 33631, user: 'root', password: '', database: input.schema,
            connectionLimit: 4, supportBigNumbers: true, bigNumberStrings: true });
        const context = new AsyncLocalStorage();
        const acquire = () => new Promise((resolve, reject) => pool.getConnection((error, connection) => error ? reject(error) : resolve(connection)));
        const queryOn = connection => (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
        const db = {
            queryDatabase: async (sql, params = []) => {
                if (context.getStore()) return context.getStore()(sql, params);
                const connection = await acquire(); try { return await queryOn(connection)(sql, params); } finally { connection.release(); }
            },
            withDatabaseTransaction: async work => {
                if (context.getStore()) return work(context.getStore());
                const connection = await acquire(), query = queryOn(connection);
                try { await query('START TRANSACTION'); const result = await context.run(query, () => work(query)); await query('COMMIT'); return result; }
                catch (error) { await query('ROLLBACK'); throw error; } finally { connection.release(); }
            },
        };
        const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture', privateKeys: { fixture: input.privateKey } });
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault,
            rolloutMode: 'public', requestTimeoutMs: 10000, leaseMs: input.productionTiming === true ? 30000 : 3000 });
        const controller = new AbortController();
        process.on('message', message => { if (message?.action === 'stop') controller.abort(); });
        const notify = ({ payload }) => {
                const label = payload?.text === 'synthetic-before-crash' ? 'before' : payload?.text === 'synthetic-during-failover' ? 'offline' : 'unexpected';
                process.send?.({ event: 'received', label });
            };
        if (input.supervisor === true) {
            let busyReported = false;
            const wrappedGateway = { ...gateway, run: async params => {
                const result = await gateway.run({ ...params,
                    onSession: async value => { process.send?.({ event: 'ready' }); await params.onSession?.(value); },
                    onReceived: async value => { notify(value); await params.onReceived?.(value); } });
                if (result.state === 'busy' && !busyReported) { busyReported = true; process.send?.({ event: 'busy' }); }
                return result;
            } };
            const queue = createQueue(db, {}, { rolloutMode: 'public' });
            const runtime = createXPushRuntime(db, queue, { enabled: true, gateway: wrappedGateway, rolloutMode: 'public',
                processingPolicy: 'batch', tickMs: input.productionTiming === true ? 5000 : 500, assertAllowed() {} });
            try { runtime.start(); await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); }
            finally { await runtime.stop(); }
            process.send?.({ event: 'done', state: 'stopped' });
        } else {
            const result = await gateway.run({ subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId, workerId: input.worker, signal: controller.signal,
                onSession: () => process.send?.({ event: 'ready' }), onReceived: notify });
            process.send?.({ event: 'done', state: result.state });
        }
    } catch (error) {
        process.send?.({ event: 'failure', code: /^X_[A-Z_]+$/.test(error?.code || '') ? error.code : 'FIXTURE_WORKER_FAILED' });
        process.exitCode = 1;
    } finally { if (pool) await new Promise(resolve => pool.end(resolve)); if (process.connected) process.disconnect(); }
});
