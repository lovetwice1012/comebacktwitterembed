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
const { createSyntheticStateVault } = require('./edge-fixture-state-vault.cjs');
const { createSyntheticTokenStateStore } = require('./edge-fixture-state-store.cjs');
const { createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
const notify = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(new Error('PROBE_IPC_FAILED')) : resolve()));
async function syntheticSend(subscription, message, vapid) {
    const webpush = require('web-push');
    webpush.setVapidDetails('mailto:test@example.com', vapid.publicKey, vapid.privateKey);
    const request = webpush.generateRequestDetails(subscription, message, { TTL: 60, contentEncoding: 'aes128gcm' }), endpoint = new URL(request.endpoint);
    if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.notify\.windows\.com$/i.test(endpoint.hostname)) throw new Error('PROBE_ENDPOINT_INVALID');
    await new Promise((resolve, reject) => {
        const req = https.request(endpoint, { method: 'POST', headers: request.headers, timeout: 15000 }, response => {
            response.resume(); response.once('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error('PROBE_PUSH_FAILED')));
        });
        req.once('error', () => reject(new Error('PROBE_PUSH_FAILED'))); req.once('timeout', () => req.destroy()); req.end(request.body);
    });
    return Buffer.from(request.body);
}

async function run(input) {
    let pool, key, channel, productKey, productId, publicKey, privateKey, auth;
    try {
        if (process.env.NODE_ENV !== 'test' || !input || !/^cbte_automation_test_[0-9a-f]{20}$/.test(input.schema || '')
            || input.dbPort !== 33621 || !['first', 'successor'].includes(input.worker)
            || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(input.scope || '')
            || !/^[0-9a-f-]{36}$/.test(input.subscriptionId || '') || !/^\d{1,32}$/.test(input.ownerUserId || '')) throw new Error('PROBE_WORKER_INPUT_INVALID');
        key = Buffer.from(input.deviceKey, 'base64'); channel = Buffer.from(input.channel, 'base64');
        if (input.boundMode !== undefined && (input.boundMode !== true || !input.useGateway || input.productKey !== undefined || input.productId !== undefined)) throw new Error('PROBE_WORKER_INPUT_INVALID');
        if (!input.boundMode) { productKey = Buffer.from(input.productKey, 'base64'); productId = Buffer.from(input.productId, 'base64'); }
        publicKey = Buffer.from(input.publicKey, 'base64'); privateKey = Buffer.from(input.privateKey, 'base64'); auth = Buffer.from(input.auth, 'base64');
        if (key.length !== 32 || !channel.length || channel.length > 256 || !input.boundMode && (productKey.length !== 16 || productId.length !== 16)
            || publicKey.length !== 65 || privateKey.length !== 32 || auth.length !== 16) throw new Error('PROBE_WORKER_INPUT_INVALID');
        pool = mysql.createPool({ host: '127.0.0.1', port: 33621, user: 'root', password: '', database: input.schema,
            connectionLimit: 4, supportBigNumbers: true, bigNumberStrings: true });
        const context = new AsyncLocalStorage();
        const acquire = () => new Promise((resolve, reject) => pool.getConnection((error, connection) => error ? reject(error) : resolve(connection)));
        const queryOn = connection => (sql, params = []) => new Promise((resolve, reject) => connection.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
        const db = { schema: input.schema, fixturePort: 33621,
            queryDatabase: async (sql, params = []) => { if (context.getStore()) return context.getStore()(sql, params);
                const connection = await acquire(); try { return await queryOn(connection)(sql, params); } finally { connection.release(); } },
            withDatabaseTransaction: async work => { if (context.getStore()) return work(context.getStore());
                const connection = await acquire(), query = queryOn(connection);
                try { await query('START TRANSACTION'); const result = await context.run(query, () => work(query)); await query('COMMIT'); return result; }
                catch (error) { await query('ROLLBACK'); throw error; } finally { connection.release(); } },
        };
        const store = createXPushStore(db, { leaseMs: 30000 });
        if (input.stateEnabled && (typeof input.statePrivateKey !== 'string' || input.statePrivateKey.length > 16384)
            || input.productionState && !input.stateEnabled || input.useGateway && !input.productionState) throw new Error('PROBE_WORKER_INPUT_INVALID');
        let state = null, productionVault;
        if (input.stateEnabled && input.productionState) {
            productionVault = createWnsTokenWorkerVault({ activeKeyId: 'synthetic1', privateKeys: { synthetic1: input.statePrivateKey } });
            state = { save: (current, token, expectedGeneration, authorize) => store.saveWnsTokenState(current, { vault: productionVault, token, expectedGeneration, authorize }),
                read: (current, authorize) => store.readWnsTokenState(current, { vault: productionVault, authorize }) };
        } else if (input.stateEnabled) state = createSyntheticTokenStateStore(db, { vault: createSyntheticStateVault(input.statePrivateKey) });
        async function assertTokenEncrypted(token) {
            const sql = input.productionState ? 'SELECT wns_token_sealed_json AS sealed_json FROM automation_x_push_receivers WHERE subscription_id=?'
                : 'SELECT sealed_json FROM cbte_fixture_wns_state WHERE subscription_id=?';
            const row = (await db.queryDatabase(sql, [input.subscriptionId]))[0];
            if (!row || typeof row.sealed_json !== 'string' || row.sealed_json.includes(token.toString('ascii'))) throw new Error('PROBE_WORKER_STATE_INVALID');
        }
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
            let reconnected = null, stateGeneration = null;
            if (state) {
                const saved = await state.read(lease, async () => {});
                if (!saved || saved.generation !== 1) throw new Error('PROBE_WORKER_STATE_INVALID');
                const nextLabel = JSON.stringify({ notificationType: 'tweet', author: { id: '12345', handle: 'synthetic' },
                    url: 'https://x.com/synthetic/status/1234567890123456790', text: 'synthetic-reconnected-event' });
                let nextInboxId;
                const receiver = input.useGateway ? null : createSyntheticDurableReceiver({ scope: input.scope, store, lease, channel, authorize: async () => {},
                    beforeAck: async savedReceipt => { nextInboxId = savedReceipt.id; }, sendAck: async () => {} });
                try {
                    if (input.useGateway) {
                        const { runEdgeWnsGateway } = require('../../src/automation/edge-wns-gateway');
                        const controller = new AbortController(); let expectedNext, delivered = 0;
                        const instrumented = { ...store,
                            async saveWnsTokenState(current, options) { const updated = await store.saveWnsTokenState(current, options);
                                stateGeneration = updated.generation; await assertTokenEncrypted(options.token); return updated; },
                            async recordFrame(current, entry, options) { const result = await store.recordFrame(current, entry, options);
                                if (!expectedNext || entry.data !== expectedNext.toString('base64url')) throw new Error('PROBE_WORKER_RECEIPT_INVALID');
                                nextInboxId = result.id; return result; } };
                        const timeout = setTimeout(() => controller.abort(), 30000);
                        try {
                            await runEdgeWnsGateway({ store: instrumented, lease, vault: productionVault, authorize: async () => {}, signal: controller.signal,
                                credentials: { agent: { os: 'Windows 10', osVersion: '10.0.00000', architecture: 'x86_64', locale: 'en' },
                                    client: input.clientMetadata, deviceKey: key, reconnectToken: saved.token,
                                    ...(input.boundMode ? { authenticationMode: 'bound' } : { productKey, productId }), siteChannel: channel },
                                onReady: async () => { expectedNext = await syntheticSend(input.subscription, nextLabel, input.vapid); },
                                onReceived: async () => { delivered++; controller.abort(); } });
                            if (delivered !== 1) throw new Error('PROBE_WORKER_RECONNECT_FAILED');
                            reconnected = { notificationReceived: true, matchesSentCiphertext: true, payloadDecrypted: true, ackWritten: true };
                        } finally { clearTimeout(timeout); expectedNext?.fill(0); }
                    } else reconnected = await independentSyntheticReconnect({ frames: null, key, token: saved.token.toString('ascii'),
                        productConstants: { key: productKey, id: productId }, generatedHandshake: true, clientMetadata: input.clientMetadata,
                        expectedChannel: channel, ackSingle: true,
                        onRotatedToken: async token => {
                            const updated = await state.save(lease, token, 1, async () => {}); stateGeneration = updated.generation;
                            await assertTokenEncrypted(token);
                        },
                        sendNotification: () => syntheticSend(input.subscription, nextLabel, input.vapid),
                        decryptNotification: async ciphertext => {
                            const plain = decryptEce(ciphertext, { encoding: 'aes128gcm' }, { public_key: [...publicKey], private_key: [...privateKey], auth_secret: [...auth] });
                            try { return plain.equals(Buffer.from(nextLabel)); } finally { plain.fill(0); }
                        },
                        onTargetCiphertext: async (_ciphertext, frame) => receiver.receive(frame, 5) });
                    if (!reconnected.notificationReceived || !reconnected.matchesSentCiphertext || !reconnected.payloadDecrypted || !reconnected.ackWritten
                        || stateGeneration !== 2 || !nextInboxId) throw new Error('PROBE_WORKER_RECONNECT_FAILED');
                    const nextInbox = await store.getInbox({ ...identity, id: nextInboxId });
                    const nextCipher = Buffer.from(nextInbox.data, 'base64url'); let nextPlain;
                    try { nextPlain = decryptEce(nextCipher, { encoding: 'aes128gcm' }, { public_key: [...publicKey], private_key: [...privateKey], auth_secret: [...auth] });
                        if (!nextPlain.equals(Buffer.from(nextLabel))) throw new Error('PROBE_WORKER_DECRYPT_FAILED'); }
                    finally { nextCipher.fill(0); nextPlain?.fill(0); }
                    if ((await router.routeReceived({ lease, inbox: nextInbox, payload: JSON.parse(nextLabel), processingMode: 'batch' })).state !== 'routed')
                        throw new Error('PROBE_WORKER_ROUTE_FAILED');
                    await store.markRouted(lease, nextInbox.id);
                } finally { receiver?.close(); saved.token.fill(0); }
            }
            const inboxCount = Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n);
            const jobCount = Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n);
            if (inboxCount !== (state ? 2 : 1) || jobCount !== (state ? 2 : 1)) throw new Error('PROBE_WORKER_ROUTE_FAILED');
            await notify({ event: 'recovered', pid: process.pid, inboxCount, jobCount, reconnected: state ? Boolean(reconnected?.notificationReceived) : null, stateGeneration });
            return;
        }
        if (input.useGateway) {
            const { runEdgeWnsGateway } = require('../../src/automation/edge-wns-gateway');
            const controller = new AbortController(), initialToken = Buffer.from(input.token, 'ascii');
            const instrumented = { ...store,
                async saveWnsTokenState(current, options) { const result = await store.saveWnsTokenState(current, options); await assertTokenEncrypted(options.token); return result; },
                async recordFrame(current, entry, options) { const saved = await store.recordFrame(current, entry, options);
                    await notify({ event: 'committed', pid: process.pid, inboxId: saved.id }); await new Promise(() => {}); return saved; } };
            try {
                await notify({ event: 'ready' });
                await runEdgeWnsGateway({ store: instrumented, lease, vault: productionVault, authorize: async () => {}, signal: controller.signal,
                    credentials: { agent: { os: 'Windows 10', osVersion: '10.0.00000', architecture: 'x86_64', locale: 'en' },
                        client: input.clientMetadata, deviceKey: key, reconnectToken: initialToken,
                        ...(input.boundMode ? { authenticationMode: 'bound' } : { productKey, productId }), siteChannel: channel },
                    onReady: async () => {
                        const other = await syntheticSend(input.otherSubscription, 'synthetic-independent-other', input.vapid); other.fill(0);
                        const target = await syntheticSend(input.subscription, label, input.vapid); target.fill(0);
                    } });
            } finally { initialToken.fill(0); }
            throw new Error('PROBE_WORKER_STOP_EXPECTED');
        }
        const receiver = createSyntheticDurableReceiver({ scope: input.scope, store, lease, channel, authorize: async () => {},
            sendAck: async () => { throw new Error('PROBE_TARGET_ACK_UNEXPECTED'); },
            beforeAck: async saved => { await notify({ event: 'committed', pid: process.pid, inboxId: saved.id }); await new Promise(() => {}); } });
        await notify({ event: 'ready' });
        await independentSyntheticReconnect({ frames: null, key, token: input.token, productConstants: { key: productKey, id: productId },
            generatedHandshake: true, clientMetadata: input.clientMetadata, expectedChannel: channel,
            ...(state ? { onRotatedToken: async token => {
                await state.save(lease, token, 0, async () => {});
                await assertTokenEncrypted(token);
            } } : {}),
            sendOtherNotification: () => syntheticSend(input.otherSubscription, 'synthetic-independent-other', input.vapid), sendNotification: () => syntheticSend(input.subscription, label, input.vapid),
            decryptNotification: async () => { throw new Error('PROBE_TARGET_DECRYPT_UNEXPECTED'); },
            onTargetCiphertext: async (_ciphertext, frame) => receiver.receive(frame, 6) });
        throw new Error('PROBE_WORKER_STOP_EXPECTED');
    } catch (error) {
        const code = error?.code || error?.message || '';
        const safe = /^(?:PROBE|X_PUSH|X_SETUP|X_EDGE_WNS)_[A-Z_]+$/.test(code) ? code
            : /^(?:ER_BAD_FIELD_ERROR|ER_NO_SUCH_TABLE|ER_DATA_TOO_LONG|ER_PARSE_ERROR|ER_DUP_ENTRY)$/.test(code) ? `PROBE_WORKER_${code}`
                : error?.name === 'TypeError' ? 'PROBE_WORKER_TYPE_ERROR' : error?.name === 'RangeError' ? 'PROBE_WORKER_RANGE_ERROR' : 'PROBE_WORKER_FAILED';
        await notify({ event: 'failure', code: safe }).catch(() => {});
        process.exitCode = 1;
    } finally {
        for (const value of [key, channel, productKey, productId, publicKey, privateKey, auth]) value?.fill(0);
        if (pool) await new Promise(resolve => pool.end(resolve));
        if (process.connected) process.disconnect();
    }
}
if (typeof process.send !== 'function') { process.exitCode = 1; }
else process.once('message', input => { void run(input); });
