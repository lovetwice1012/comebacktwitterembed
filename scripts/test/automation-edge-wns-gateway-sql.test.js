'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, generateKeyPairSync, randomBytes } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { insertSubscription, fixture, encrypted, vault } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
const { EventEmitter } = require('node:events');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const skipped = !port;
function edgeFixture() {
    const original = fixture(), key = original.push.p256dhPrivateKey, application = createECDH('prime256v1'); application.generateKeys();
    return { format: original.format, version: 3,
        provenance: { kind: 'edge-wns', adapterVersion: '1.0.0', browserVersion: '157.0.0.1', readMethod: 'edge-wns-snapshot' },
        push: { scope: 'https://x.com/', siteChannel: 'target', deviceKey: randomBytes(32).toString('base64url'), reconnectToken: 'synthetic-token',
            agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' },
            p256dhPublicKey: original.push.p256dhPublicKey, authenticationSecret: original.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d },
            applicationServerKey: application.getPublicKey().toString('base64url') } };
}
function frame(command, body = '') { const payload = Buffer.from(`MS-CV: synthetic\r\n\r\n${body}`); return Buffer.concat([Buffer.from(`${command} ${payload.length}\r\n`), payload]); }
function notification(site, cipher, id = site) {
    const payload = Buffer.concat([Buffer.from(`Channel: ${site}\r\nMsg-Id: fixture-${id}\r\nContent-Encoding: aes128gcm\r\n\r\n`), Buffer.from(cipher.data, 'base64url')]);
    return Buffer.concat([Buffer.from(`NFY 5 WNS\\NOTIF ${payload.length}\r\n`), payload]);
}
async function setup(work) { const db = await createTestDatabase(port); try { await work(db); } finally { await db.close(); } }
function tokenVault() {
    const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
    return createWnsTokenWorkerVault({ activeKeyId: 'synthetic1', privateKeys: { synthetic1: keys.privateKey } });
}
test('Edge worker is gated before opening an Edge or Firefox connection', { skip: skipped }, async () => setup(async db => {
    const sub = await insertSubscription(db, edgeFixture()); await db.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [sub.subscriptionId]);
    let opened = 0;
    const gateway = createXPushGateway(db, { enabled: true, privateWorkerVault: vault, rolloutMode: 'public', edgeTokenVault: tokenVault(),
        createSocket: () => { opened++; throw new Error('unexpected Firefox connection'); }, createEdgeTransport: () => { opened++; throw new Error('unexpected Edge connection'); } });
    await assert.rejects(gateway.run({ ...sub, workerId: 'edge-fixture' }), { code: 'X_PUSH_PROTOCOL_INVALID' }); assert.equal(opened, 0);
}));
test('version 2 worker is separately gated and uses its persisted version when enabled', { skip: skipped }, async () => setup(async db => {
    const file = edgeFixture(); file.push.connectVersion = '2';
    const sub = await insertSubscription(db, file); await db.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [sub.subscriptionId]);
    let opened = 0, connectPacket, received; const controller = new AbortController(), cipher = await encrypted(file, { text: 'fixture-v2' });
    const incoming = [frame('CNT 1 CON', '<connect/>'), frame('ATH 2 CON'),
        frame('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>new-token</reconnect-token></wns>'), notification('target', cipher)];
    const transport = { async connect() {}, async send(data) { if (!connectPacket) connectPacket = Buffer.from(data); },
        async next() { return incoming.shift(); }, close() {} };
    const opts = { enabled: true, edgeEnabled: true, edgeTokenVault: tokenVault(), privateWorkerVault: vault,
        rolloutMode: 'public', requestTimeoutMs: 3000, createEdgeTransport: () => { opened++; return transport; } };
    const gated = createXPushGateway(db, opts);
    await assert.rejects(gated.run({ ...sub, workerId: 'edge-v2-gated' }), { code: 'X_PUSH_PROTOCOL_INVALID' });
    assert.equal(opened, 0);
    const gateway = createXPushGateway(db, { ...opts, edgeConnectV2Enabled: true });
    try {
        const result = await gateway.run({ ...sub, workerId: 'edge-v2-enabled', signal: controller.signal,
            onReceived: event => { received = event; controller.abort(); } });
        assert.deepEqual(result, { state: 'stopped', reasonCode: null });
        assert(connectPacket.includes(Buffer.from('<connect><ver>2</ver>')));
        assert.equal(received.payload.text, 'fixture-v2');
    } finally { connectPacket?.fill(0); }
}));
test('Edge worker commits ciphertext before ACK and routes a decrypted owned notification', { skip: skipped }, async () => setup(async db => {
    const sub = await insertSubscription(db, edgeFixture()); await db.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [sub.subscriptionId]);
    const expected = { notificationType: 'tweet', text: 'fixture' }, cipher = await encrypted(sub.file, expected), controller = new AbortController();
    const incoming = [frame('CNT 1 CON', '<connect/>'), frame('ATH 2 CON'),
        frame('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>new-token</reconnect-token></wns>'),
        notification('other', cipher), notification('target', cipher)];
    const sends = []; let received, ready = 0;
    const transport = { async connect() {}, async send(data) {
        const command = data.subarray(0, data.indexOf(' ')).toString('ascii'); sends.push(command);
        if (command === 'ACK' && sends.filter(x => x === 'ACK').length === 2) {
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 1);
        }
    }, async next() { if (!incoming.length) throw Object.assign(new Error('timeout'), { code: 'X_EDGE_WNS_RECEIVE_TIMEOUT' }); return incoming.shift(); }, close() {} };
    const gateway = createXPushGateway(db, { enabled: true, edgeEnabled: true, edgeTokenVault: tokenVault(), privateWorkerVault: vault,
        rolloutMode: 'public', requestTimeoutMs: 3000, createEdgeTransport: () => transport });
    const result = await gateway.run({ ...sub, workerId: 'edge-fixture', signal: controller.signal, onSession: () => { ready++; },
        onReceived: event => { received = event; controller.abort(); } });
    assert.deepEqual(result, { state: 'stopped', reasonCode: null }); assert.equal(ready, 1); assert.deepEqual(received.payload, expected);
    assert.deepEqual(sends, ['CNT', 'ATH', 'BND', 'ACK', 'ACK']);
    const rows = await db.queryDatabase('SELECT * FROM automation_x_push_inbox'); assert.equal(rows.length, 1);
    const status = await gateway.store.status(sub); assert.equal(status.state, 'stopped');
}));
test('revoked supporter access stops Edge before persisting or acknowledging a notification', { skip: skipped }, async () => setup(async db => {
    const sub = await insertSubscription(db, edgeFixture()); await db.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [sub.subscriptionId]);
    await grantTestDonor(db, sub.ownerUserId);
    const cipher = await encrypted(sub.file, { text: 'fixture' });
    const incoming = [frame('CNT 1 CON', '<connect/>'), frame('ATH 2 CON'),
        frame('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>new-token</reconnect-token></wns>'), notification('target', cipher)];
    const sends = [];
    const transport = { async connect() {}, async send(data) { sends.push(data.subarray(0, data.indexOf(' ')).toString('ascii')); },
        async next() { return incoming.shift(); }, close() {} };
    const gateway = createXPushGateway(db, { enabled: true, edgeEnabled: true, edgeTokenVault: tokenVault(), privateWorkerVault: vault,
        rolloutMode: 'supporters', requestTimeoutMs: 3000, createEdgeTransport: () => transport });
    await assert.rejects(gateway.run({ ...sub, workerId: 'edge-fixture',
        onSession: () => db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [sub.ownerUserId]) }), { code: 'X_PUSH_ROLLOUT_WITHDRAWN' });
    assert(!sends.includes('ACK')); assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 0);
}));
test('slow delivery callbacks do not block persistence of a burst of Edge notifications', { skip: skipped }, async () => setup(async db => {
    const sub = await insertSubscription(db, edgeFixture()); await db.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [sub.subscriptionId]);
    const cipher = await encrypted(sub.file, { text: 'burst-fixture' }), controller = new AbortController();
    const incoming = [frame('CNT 1 CON', '<connect/>'), frame('ATH 2 CON'),
        frame('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>new-token</reconnect-token></wns>'),
        ...Array.from({ length: 25 }, (_, index) => notification('target', cipher, String(index)))];
    let callbacks = 0, acks = 0, release, burstDone, lastInbox; const gate = new Promise(resolve => { release = resolve; });
    const persisted = new Promise(resolve => { burstDone = resolve; });
    const transport = { async connect() {}, async send(data) {
        if (data.subarray(0, data.indexOf(' ')).toString('ascii') === 'ACK' && ++acks === 25) burstDone();
    }, async next() { if (!incoming.length) { await new Promise(resolve => setTimeout(resolve, 10)); throw Object.assign(new Error('timeout'), { code: 'X_EDGE_WNS_RECEIVE_TIMEOUT' }); } return incoming.shift(); }, close() {} };
    const gateway = createXPushGateway(db, { enabled: true, edgeEnabled: true, edgeTokenVault: tokenVault(), privateWorkerVault: vault,
        rolloutMode: 'public', requestTimeoutMs: 3000, createEdgeTransport: () => transport });
    try {
        const timer = setTimeout(() => controller.abort(), 4000);
        const work = gateway.run({ ...sub, workerId: 'edge-burst', signal: controller.signal, onReceived: async ({ inbox }) => {
            callbacks++; lastInbox = inbox; if (callbacks === 1) await gate; else controller.abort();
        } });
        try { await Promise.race([persisted, new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))]);
            assert.equal(acks, 25); assert.equal(callbacks, 1); release(); await work; }
        finally { clearTimeout(timer); controller.abort(); await work.catch(() => {}); }
        assert.equal(acks, 25); assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 25);
        assert.equal(callbacks, 2); assert.equal(lastInbox.version.length, 64);
    } finally { release(); controller.abort(); }
}));
for (const failure of ['disconnect', 'malformed']) test(`${failure} preserves buffered owned notifications for the next worker without ACK`, { skip: skipped }, async () => setup(async db => {
    const sub = await insertSubscription(db, edgeFixture()); await db.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [sub.subscriptionId]);
    const cipher = await encrypted(sub.file, { text: 'recover-after-disconnect' }), socket = new EventEmitter(), sends = [];
    socket.write = (data, done) => {
        const command = data.subarray(0, data.indexOf(' ')).toString('ascii'); sends.push(command);
        const response = command === 'CNT' ? frame('CNT 1 CON', '<connect/>') : command === 'ATH' ? frame('ATH 2 CON')
            : frame('BND 3 CON', '<wns><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>new-token</reconnect-token></wns>');
        queueMicrotask(() => { done(); socket.emit('data', response); }); return true;
    };
    socket.destroy = () => {}; socket.pause = () => {}; socket.resume = () => {};
    const gateway = createXPushGateway(db, { enabled: true, edgeEnabled: true, edgeTokenVault: tokenVault(), privateWorkerVault: vault,
        rolloutMode: 'public', requestTimeoutMs: 3000, createEdgeTransport: ({ signal }) => {
            const transport = createEdgeWnsTransport({ socketFactory: () => socket, signal, timeoutMs: 3000 }); queueMicrotask(() => socket.emit('secureConnect')); return transport;
        } });
    await assert.rejects(gateway.run({ ...sub, workerId: 'edge-disconnect', onSession: () => {
        socket.emit('data', Buffer.concat([notification('target', cipher, 'one'), notification('other', cipher, 'foreign'), notification('target', cipher, 'two')]));
        if (failure === 'disconnect') socket.emit('close');
        else socket.emit('data', Buffer.from('invalid\n'));
    } }), { code: 'X_PUSH_RECEIVER_FAILED' });
    assert(!sends.includes('ACK'));
    const identity = { subscriptionId: sub.subscriptionId, ownerUserId: sub.ownerUserId };
    const lease = await gateway.store.claim({ ...identity, workerId: 'edge-recovery' }); assert(lease);
    try {
        const inbox = await gateway.store.listInbox(identity); assert.equal(inbox.length, 2);
        for (const item of inbox) assert.equal((await gateway.decryptInbox(lease, item)).text, 'recover-after-disconnect');
    } finally { await gateway.store.release(lease); }
}));
