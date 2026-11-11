'use strict';
// Child of the disposable Windows WNS fixture only. All input travels via
// the private parent IPC channel; never log keys, subscriptions or payloads.
if (process.env.NODE_ENV !== 'test' || process.platform !== 'win32' || typeof process.send !== 'function') process.exit(1);
const mysql = require('mysql');
const { createTransferPrivateWorkerVault, createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');

process.once('message', async input => {
    let pool;
    try {
        if (!input || !/^cbte_automation_test_[0-9a-f]{20}$/.test(input.schema)
            || !/^[0-9a-f-]{36}$/.test(input.subscriptionId) || input.ownerUserId !== '123456789'
            || typeof input.privateKey !== 'string' || !input.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')
            || input.expectedText !== undefined && !['synthetic-after-process-restart', 'synthetic-offline-queued'].includes(input.expectedText)
            || input.batch !== undefined && typeof input.batch !== 'boolean') throw new Error();
        pool = mysql.createPool({ host: '127.0.0.1', port: 33621, user: 'root', password: '', database: input.schema,
            connectionLimit: 4, supportBigNumbers: true, bigNumberStrings: true });
        const acquire = () => new Promise((resolve, reject) => pool.getConnection((error, connection) => error ? reject(error) : resolve(connection)));
        const queryOn = connection => (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
        const db = {
            async queryDatabase(sql, params) { const connection = await acquire(); try { return await queryOn(connection)(sql, params); } finally { connection.release(); } },
            async withDatabaseTransaction(work) {
                const connection = await acquire(), query = queryOn(connection);
                try { await query('START TRANSACTION'); const value = await work(query); await query('COMMIT'); return value; }
                catch (error) { await query('ROLLBACK'); throw error; } finally { connection.release(); }
            },
        };
        const keyConfig = { activeKeyId: 'test', privateKeys: { test: input.privateKey } };
        const gateway = createXPushGateway(db, { enabled: true, edgeEnabled: true, rolloutMode: 'public',
            privateWorkerVault: createTransferPrivateWorkerVault(keyConfig), edgeTokenVault: createWnsTokenWorkerVault(keyConfig) });
        const controller = new AbortController();
        let received = false, timer, checking = false, allSeenAt = 0, scanFailed = false, observedCount = 0;
        const deadline = setTimeout(() => {
            if (input.batch) process.send({ state: ['batch-timeout-zero', 'batch-timeout-one', 'batch-timeout-two', 'batch-timeout-three'][observedCount] });
            controller.abort();
        }, 30000);
        const batchTexts = ['synthetic-offline-1', 'synthetic-offline-2', 'synthetic-offline-3'];
        async function scanBatch(lease) {
            if (checking || controller.signal.aborted) return;
            checking = true;
            try {
                const rows = await gateway.store.listInbox({ ...lease, afterId: '0', limit: 100 });
                const counts = new Map(batchTexts.map(text => [text, 0]));
                for (const row of rows) {
                    const payload = await gateway.decryptInbox(lease, row);
                    if (counts.has(payload?.text)) counts.set(payload.text, counts.get(payload.text) + 1);
                }
                observedCount = [...counts.values()].filter(count => count > 0).length;
                if ([...counts.values()].some(count => count > 1)) {
                    process.send({ state: 'batch-duplicate' }); throw new Error();
                }
                if ([...counts.values()].every(count => count === 1)) {
                    if (!allSeenAt) allSeenAt = Date.now();
                    else if (Date.now() - allSeenAt >= 3000) {
                        received = true; process.send({ state: 'received' }); controller.abort();
                    }
                } else allSeenAt = 0;
            } catch { if (!scanFailed) process.send({ state: 'batch-scan-failed' }); scanFailed = true; controller.abort(); }
            finally { checking = false; }
        }
        try {
            await gateway.run({ subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId,
                workerId: 'synthetic-edge-restarted-process', signal: controller.signal,
                onSession: async ({ lease }) => {
                    process.send({ state: 'ready' });
                    if (input.batch) timer = setInterval(() => { void scanBatch(lease); }, 300);
                },
                onReceived: async event => {
                    if (input.batch) return;
                    if (event.payload?.text !== (input.expectedText || 'synthetic-after-process-restart')) throw new Error();
                    received = true; process.send({ state: 'received' }); controller.abort();
                } });
            if (!received || scanFailed) throw new Error();
        } finally { clearInterval(timer); clearTimeout(deadline); controller.abort(); }
        await new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve())); pool = null;
        process.disconnect();
    } catch {
        if (pool) await new Promise(resolve => pool.end(resolve));
        process.exitCode = 1; process.disconnect();
    }
});
