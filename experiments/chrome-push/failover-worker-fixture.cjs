'use strict';
// Child-side receiver for a disposable loopback database and synthetic FCM
// credentials only. Private material is supplied by parent IPC, never argv.
const mysql = require('mysql');
const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter } = require('node:events');
const { createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');

const stdio = process.argv[2] === '--stdio', controls = new EventEmitter();
const emit = value => { if (stdio) process.stdout.write(JSON.stringify(value) + '\n'); else process.send?.(value); };
async function run(input) {
    let pool;
    try {
        if (!input || !/^cbte_automation_test_[0-9a-f]{20}$/.test(input.schema || '') || !['first', 'contender', 'successor'].includes(input.worker)
            || ![33621, 33631].includes(input.dbPort)
            || typeof input.privateKey !== 'string' || !input.subscriptionId || !input.ownerUserId) throw new Error('FIXTURE_INPUT_INVALID');
        pool = mysql.createPool({ host: '127.0.0.1', port: input.dbPort, user: 'root', password: '', database: input.schema,
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
        controls.on('message', message => { if (message?.action === 'stop') controller.abort(); if (message?.action === 'crash') process.kill(process.pid, 'SIGKILL'); });
        const notify = ({ payload }) => {
                const label = payload?.text === 'synthetic-before-crash' ? 'before' : payload?.text === 'synthetic-during-failover' ? 'offline' : 'unexpected';
                emit({ event: 'received', label });
            };
        if (input.supervisor === true) {
            let busyReported = false;
            const wrappedGateway = { ...gateway, run: async params => {
                const result = await gateway.run({ ...params,
                    onSession: async value => { emit({ event: 'ready' }); await params.onSession?.(value); },
                    onReceived: async value => { notify(value); await params.onReceived?.(value); } });
                if (result.state === 'busy' && !busyReported) { busyReported = true; emit({ event: 'busy' }); }
                return result;
            } };
            const queue = createQueue(db, {}, { rolloutMode: 'public' });
            const runtime = createXPushRuntime(db, queue, { enabled: true, gateway: wrappedGateway, rolloutMode: 'public',
                processingPolicy: 'batch', tickMs: input.productionTiming === true ? 5000 : 500, assertAllowed() {} });
            try { runtime.start(); await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); }
            finally { await runtime.stop(); }
            emit({ event: 'done', state: 'stopped' });
        } else {
            const result = await gateway.run({ subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId, workerId: input.worker, signal: controller.signal,
                onSession: () => emit({ event: 'ready' }), onReceived: notify });
            emit({ event: 'done', state: result.state });
        }
    } catch (error) {
        emit({ event: 'failure', code: /^X_[A-Z_]+$/.test(error?.code || '') ? error.code : 'FIXTURE_WORKER_FAILED' });
        process.exitCode = 1;
    } finally { if (pool) await new Promise(resolve => pool.end(resolve)); if (stdio) process.stdin.destroy(); else if (process.connected) process.disconnect(); }
}
if (stdio) {
    const lines = require('node:readline').createInterface({ input: process.stdin }); let started = false;
    lines.on('line', line => {
        if (line.length > 32768) { process.exitCode = 1; lines.close(); return; }
        try { const message = JSON.parse(line); if (!started) { started = true; void run(message); } else controls.emit('message', message); }
        catch { process.exitCode = 1; lines.close(); }
    });
} else {
    process.once('message', input => { void run(input); });
    process.on('message', message => controls.emit('message', message));
}
