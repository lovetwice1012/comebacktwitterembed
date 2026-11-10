'use strict';
// Child process for disposable profiles and a random, loopback-only test DB.
// All synthetic keys and subscriptions arrive over private IPC, never argv.
const mysql = require('mysql');
const { AsyncLocalStorage } = require('node:async_hooks');
const https = require('node:https');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createSyntheticDurableReceiver } = require('./edge-fixture-durable.cjs');
const { independentSyntheticReconnect } = require('./edge-fixture-independent.cjs');
const { createQueue } = require('../../src/automation/queue');
const { createXEventRouter } = require('../../src/automation/x-event-router');
const notify = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(new Error('PROBE_IPC_FAILED')) : resolve()));

async function run(input) {
    let pool, key, channel, productKey, productId, publicKey, privateKey, auth;
    try {
        if (process.env.NODE_ENV !== 'test' || !input || !/^cbte_automation_test_[0-9a-f]{20}$/.test(input.schema || '')
            || input.dbPort !== 33621 || !['first', 'successor'].includes(input.worker)
            || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(input.scope || '')
            || !/^[0-9a-f-]{36}$/.test(input.subscriptionId || '') || !/^\d{1,32}$/.test(input.ownerUserId || '')) throw new Error('PROBE_WORKER_INPUT_INVALID');
        key = Buffer.from(input.deviceKey, 'base64'); channel = Buffer.from(input.channel, 'base64');
        productKey = Buffer.from(input.productKey, 'base64'); productId = Buffer.from(input.productId, 'base64');
        publicKey = Buffer.from(input.publicKey, 'base64'); privateKey = Buffer.from(input.privateKey, 'base64'); auth = Buffer.from(input.auth, 'base64');
        if (key.length !== 32 || !channel.length || channel.length > 256 || productKey.length !== 16 || productId.length !== 16
            || publicKey.length !== 65 || privateKey.length !== 32 || auth.length !== 16) throw new Error('PROBE_WORKER_INPUT_INVALID');
        pool = mysql.createPool({ host: '127.0.0.1', port: 33621, user: 'root', password: '', database: input.schema,
            connectionLimit: 4, supportBigNumbers: true, bigNumberStrings: true });
        const context = new AsyncLocalStorage();
        const acquire = () => new Promise((resolve, reject) => pool.getConnection((error, connection) => error ? reject(error) : resolve(connection)));
        const queryOn = connection => (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
        const db = {
            queryDatabase: async (sql, params = []) => { if (context.getStore()) return context.getStore()(sql, params);
                const connection = await acquire(); try { return await queryOn(connection)(sql, params); } finally { connection.release(); } },
            withDatabaseTransaction: async work => { if (context.getStore()) return work(context.getStore());
                const connection = await acquire(), query = queryOn(connection);
                try { await query('START TRANSACTION'); const result = await context.run(query, () => work(query)); await query('COMMIT'); return result; }
                catch (error) { await query('ROLLBACK'); throw error; } finally { connection.release(); } },
        };
        const store = createXPushStore(db, { leaseMs: 30000 });
        const identity = { subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId };
        const lease = await store.claim({ ...identity, workerId: `synthetic-wns-${input.worker}` });
        if (!lease) throw new Error('PROBE_WORKER_BUSY');
        const label = JSON.stringify({ notificationType: 'tweet', author: { id: '12345', handle: 'synthetic' },
            url: 'https://x.com/synthetic/status/1234567890123456789', text: 'synthetic-durable-event' });
        if (input.worker === 'successor') {
            const inbox = await store.getInbox({ ...identity, id: input.inboxId });
            if (!inbox || inbox.status !== 'received') throw new Error('PROBE_WORKER_RECEIPT_INVALID');
            const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
            const cipher = Buffer.from(inbox.data, 'base64url'); let payload;
            try {
                const plain = decryptEce(cipher, { encoding: 'aes128gcm' }, { public_key: [...publicKey], private_key: [...privateKey], auth_secret: [...auth] });
                try { if (!plain.equals(Buffer.from(label))) throw new Error('PROBE_WORKER_DECRYPT_FAILED'); payload = JSON.parse(plain.toString('utf8')); }
                finally { plain.fill(0); }
            } finally { cipher.fill(0); }
            const queue = createQueue(db, {}, { rolloutMode: 'public' }), router = createXEventRouter(db, queue);
            const result = await router.routeReceived({ lease, inbox, payload, processingMode: 'batch' });
            if (result.state !== 'routed') throw new Error('PROBE_WORKER_ROUTE_FAILED');
            await store.markRouted(lease, inbox.id);
            const inboxCount = Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n);
            const jobCount = Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n);
            if (inboxCount !== 1 || jobCount !== 1) throw new Error('PROBE_WORKER_ROUTE_FAILED');
            await notify({ event: 'recovered', pid: process.pid, inboxCount, jobCount });
            return;
        }
        const webpush = require('web-push');
        webpush.setVapidDetails('mailto:test@example.com', input.vapid.publicKey, input.vapid.privateKey);
        const send = async (subscription, message) => {
            const request = webpush.generateRequestDetails(subscription, message, { TTL: 60, contentEncoding: 'aes128gcm' }), endpoint = new URL(request.endpoint);
            if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.notify\.windows\.com$/i.test(endpoint.hostname)) throw new Error('PROBE_ENDPOINT_INVALID');
            await new Promise((resolve, reject) => {
                const req = https.request(endpoint, { method: 'POST', headers: request.headers, timeout: 15000 }, response => {
                    response.resume(); response.once('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error('PROBE_PUSH_FAILED')));
                });
                req.once('error', () => reject(new Error('PROBE_PUSH_FAILED'))); req.once('timeout', () => req.destroy()); req.end(request.body);
            });
            return Buffer.from(request.body);
        };
        const receiver = createSyntheticDurableReceiver({ scope: input.scope, store, lease, channel, authorize: async () => {},
            sendAck: async () => { throw new Error('PROBE_TARGET_ACK_UNEXPECTED'); },
            beforeAck: async saved => { await notify({ event: 'committed', pid: process.pid, inboxId: saved.id }); await new Promise(() => {}); } });
        await notify({ event: 'ready' });
        await independentSyntheticReconnect({ frames: null, key, token: input.token, productConstants: { key: productKey, id: productId },
            generatedHandshake: true, clientMetadata: input.clientMetadata, expectedChannel: channel,
            sendOtherNotification: () => send(input.otherSubscription, 'synthetic-independent-other'), sendNotification: () => send(input.subscription, label),
            decryptNotification: async () => { throw new Error('PROBE_TARGET_DECRYPT_UNEXPECTED'); },
            onTargetCiphertext: async (_ciphertext, frame) => receiver.receive(frame, 6) });
        throw new Error('PROBE_WORKER_STOP_EXPECTED');
    } catch (error) {
        await notify({ event: 'failure', code: /^PROBE_[A-Z_]+$/.test(error?.code || error?.message || '') ? (error.code || error.message) : 'PROBE_WORKER_FAILED' }).catch(() => {});
        process.exitCode = 1;
    } finally {
        for (const value of [key, channel, productKey, productId, publicKey, privateKey, auth]) value?.fill(0);
        if (pool) await new Promise(resolve => pool.end(resolve));
        if (process.connected) process.disconnect();
    }
}
if (typeof process.send !== 'function') { process.exitCode = 1; }
else process.once('message', input => { void run(input); });
