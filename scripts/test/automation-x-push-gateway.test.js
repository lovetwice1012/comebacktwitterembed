'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway, AUTOPUSH_URL } = require('../../src/automation/x-push-gateway');
const { insertSubscription, FakeSocket, encrypted, notification, vault } = require('./helpers/x-push-fixture.cjs');
const { WebSocket, WebSocketServer } = createRequire(path.resolve(__dirname, '../../packages/angelic-angel/package.json'))('ws');
const code = expected => error => error.code === expected;
async function setup(work) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try { for (const sql of require('../../src/automation/x-push-schema.sql').SCHEMA) await db.queryDatabase(sql); await work(db); }
    finally { await db.close(); }
}
function harness(db, subscription, server, options = {}) {
    let socket, calls = 0;
    const gateway = createXPushGateway(db, { enabled: true, privateWorkerVault: vault, rolloutMode: 'public', requestTimeoutMs: 150, ...options,
        createSocket: context => { calls++; assert.equal(context.url, AUTOPUSH_URL); assert.equal(context.options.maxPayload, 65536); return socket = new FakeSocket(server); } });
    return { gateway, run: more => gateway.run({ ...subscription, workerId: 'synthetic-worker', ...more }), get socket() { return socket; }, get calls() { return calls; } };
}
function hello(subscription, message, socket) {
    if (message.messageType !== 'hello') return false;
    assert.equal(message.uaid, subscription.file.push.uaid);
    socket.reply({ messageType: 'hello', status: 200, uaid: message.uaid, use_webpush: true }); return true;
}

test('worker requires explicit enablement, private vault, rollout and same owner before opening a socket', async () => setup(async db => {
    const subscription = await insertSubscription(db);
    let sockets = 0;
    const defaults = { privateWorkerVault: vault, rolloutMode: 'public', createSocket: () => { sockets++; throw new Error('must not connect'); } };
    await assert.rejects(createXPushGateway(db, defaults).run(subscription), code('X_PUSH_RECEIVER_DISABLED'));
    await assert.rejects(createXPushGateway(db, { ...defaults, enabled: true, privateWorkerVault: null }).run(subscription), code('X_PUSH_WORKER_KEY_UNAVAILABLE'));
    await assert.rejects(createXPushGateway(db, { ...defaults, enabled: true, rolloutMode: 'disabled' }).run(subscription), code('X_ROLLOUT_DISABLED'));
    await assert.rejects(createXPushGateway(db, { ...defaults, enabled: true }).run({ ...subscription, workerId: 'a', ownerUserId: '333333333333333333' }), code('X_PUSH_SUBSCRIPTION_NOT_FOUND'));
    assert.equal(sockets, 0);
}));

test('loopback WS decrypts both ECE schemes, commits before ACK, survives replay and recovers encrypted inbox after restart', async t => setup(async db => {
    const subscription = await insertSubscription(db), file = subscription.file;
    const payload = { notificationType: 'tweet', url: 'https://x.com/synthetic/status/123', author: { handle: 'synthetic', id: '123' }, text: 'PRIVATE-PLAINTEXT-SENTINEL' };
    const modern = await encrypted(file, payload), legacy = await encrypted(file, payload, true);
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
    const seen = [], ackChecks = [];
    server.on('connection', socket => socket.on('message', raw => {
        const message = JSON.parse(raw); seen.push(message);
        if (message.messageType === 'hello') {
            socket.send(JSON.stringify({ messageType: 'hello', status: 200, uaid: file.push.uaid, use_webpush: true }));
            for (const item of [notification(file, 'modern', modern), notification(file, 'legacy', legacy), notification(file, 'bad', { data: 'AA', headers: {} }), notification(file, 'bad', modern)]) socket.send(JSON.stringify(item));
        }
        if (message.messageType === 'ack') {
            ackChecks.push(db.queryDatabase('SELECT * FROM automation_x_push_inbox WHERE subscription_id=? AND version=?', [subscription.subscriptionId, message.updates[0].version]).then(rows => {
                assert.equal(rows.length, 1); assert.equal(Number(rows[0].ack_code), message.updates[0].code);
            }));
            if (seen.filter(row => row.messageType === 'ack').length === 4) socket.close(1000);
        }
    }));
    const received = [];
    const gateway = createXPushGateway(db, { enabled: true, privateWorkerVault: vault, rolloutMode: 'public', requestTimeoutMs: 1000,
        createSocket: context => { assert.equal(context.url, AUTOPUSH_URL); return new WebSocket(`ws://127.0.0.1:${server.address().port}/`, context.options); } });
    const result = await gateway.run({ ...subscription, workerId: 'loopback', onReceived: value => { received.push(value); throw new Error('APPLICATION ROUTE UNAVAILABLE'); } });
    assert.deepEqual(result, { state: 'stopped', reasonCode: null });
    await Promise.all(ackChecks);
    assert.deepEqual(seen.filter(row => row.messageType === 'ack').map(row => row.updates[0].code), [100, 100, 101, 101]);
    assert.equal(received.length, 2); assert.deepEqual(received[0].payload, payload); assert.deepEqual(received[1].payload, payload);
    assert(!seen.some(row => ['register', 'unregister'].includes(row.messageType)));
    const persisted = await db.queryDatabase('SELECT * FROM automation_x_push_inbox'); assert.equal(persisted.length, 3);
    const rendered = JSON.stringify({ inbox: persisted, audit: await db.queryDatabase('SELECT * FROM automation_audit'), status: await gateway.store.status(subscription) });
    for (const secret of [file.push.uaid, file.push.channelID, file.push.pushEndpoint, file.push.p256dhPrivateKey.d, file.push.authenticationSecret, payload.text]) assert(!rendered.includes(secret));
    const restarted = createXPushGateway(db, { enabled: true, privateWorkerVault: vault, rolloutMode: 'public' });
    const lease = await restarted.store.claim({ ...subscription, workerId: 'recovery' });
    const rows = await restarted.store.listInbox(subscription); assert.equal(rows.length, 2);
    assert.deepEqual(await restarted.decryptInbox(lease, rows[0]), payload);
    await assert.rejects(restarted.decryptInbox(lease, { ...rows[0], ownerUserId: '333333333333333333' }), code('X_PUSH_INBOX_INVALID'));
    await restarted.store.markRouted(lease, rows[0].id); await restarted.store.release(lease);
}));

test('changed UAID persists reenrollment and never REGISTERs, recreates keys or connects again', async () => setup(async db => {
    const subscription = await insertSubscription(db);
    const h = harness(db, subscription, (message, socket) => {
        if (message.messageType === 'hello') socket.reply({ messageType: 'hello', status: 200, uaid: 'ffffffffffffffffffffffffffffffff' });
    });
    await assert.rejects(h.run(), code('X_PUSH_UAID_CHANGED'));
    assert.equal((await h.gateway.store.status(subscription)).state, 'requires_reenrollment');
    assert.deepEqual(h.socket.sent.map(row => row.messageType), ['hello']);
    assert.equal((await h.run()).state, 'busy'); assert.equal(h.calls, 1);
    const rows = await db.queryDatabase('SELECT sealed_json FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]);
    assert.equal(rows[0].sealed_json, JSON.stringify(subscription.envelope));
}));

test('foreign channels are discarded before X decryption/replay/storage/routing and ACK 102 lets X continue', async () => setup(async db => {
    const subscription = await insertSubscription(db), file = subscription.file;
    const wire = await encrypted(file, { text: 'FOREIGN-PLAINTEXT-SENTINEL' });
    const foreignChannel = '11111111-1111-4111-8111-111111111111';
    const foreignData = { ...notification(file, 'known', wire), channelID: foreignChannel,
        headers: { ...wire.headers, arbitrary_foreign_header: 'FOREIGN-HEADER-SENTINEL' } };
    const store = createXPushStore(db);
    const seed = await store.claim({ ...subscription, workerId: 'seed' });
    await store.recordFrame(seed, { version: 'known', data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 }); await store.release(seed);
    let keyReads = 0, records = 0, foreignAcks = 0;
    const received = [];
    const trackedFile = { ...file, push: { ...file.push,
        get p256dhPublicKey() { keyReads++; return file.push.p256dhPublicKey; },
    } };
    const h = harness(db, subscription, (message, socket) => {
        if (hello(subscription, message, socket)) socket.reply(foreignData);
        if (message.messageType !== 'ack') return;
        if (message.updates[0].channelID === foreignChannel) {
            assert.equal(message.updates[0].code, 102);
            assert.equal(keyReads, 0); assert.equal(records, 0); assert.equal(received.length, 0);
            if (++foreignAcks === 1) socket.reply(foreignData);
            else socket.reply(notification(file, 'after-foreign', wire));
        } else socket.close(1000);
    }, { privateWorkerVault: { open: () => trackedFile }, store: { ...store,
        recordFrame: (...args) => { records++; return store.recordFrame(...args); },
    } });
    assert.deepEqual(await h.run({ onReceived: value => received.push(value) }), { state: 'stopped', reasonCode: null });
    assert.deepEqual(h.socket.sent.filter(row => row.messageType === 'ack').map(row => row.updates[0]), [
        { channelID: foreignChannel, version: 'known', code: 102 },
        { channelID: foreignChannel, version: 'known', code: 102 },
        { channelID: file.push.channelID, version: 'after-foreign', code: 100 },
    ]);
    assert.equal(keyReads, 1); assert.equal(records, 1); assert.equal(received.length, 1);
    assert(!h.socket.sent.some(row => ['register', 'unregister'].includes(row.messageType)));
    const rows = await db.queryDatabase('SELECT * FROM automation_x_push_inbox');
    assert.deepEqual(rows.map(row => row.version).sort(), ['after-foreign', 'known']);
    const persisted = JSON.stringify({ rows, audit: await db.queryDatabase('SELECT * FROM automation_audit'), status: await store.status(subscription) });
    for (const secret of [foreignChannel, 'FOREIGN-HEADER-SENTINEL', 'FOREIGN-PLAINTEXT-SENTINEL']) assert(!persisted.includes(secret));
}));

test('foreign-only encrypted notices leave no inbox, payload audit or application callback', async () => setup(async db => {
    const subscription = await insertSubscription(db), file = subscription.file;
    const wire = await encrypted(file, { text: 'DISCARDED-FOREIGN-PLAINTEXT' });
    const foreignChannel = '11111111-1111-4111-8111-111111111111';
    const store = createXPushStore(db);
    const h = harness(db, subscription, (message, socket) => {
        if (hello(subscription, message, socket)) socket.reply({ ...notification(file, 'FOREIGN-ONLY-VERSION', wire), channelID: foreignChannel });
        if (message.messageType === 'ack') socket.close(1000);
    }, { store: { ...store, recordFrame: () => { assert.fail('foreign data must never reach the inbox'); } },
        privateWorkerVault: { open: () => ({ ...file, push: { ...file.push,
            get p256dhPublicKey() { assert.fail('foreign data must never be decrypted'); },
        } }) },
    });
    await h.run({ onReceived: () => assert.fail('foreign data must never be routed') });
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    const persisted = JSON.stringify({ audit: await db.queryDatabase('SELECT * FROM automation_audit'), status: await store.status(subscription) });
    for (const secret of [foreignChannel, wire.data, 'FOREIGN-ONLY-VERSION', 'DISCARDED-FOREIGN-PLAINTEXT']) assert(!persisted.includes(secret));
}));

test('malformed foreign notifications still close without ACK or persistence', async () => setup(async db => {
    const subscription = await insertSubscription(db), file = subscription.file;
    const base = { messageType: 'notification', channelID: '11111111-1111-4111-8111-111111111111', version: 'foreign', data: 'AA', headers: {} };
    for (const [change, expected] of [
        [{ channelID: 'not-a-uuid' }, 'X_PUSH_PROTOCOL_INVALID'],
        [{ version: 'bad\nversion' }, 'X_PUSH_FRAME_INVALID'],
        [{ version: 'v'.repeat(257) }, 'X_PUSH_FRAME_INVALID'],
        [{ data: 'bad$base64' }, 'X_PUSH_FRAME_INVALID'],
        [{ headers: { encoding: 123 } }, 'X_PUSH_PROTOCOL_INVALID'],
    ]) {
        const h = harness(db, subscription, (message, socket) => { if (hello(subscription, message, socket)) socket.reply({ ...base, ...change }); });
        await assert.rejects(h.run(), code(expected));
        assert(!h.socket.sent.some(row => row.messageType === 'ack'));
    }
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
}));

test('foreign discard ACK is fenced by current ownership and rollout, including already connected sessions', async () => setup(async db => {
    for (const revoked of ['lease', 'rollout']) {
        const subscription = await insertSubscription(db);
        await grantTestDonor(db, subscription.ownerUserId);
        const h = harness(db, subscription, (message, socket) => {
            if (hello(subscription, message, socket)) socket.reply({ messageType: 'notification',
                channelID: '11111111-1111-4111-8111-111111111111', version: 'foreign', data: 'AA', headers: {} });
        }, { rolloutMode: 'supporters' });
        await assert.rejects(h.run({ onSession: () => revoked === 'lease'
            ? db.queryDatabase('UPDATE automation_x_push_receivers SET lease_token=? WHERE subscription_id=?', [randomBytes(32).toString('hex'), subscription.subscriptionId])
            : db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [subscription.ownerUserId]),
        }), code(revoked === 'lease' ? 'X_PUSH_LEASE_LOST' : 'X_PUSH_ROLLOUT_WITHDRAWN'));
        assert(!h.socket.sent.some(row => row.messageType === 'ack'));
    }
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
}));

test('receipt DB failure closes with no ACK; lost lease after commit also prevents ACK', async () => setup(async db => {
    const subscription = await insertSubscription(db), wire = await encrypted(subscription.file, { ok: true });
    const server = (message, socket) => { if (hello(subscription, message, socket)) socket.reply(notification(subscription.file, 'v1', wire)); };
    const store = createXPushStore(db);
    const failed = harness(db, subscription, server, { store: { ...store, recordFrame: async () => { throw new Error('SENSITIVE SQL SENTINEL'); } } });
    await assert.rejects(failed.run(), error => error.code === 'X_PUSH_RECEIVER_FAILED' && !error.stack.includes('SENSITIVE'));
    assert(!failed.socket.sent.some(row => row.messageType === 'ack'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    const lost = harness(db, subscription, server, { store: { ...store, recordFrame: async (...args) => {
        const result = await store.recordFrame(...args);
        await db.queryDatabase('UPDATE automation_x_push_receivers SET lease_token=? WHERE subscription_id=?', [randomBytes(32).toString('hex'), subscription.subscriptionId]);
        return result;
    } } });
    await assert.rejects(lost.run(), code('X_PUSH_LEASE_LOST'));
    assert(!lost.socket.sent.some(row => row.messageType === 'ack'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
}));

test('worker envelope is bound to subscription and owner; decrypt failure audits only safe metadata', async () => setup(async db => {
    const first = await insertSubscription(db), second = await insertSubscription(db);
    await db.queryDatabase('UPDATE automation_x_subscriptions SET sealed_json=? WHERE id=?', [JSON.stringify(first.envelope), second.subscriptionId]);
    const h = harness(db, second, () => { throw new Error('must not connect'); });
    await assert.rejects(h.run(), code('X_PUSH_VAULT_INVALID')); assert.equal(h.calls, 0);
    const audit = await db.queryDatabase("SELECT detail_json FROM automation_audit WHERE action='x.push.vault.open'");
    assert.deepEqual(audit.map(row => JSON.parse(row.detail_json)), [{ revision: 1, outcome: 'failed' }]);
}));

test('malformed, binary, oversized and flooded frames close without ACK', async () => setup(async db => {
    const cases = [
        { expected: 'X_PUSH_PROTOCOL_INVALID', send: socket => socket.reply('{') },
        { expected: 'X_PUSH_PROTOCOL_INVALID', send: socket => socket.emit('message', Buffer.from('binary'), true) },
        { expected: 'X_PUSH_FRAME_TOO_LARGE', send: socket => socket.reply(' '.repeat(65537)) },
        { expected: 'X_PUSH_BACKPRESSURE', send: socket => { for (let i = 0; i < 40; i++) socket.reply('{}'); } },
    ];
    for (const scenario of cases) {
        const subscription = await insertSubscription(db);
        const h = harness(db, subscription, (message, socket) => { if (hello(subscription, message, socket)) scenario.send(socket); });
        await assert.rejects(h.run(), code(scenario.expected));
        assert(!h.socket.sent.some(row => row.messageType === 'ack'));
    }
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
}));

test('HELLO timeout, unsupported response and missing app pong close safely', async () => setup(async db => {
    for (const [expected, server] of [
        ['X_PUSH_HELLO_FAILED', () => {}],
        ['X_PUSH_BACKOFF', (message, socket) => { if (message.messageType === 'hello') socket.close(4774); }],
        ['X_PUSH_PROTOCOL_INVALID', (message, socket) => { if (message.messageType === 'hello') socket.reply({ messageType: 'hello', status: 200, uaid: message.uaid, use_webpush: false }); }],
        ['X_PUSH_PONG_TIMEOUT', (message, socket) => hello(current, message, socket)],
    ]) {
        var current = await insertSubscription(db);
        const h = harness(db, current, server, { requestTimeoutMs: 30, pingIntervalMs: 30 });
        await assert.rejects(h.run(), code(expected));
        assert(!h.socket.sent.some(row => row.messageType === 'ack'));
    }
}));

test('lease renewal loss aborts a quiet socket and shutdown releases a lease despite a stalled router', async () => setup(async db => {
    const subscription = await insertSubscription(db), store = createXPushStore(db, { leaseMs: 100 });
    const lost = harness(db, subscription, (message, socket) => hello(subscription, message, socket), { store: { ...store, renew: async () => { throw new Error('DB DOWN'); } }, requestTimeoutMs: 500 });
    await assert.rejects(lost.run(), code('X_PUSH_LEASE_LOST'));
    assert.equal(lost.socket.readyState, 3);
    const wire = await encrypted(subscription.file, { ok: true }), controller = new AbortController();
    const stopped = harness(db, subscription, (message, socket) => { if (hello(subscription, message, socket)) socket.reply(notification(subscription.file, 'stopping', wire)); });
    const result = await stopped.run({ signal: controller.signal, onReceived: () => { controller.abort(); return new Promise(() => {}); } });
    assert.deepEqual(result, { state: 'stopped', reasonCode: null });
    assert.equal((await stopped.gateway.store.status(subscription)).state, 'stopped');
    assert.equal((await stopped.gateway.store.listInbox(subscription)).length, 1);
    const successor = await stopped.gateway.store.claim({ ...subscription, workerId: 'successor' }); assert(successor);
    await stopped.gateway.store.release(successor);
}));

test('loopback supporter withdrawal prevents the next durable receipt and ACK while an existing session is connected', async t => setup(async db => {
    const subscription = await insertSubscription(db), file = subscription.file;
    await grantTestDonor(db, subscription.ownerUserId);
    const wire = await encrypted(file, { ok: true });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
    const seen = [], serverWork = [];
    server.on('connection', socket => socket.on('message', raw => {
        const message = JSON.parse(raw); seen.push(message);
        if (message.messageType === 'hello') {
            socket.send(JSON.stringify({ messageType: 'hello', status: 200, uaid: file.push.uaid }));
            socket.send(JSON.stringify(notification(file, 'before-revoke', wire)));
        }
        if (message.messageType === 'ack') serverWork.push(db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [subscription.ownerUserId]).then(() => {
            socket.send(JSON.stringify(notification(file, 'after-revoke', wire)));
        }));
    }));
    const gateway = createXPushGateway(db, { enabled: true, privateWorkerVault: vault, rolloutMode: 'supporters', requestTimeoutMs: 1000,
        createSocket: context => new WebSocket(`ws://127.0.0.1:${server.address().port}/`, context.options) });
    await assert.rejects(gateway.run({ ...subscription, workerId: 'revoked-loopback' }), code('X_PUSH_ROLLOUT_WITHDRAWN'));
    await Promise.all(serverWork);
    assert.deepEqual(seen.filter(row => row.messageType === 'ack').map(row => row.updates[0].version), ['before-revoke']);
    assert.deepEqual((await db.queryDatabase('SELECT version FROM automation_x_push_inbox')).map(row => row.version), ['before-revoke']);
    assert.equal((await gateway.store.status(subscription)).reasonCode, 'X_PUSH_ROLLOUT_WITHDRAWN');
}));

test('quiet sessions recheck rollout at renewal; onSession enables recovery without a new frame and onLease exposes renewed ownership', async () => setup(async db => {
    const subscription = await insertSubscription(db), controller = new AbortController();
    let sessionLease, renewedLease;
    const h = harness(db, subscription, (message, socket) => hello(subscription, message, socket), { leaseMs: 300, requestTimeoutMs: 500 });
    const result = await h.run({ signal: controller.signal, onSession: ({ lease }) => { sessionLease = lease; }, onLease: async ({ lease }) => {
        renewedLease = lease;
        await h.gateway.store.assertLease(sessionLease);
        controller.abort();
    } });
    assert.equal(result.state, 'stopped'); assert(sessionLease); assert(renewedLease);
    assert.equal(renewedLease.token, sessionLease.token); assert(renewedLease.expiresAtMs > sessionLease.expiresAtMs);
    await grantTestDonor(db, subscription.ownerUserId);
    const quiet = harness(db, subscription, (message, socket) => hello(subscription, message, socket), { rolloutMode: 'supporters', leaseMs: 300, requestTimeoutMs: 500 });
    await assert.rejects(quiet.run({ onSession: () => db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [subscription.ownerUserId]) }), code('X_PUSH_ROLLOUT_WITHDRAWN'));
    assert(!quiet.socket.sent.some(row => row.messageType === 'ack'));
}));

test('lease expiry watchdog closes a quiet socket when a renewal operation stalls', async () => setup(async db => {
    const subscription = await insertSubscription(db), store = createXPushStore(db, { leaseMs: 150 });
    const h = harness(db, subscription, (message, socket) => hello(subscription, message, socket), { requestTimeoutMs: 500,
        store: { ...store, renew: () => new Promise(() => {}) } });
    const started = Date.now();
    await assert.rejects(h.run(), code('X_PUSH_LEASE_LOST'));
    assert.equal(h.socket.readyState, 3);
    assert(Date.now() - started < 1500);
    assert.equal((await store.status(subscription)).state, 'stopped');
}));

test('verified stored-UAID HELLO resets durable retry state before onSession; mismatched HELLO preserves retry history', async () => setup(async db => {
    let clock = 1000;
    const subscription = await insertSubscription(db), store = createXPushStore(db, { now: () => clock });
    await store.recordRetry({ ...subscription, revision: 1 }, 'X_PUSH_SOCKET_FAILED', 100);
    clock = 1100;
    let ready = false;
    const connected = harness(db, subscription, (message, socket) => { if (hello(subscription, message, socket)) socket.close(1000); }, { store, now: () => clock });
    await connected.run({ onSession: async () => {
        const status = await store.status(subscription); assert.equal(status.retryAtMs, null); assert.equal(status.retryAttempt, 0); ready = true;
    } });
    assert(ready);
    await store.recordRetry({ ...subscription, revision: 1 }, 'X_PUSH_SOCKET_FAILED', 100);
    clock = 1200;
    const mismatch = harness(db, subscription, (message, socket) => { if (message.messageType === 'hello') socket.reply({ messageType: 'hello', status: 200, uaid: '00000000000000000000000000000000' }); }, { store, now: () => clock });
    await assert.rejects(mismatch.run(), code('X_PUSH_UAID_CHANGED'));
    assert.equal((await store.status(subscription)).retryAttempt, 1);
}));
