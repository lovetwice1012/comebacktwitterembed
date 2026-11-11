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
            || typeof input.privateKey !== 'string' || !input.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error();
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
        const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 30000); let received = false;
        try {
            await gateway.run({ subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId,
                workerId: 'synthetic-edge-restarted-process', signal: controller.signal,
                onSession: async () => { process.send({ state: 'ready' }); },
                onReceived: async event => {
                    if (event.payload?.text !== 'synthetic-after-process-restart') throw new Error();
                    received = true; process.send({ state: 'received' }); controller.abort();
                } });
            if (!received) throw new Error();
        } finally { clearTimeout(deadline); controller.abort(); }
        await new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve())); pool = null;
        process.disconnect();
    } catch {
        if (pool) await new Promise(resolve => pool.end(resolve));
        process.exitCode = 1; process.disconnect();
    }
});
