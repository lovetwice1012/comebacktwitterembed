'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, fixture, encrypted, vault } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const { encodeFrame } = require('../../src/automation/chrome-mcs-framing');
// Every fixture in this file uses made-up device credentials. Keep the real
// scheduler and fenced database operations, but never send those credentials
// to the real check-in endpoint. Tests for check-in outcomes override this.
const syntheticCheckin = async () => ({ intervalSeconds: 172800 });
function vint(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); }
function bytes(n, v) { const body = Buffer.isBuffer(v) ? v : Buffer.from(v); return Buffer.concat([vint(n * 8 + 2), vint(body.length), body]); }
const pair = (k, v) => bytes(7, Buffer.concat([bytes(1, k), bytes(2, v)]));
function chromeFixture() {
    const old = fixture(), key = old.push.p256dhPrivateKey;
    return { format: old.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.windows', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: old.push.p256dhPublicKey, authenticationSecret: old.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
}
function braveFixture() {
    const file = chromeFixture();
    file.provenance = { kind: 'brave-gcm', adapterVersion: '1.0.0', browserVersion: '157.1.99.55', engineVersion: '157.0.8103.39', readMethod: 'brave-gcm-snapshot' };
    file.push.productCategory = 'com.brave.windows';
    return file;
}
test('Mac Brave file intake to worker is separately gated and uses Mac check-in and engine version', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const rsaPair = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const transfers = require('../../src/automation/x-setup-transfer');
        const sealer = transfers.createTransferPublicSealer({ activeKeyId: 'mac-brave-test', publicKeys: { 'mac-brave-test': rsaPair.publicKey }, allowBraveMac: true });
        const workerVault = transfers.createTransferPrivateWorkerVault({ activeKeyId: 'mac-brave-test', privateKeys: { 'mac-brave-test': rsaPair.privateKey }, allowBraveMac: true });
        const service = require('../../src/automation/x-setup').createXSetup(db, { sealer, chromeEnabled: true, braveEnabled: true, braveMacEnabled: true, receiverEnabled: true, rolloutMode: 'public' });
        const file = braveFixture(); file.push.productCategory = 'com.brave.macosx';
        const actor = { userId: '222222222222222222' }, session = await service.startSession(actor, { consent: true });
        const saved = await service.importFile(actor, { sessionId: session.sessionId, fileText: JSON.stringify(file), consent: true });
        const identity = { subscriptionId: saved.subscription.id, ownerUserId: actor.userId };
        let opens = 0;
        const disabled = createXPushGateway(db, { enabled: true, chromeEnabled: true, braveMacEnabled: false, privateWorkerVault: workerVault,
            rolloutMode: 'public', createChromeSocket: () => { opens++; throw new Error('unexpected network'); } });
        await assert.rejects(disabled.run({ ...identity, workerId: 'mac-brave-disabled' }), { code: 'X_PUSH_PROTOCOL_INVALID' });
        assert.equal(opens, 0);
        const payload = { notificationType: 'tweet', text: 'synthetic-mac-brave' }, cipher = await encrypted(file, payload);
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory), pair('subtype', file.push.appId),
            pair('content-encoding', 'aes128gcm'), bytes(9, 'mac-brave-fixture'), bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        const controller = new AbortController(); let socket, clock = 1000000, fire, captured, confirmCheckin, received;
        const checked = new Promise(resolve => { confirmCheckin = resolve; });
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, braveMacEnabled: true, privateWorkerVault: workerVault,
            rolloutMode: 'public', requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock, createChromeSocket: () => socket = new FakeSocket(db),
            chromeCheckinSetTimer: cb => { fire = cb; return 1; }, chromeCheckinClearTimer: () => {},
            chromeCheckin: async credentials => { captured = credentials; confirmCheckin(); return { intervalSeconds: 50000 }; } });
        const result = await gateway.run({ ...identity, workerId: 'mac-brave-enabled', signal: controller.signal,
            onSession: async () => { clock += 60001; fire(); await checked; socket.emit('data', encodeFrame(8, message)); },
            onReceived: value => { received = value; controller.abort(); } });
        assert.equal(result.state, 'stopped'); assert.equal(captured.platform, 'macos');
        assert.equal(captured.browserVersion, file.provenance.engineVersion); assert.deepEqual(received.payload, payload);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
    } finally { await db.close(); }
});
test('Mac Brave survives an incompatible worker and routes its retained receipt once after recovery', { timeout: 30000 }, async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    let disabledRuntime, recoveryRuntime;
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const transfer = require('../../src/automation/x-setup-transfer');
        const publicOptions = { activeKeyId: 'mixed-fleet-test', publicKeys: { 'mixed-fleet-test': keys.publicKey } };
        const privateOptions = { activeKeyId: 'mixed-fleet-test', privateKeys: { 'mixed-fleet-test': keys.privateKey } };
        const service = require('../../src/automation/x-setup').createXSetup(db, {
            sealer: transfer.createTransferPublicSealer({ ...publicOptions, allowBraveMac: true }), chromeEnabled: true,
            braveEnabled: true, braveMacEnabled: true, receiverEnabled: true, rolloutMode: 'public',
        });
        const file = braveFixture(); file.push.productCategory = 'com.brave.macosx';
        const actor = { userId: '222222222222222222' }, session = await service.startSession(actor, { consent: true });
        const saved = await service.importFile(actor, { sessionId: session.sessionId, fileText: JSON.stringify(file), consent: true });
        const identity = { subscriptionId: saved.subscription.id, ownerUserId: actor.userId };
        let clock = Date.now();
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','fixture',1,'ready','free',?,'bound',1,?,?)",
            [actor.userId, JSON.stringify({ subscriptionId: identity.subscriptionId }), clock, clock]);
        await db.withDatabaseTransaction(query => entitlements.assignSlot(query, actor.userId, 'x', String(monitor.insertId)));
        const payload = { notificationType: 'tweet', text: 'mixed-fleet-fixture', author: { id: '12345', handle: 'example' },
            url: 'https://x.com/example/status/1234567890123456789' };
        const cipher = await encrypted(file, payload);
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory), pair('subtype', file.push.appId),
            pair('content-encoding', 'aes128gcm'), bytes(9, 'mixed-fleet-replay'), bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        class FailedAckSocket extends FakeSocket {
            write(wire, done) {
                if (wire[0] === 7) { this.writes.push(wire); return done(new Error('synthetic ACK write failure')); }
                return super.write(wire, done);
            }
        }
        const enabledVault = transfer.createTransferPrivateWorkerVault({ ...privateOptions, allowBraveMac: true });
        let firstSocket;
        const first = createXPushGateway(db, { enabled: true, chromeEnabled: true, braveMacEnabled: true, privateWorkerVault: enabledVault,
            rolloutMode: 'public', now: () => clock, chromeCheckin: syntheticCheckin, createChromeSocket: () => firstSocket = new FailedAckSocket(db) });
        await assert.rejects(first.run({ ...identity, workerId: 'before-mismatch',
            onSession: () => firstSocket.emit('data', encodeFrame(8, message)) }), { code: 'X_PUSH_SOCKET_FAILED' });
        const subscriptionBefore = (await db.queryDatabase('SELECT sealed_json,revision,owner_user_id FROM automation_x_subscriptions WHERE id=?', [identity.subscriptionId]))[0];
        const monitorBefore = (await db.queryDatabase('SELECT notification_settings_json,revision,state FROM automation_x_monitors WHERE id=?', [monitor.insertId]))[0];
        const inboxBefore = await db.queryDatabase('SELECT id,version,data_ciphertext,status FROM automation_x_push_inbox WHERE subscription_id=?', [identity.subscriptionId]);
        assert.equal(inboxBefore.length, 1); assert.equal(inboxBefore[0].status, 'received');

        // Production creates this vault with the same disabled flag; rejecting
        // in the vault precedes the separate gateway protocol guard.
        let forbiddenSockets = 0;
        const disabled = createXPushGateway(db, { enabled: true, chromeEnabled: true, braveMacEnabled: false,
            privateWorkerVault: transfer.createTransferPrivateWorkerVault(privateOptions), rolloutMode: 'public', now: () => clock,
            createChromeSocket: () => { forbiddenSockets++; throw new Error('unexpected network'); } });
        disabledRuntime = createXPushRuntime(db, {}, { enabled: true, gateway: disabled, rolloutMode: 'public', processingPolicy: 'batch',
            clock: () => clock, jitter: () => 0, assertAllowed() {} });
        await disabledRuntime.tick();
        let status;
        for (let attempt = 0; attempt < 200; attempt++) {
            status = await disabled.store.status(identity);
            if (status?.retryAttempt === 1 && status?.reasonCode === 'X_PUSH_VAULT_INVALID') break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(status?.state, 'error'); assert.equal(status?.reasonCode, 'X_PUSH_VAULT_INVALID');
        assert.equal(status?.retryAttempt, 1); assert.equal(status?.retryAtMs, clock + 5000); assert.equal(forbiddenSockets, 0);
        assert.deepEqual((await db.queryDatabase('SELECT sealed_json,revision,owner_user_id FROM automation_x_subscriptions WHERE id=?', [identity.subscriptionId]))[0], subscriptionBefore);
        assert.deepEqual((await db.queryDatabase('SELECT notification_settings_json,revision,state FROM automation_x_monitors WHERE id=?', [monitor.insertId]))[0], monitorBefore);
        assert.deepEqual(await db.queryDatabase('SELECT id,version,data_ciphertext,status FROM automation_x_push_inbox WHERE subscription_id=?', [identity.subscriptionId]), inboxBefore);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
        await disabledRuntime.stop(); disabledRuntime = null;

        clock = status.retryAtMs + 1;
        const controller = new AbortController(); let socket, replayCallbacks = 0;
        class SuccessorSocket extends FakeSocket {
            write(wire, done) {
                if (wire[0] === 41) { this.writes.push(wire); done(); queueMicrotask(() => this.emit('data', encodeFrame(3, Buffer.concat([bytes(1, 'ok'), Buffer.from([48, 1])]), { first: true }))); return; }
                if (wire[0] === 7) { this.writes.push(wire); done(); setImmediate(() => controller.abort()); return; }
                return super.write(wire, done);
            }
        }
        const enabled = createXPushGateway(db, { enabled: true, chromeEnabled: true, braveMacEnabled: true, privateWorkerVault: enabledVault,
            rolloutMode: 'public', now: () => clock, requestTimeoutMs: 10000, chromeCheckin: syntheticCheckin,
            createChromeSocket: () => socket = new SuccessorSocket(db) });
        const queue = createQueue(db, {}, { rolloutMode: 'public' });
        recoveryRuntime = createXPushRuntime(db, queue, { enabled: true, gateway: enabled, rolloutMode: 'public', processingPolicy: 'batch',
            clock: () => clock, assertAllowed() {} });
        const result = await enabled.run({ ...identity, workerId: 'after-mismatch', signal: controller.signal,
            onSession: async ({ lease }) => {
                assert(socket.writes[0].includes(Buffer.from('mixed-fleet-replay')));
                await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [clock - 301000, identity.subscriptionId]);
                assert.equal((await recoveryRuntime.drain(lease)).processed, 1);
                socket.emit('data', encodeFrame(8, message));
            }, onReceived: () => replayCallbacks++ });
        assert.equal(result.state, 'stopped'); assert.equal(replayCallbacks, 0);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox WHERE subscription_id=?', [identity.subscriptionId])).length, 1);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 1);
    } finally {
        await disabledRuntime?.stop(); await recoveryRuntime?.stop(); await db.close();
    }
});
class FakeSocket extends EventEmitter {
    constructor(db) { super(); this.db = db; this.writes = []; this.destroyed = false; queueMicrotask(() => this.emit('secureConnect')); }
    write(wire, done) {
        this.writes.push(wire);
        if (wire[0] === 41) {
            done(); queueMicrotask(() => this.emit('data', encodeFrame(3, bytes(1, 'ok'), { first: true })));
        } else if (wire[0] === 7) {
            this.db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_push_inbox').then(rows => {
                if (Number(rows[0].n) !== 1) return done(new Error('ACK_BEFORE_COMMIT'));
                done();
            }, done);
        } else done();
    }
    pause() {} resume() {} destroy() { this.destroyed = true; }
}
for (const [browser, makeFile] of [['Chrome', chromeFixture], ['Brave', braveFixture]]) test(`${browser} saves over 100 queued owned receipts after a disconnected socket without ACK`, async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = makeFile(), subscription = await insertSubscription(db, file);
        const cipher = await encrypted(file, { notificationType: 'tweet', text: 'buffered-fixture' }); let socket;
        const frame = (id, subtype = file.push.appId) => encodeFrame(8, Buffer.concat([
            bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory), pair('subtype', subtype),
            pair('content-encoding', 'aes128gcm'), bytes(9, id), bytes(21, Buffer.from(cipher.data, 'base64url'))]));
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, leaseMs: 300000, createChromeSocket: () => socket = new FakeSocket(db),
            // This test uses synthetic device credentials; a check-in timer
            // can fire while the 130 database writes are still in progress.
            // Exercise the real scheduler and fenced DB update without
            // sending those fixture credentials to Google's service.
            chromeCheckin: syntheticCheckin });
        const ids = Array.from({ length: 130 }, (_, i) => `buffered-${String(i).padStart(3, '0')}`);
        await assert.rejects(gateway.run({ ...subscription, workerId: 'buffered-worker', onSession: () => {
            socket.emit('data', Buffer.concat([frame('other-site', 'other'), ...ids.map(id => frame(id))]));
            socket.emit('close');
        } }), { code: 'X_PUSH_SOCKET_CLOSED' });
        assert.equal(socket.writes.filter(wire => wire[0] === 7).length, 0);
        const inbox = await db.queryDatabase('SELECT version FROM automation_x_push_inbox ORDER BY version');
        assert.deepEqual(inbox.map(row => row.version), ids);
        const pending = await db.queryDatabase('SELECT persistent_id FROM automation_x_mcs_pending ORDER BY persistent_id');
        assert.deepEqual(pending.map(row => row.persistent_id), ids.slice(0, 100));
    } finally { await db.close(); }
});
test('Chrome worker receives, commits and routes encrypted MCS data with the existing lease', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = chromeFixture(), subscription = await insertSubscription(db, file), controller = new AbortController();
        const payload = { notificationType: 'tweet', url: 'https://x.com/synthetic/status/123', author: { handle: 'synthetic', id: '123' }, text: 'fixture' };
        const cipher = await encrypted(file, payload); let socket, received;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, chromeCheckin: syntheticCheckin, createChromeSocket: () => socket = new FakeSocket(db) });
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, 'mcs-123'),
            bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        const result = await gateway.run({ ...subscription, workerId: 'chrome-worker', signal: controller.signal,
            onSession: () => socket.emit('data', encodeFrame(8, message)),
            onReceived: value => { received = value; controller.abort(); } });
        assert.deepEqual(result, { state: 'stopped', reasonCode: null });
        assert.deepEqual(received.payload, payload); assert.equal(received.inbox.version, 'mcs-123');
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_mcs_pending')).length, 1);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
        assert(socket.destroyed);
    } finally { await db.close(); }
});
test('Mac Chrome worker is gated and uses Mac check-in while routing owned receipts', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = chromeFixture(); file.push.productCategory = 'com.chrome.macosx';
        const subscription = await insertSubscription(db, file), controller = new AbortController();
        let opens = 0;
        const disabled = createXPushGateway(db, { enabled: true, chromeEnabled: true, chromeMacEnabled: false, privateWorkerVault: vault,
            rolloutMode: 'public', chromeCheckin: syntheticCheckin, createChromeSocket: () => { opens++; throw new Error('unexpected connection'); } });
        await assert.rejects(disabled.run({ ...subscription, workerId: 'mac-disabled' }), { code: 'X_PUSH_PROTOCOL_INVALID' });
        assert.equal(opens, 0);
        const payload = { notificationType: 'tweet', text: 'synthetic-mac' }, cipher = await encrypted(file, payload);
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, 'mac-fixture'), bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        let socket, clock = 1000000, fire, captured, confirmCheckin;
        const checked = new Promise(resolve => { confirmCheckin = resolve; });
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, chromeMacEnabled: true, privateWorkerVault: vault,
            rolloutMode: 'public', requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock,
            createChromeSocket: () => socket = new FakeSocket(db), chromeCheckinSetTimer: cb => { fire = cb; return 1; },
            chromeCheckinClearTimer: () => {}, chromeCheckin: async credentials => { captured = credentials; confirmCheckin(); return { intervalSeconds: 50000 }; } });
        let received;
        const result = await gateway.run({ ...subscription, workerId: 'mac-enabled', signal: controller.signal,
            onSession: async () => { clock += 60001; fire(); await checked; socket.emit('data', encodeFrame(8, message)); },
            onReceived: value => { received = value; controller.abort(); } });
        assert.equal(result.state, 'stopped'); assert.equal(captured.platform, 'macos'); assert.deepEqual(received.payload, payload);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
    } finally { await db.close(); }
});
test('a Chrome login rejection remains retryable and preserves the saved subscription', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = chromeFixture(); file.push.productCategory = 'com.chrome.macosx';
        const subscription = await insertSubscription(db, file);
        class RejectedSocket extends FakeSocket {
            write(wire, done) {
                if (wire[0] !== 41) return super.write(wire, done);
                this.writes.push(wire); done();
                const error = Buffer.concat([vint(8), vint(401)]);
                queueMicrotask(() => this.emit('data', encodeFrame(3, Buffer.concat([bytes(1, 'error'), bytes(3, error)]), { first: true })));
            }
        }
        const options = { enabled: true, chromeEnabled: true, chromeMacEnabled: true, privateWorkerVault: vault, rolloutMode: 'public', requestTimeoutMs: 3000, chromeCheckin: syntheticCheckin };
        const rejected = createXPushGateway(db, { ...options, createChromeSocket: () => new RejectedSocket(db) });
        await assert.rejects(rejected.run({ ...subscription, workerId: 'rejected' }), { code: 'X_PUSH_CHROME_LOGIN_FAILED' });
        const status = await rejected.store.status(subscription);
        assert.equal(status.state, 'error'); assert.equal(status.reasonCode, 'X_PUSH_CHROME_LOGIN_FAILED');
        assert.equal((await db.queryDatabase('SELECT id FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId])).length, 1);
        const controller = new AbortController(); let connected = false;
        const recovered = createXPushGateway(db, { ...options, createChromeSocket: () => new FakeSocket(db) });
        const result = await recovered.run({ ...subscription, workerId: 'retry', signal: controller.signal,
            onSession: () => { connected = true; setImmediate(() => controller.abort()); } });
        assert.equal(connected, true); assert.equal(result.state, 'stopped');
    } finally { await db.close(); }
});
test('Chrome worker fences ACK after a committed receipt if its lease is lost', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = chromeFixture(), subscription = await insertSubscription(db, file);
        const cipher = await encrypted(file, { notificationType: 'tweet', text: 'fixture' });
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, 'lease-lost'),
            bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        const base = createXPushStore(db); let failNext = false, socket;
        const store = { ...base,
            recordMcsFrame: async (...args) => { const row = await base.recordMcsFrame(...args); failNext = true; return row; },
            assertLease: async (...args) => { if (failNext) throw Object.assign(new Error('lease lost'), { code: 'X_PUSH_LEASE_LOST' }); return base.assertLease(...args); } };
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault,
            rolloutMode: 'public', requestTimeoutMs: 3000, store, chromeCheckin: syntheticCheckin, createChromeSocket: () => socket = new FakeSocket(db) });
        await assert.rejects(gateway.run({ ...subscription, workerId: 'chrome-worker',
            onSession: () => socket.emit('data', encodeFrame(8, message)) }), e => e.code === 'X_PUSH_LEASE_LOST');
        assert.equal(socket.writes.filter(wire => wire[0] === 7).length, 0);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_mcs_pending')).length, 1);
    } finally { await db.close(); }
});
for (const [browser, makeFile] of [['Chrome', chromeFixture], ['Brave', braveFixture]]) for (const failure of ['write-error', 'socket-close']) test(`${browser}: a successor recovers a receipt after ACK ${failure}`, async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = makeFile(), subscription = await insertSubscription(db, file);
        const payload = { notificationType: 'tweet', text: 'recovery-fixture', author: { id: '12345', handle: 'example' },
            url: 'https://x.com/example/status/1234567890123456789' }, cipher = await encrypted(file, payload);
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        const now = Date.now();
        const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','fixture',1,'ready','free',?,'bound',1,?,?)",
            [subscription.ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
        await db.withDatabaseTransaction(query => entitlements.assignSlot(query, subscription.ownerUserId, 'x', String(monitor.insertId)));
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, 'recovery-id'),
            bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        let firstSocket, firstCallbacks = 0;
        class FailedAckSocket extends FakeSocket {
            write(wire, done) {
                if (wire[0] === 7) {
                    this.writes.push(wire);
                    if (failure === 'write-error') return done(new Error('synthetic ACK write failure'));
                    // Model a closed socket that never invokes the write callback.
                    queueMicrotask(() => this.emit('close')); return true;
                }
                return super.write(wire, done);
            }
        }
        const options = { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public', requestTimeoutMs: 3000, chromeCheckin: syntheticCheckin };
        const first = createXPushGateway(db, { ...options, createChromeSocket: () => firstSocket = new FailedAckSocket(db) });
        await assert.rejects(first.run({ ...subscription, workerId: 'first-worker',
            onSession: () => firstSocket.emit('data', encodeFrame(8, message)), onReceived: () => firstCallbacks++ }), { code: failure === 'write-error' ? 'X_PUSH_SOCKET_FAILED' : 'X_PUSH_SOCKET_CLOSED' });
        assert.equal(firstCallbacks, 0);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
        assert.deepEqual((await db.queryDatabase('SELECT persistent_id FROM automation_x_mcs_pending')).map(row => row.persistent_id), ['recovery-id']);
        const controller = new AbortController(); let secondSocket, replayCallbacks = 0, recovered;
        class SuccessorSocket extends FakeSocket {
            write(wire, done) {
                if (wire[0] === 41) {
                    this.writes.push(wire); done();
                    queueMicrotask(() => this.emit('data', encodeFrame(3, Buffer.concat([bytes(1, 'ok'), Buffer.from([48, 1])]), { first: true })));
                    return;
                }
                if (wire[0] === 7) { this.writes.push(wire); done(); setImmediate(() => controller.abort()); return; }
                super.write(wire, done);
            }
        }
        const second = createXPushGateway(db, { ...options, requestTimeoutMs: 10000, createChromeSocket: () => secondSocket = new SuccessorSocket(db) });
        const queue = createQueue(db, {}, { rolloutMode: 'public' });
        const runtime = createXPushRuntime(db, queue, { enabled: true, gateway: second, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed() {} });
        const result = await second.run({ ...subscription, workerId: 'second-worker', signal: controller.signal,
            onSession: async ({ lease }) => {
                assert(secondSocket.writes[0].includes(Buffer.from('recovery-id')));
                const rows = await db.queryDatabase('SELECT id FROM automation_x_push_inbox');
                recovered = await second.store.getInbox({ ...lease, id: String(rows[0].id) });
                assert.deepEqual(await second.decryptInbox(lease, recovered), payload);
                // Model the configured five-minute window using the isolated
                // fixture's saved timestamp; production cadence is unchanged.
                await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [Date.now() - 301000, subscription.subscriptionId]);
                assert.equal((await runtime.drain(lease)).processed, 1);
                secondSocket.emit('data', encodeFrame(8, message));
            }, onReceived: () => replayCallbacks++ });
        assert.equal(result.state, 'stopped'); assert.equal(recovered.status, 'received'); assert.equal(replayCallbacks, 0);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
        await runtime.stop();
        assert.deepEqual((await db.queryDatabase('SELECT persistent_id FROM automation_x_mcs_pending')).map(row => row.persistent_id), ['recovery-id']);
    } finally { await db.close(); }
});
test('Chrome slow routing does not block durable receipts or their later queue recovery', { timeout: 30000 }, async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    const controller = new AbortController(); let runtime, running;
    try {
        const file = chromeFixture(), subscription = await insertSubscription(db, file);
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        const now = Date.now();
        const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','fixture',1,'ready','free',?,'bound',1,?,?)",
            [subscription.ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
        await db.withDatabaseTransaction(query => entitlements.assignSlot(query, subscription.ownerUserId, 'x', String(monitor.insertId)));
        const messages = [];
        for (let i = 1; i <= 3; i++) {
            const payload = { notificationType: 'tweet', text: `fixture ${i}`, author: { id: '12345', handle: 'example' },
                url: `https://x.com/example/status/123456789012345678${i}` };
            const cipher = await encrypted(file, payload);
            messages.push(Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
                pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, `slow-${i}`),
                bytes(21, Buffer.from(cipher.data, 'base64url'))]));
        }
        let socket, lease, callbacks = 0, acknowledged = 0, finishReceipts;
        const allReceived = new Promise(resolve => { finishReceipts = resolve; });
        class BurstSocket extends FakeSocket {
            write(wire, done) {
                if (wire[0] !== 7) return super.write(wire, done);
                this.writes.push(wire); done(); acknowledged++;
                if (acknowledged < messages.length) setImmediate(() => this.emit('data', encodeFrame(8, messages[acknowledged])));
                else finishReceipts();
            }
        }
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 10000, chromeCheckin: syntheticCheckin, createChromeSocket: () => socket = new BurstSocket(db) });
        const queue = createQueue(db, {}, { rolloutMode: 'public' });
        runtime = createXPushRuntime(db, queue, { enabled: true, gateway, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed() {} });
        running = gateway.run({ ...subscription, workerId: 'slow-routing', signal: controller.signal,
            onSession: value => { lease = value.lease; socket.emit('data', encodeFrame(8, messages[0])); },
            onReceived: () => { callbacks++; return new Promise(() => {}); } });
        let timer;
        try { await Promise.race([allReceived, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('burst blocked')), 5000); })]); }
        finally { clearTimeout(timer); }
        assert.equal(callbacks, 1);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_push_inbox'))[0].n), 3);
        await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [Date.now() - 301000, subscription.subscriptionId]);
        assert.equal((await runtime.drain(lease)).processed, 3);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 3);
    } finally {
        controller.abort();
        if (running) await running;
        if (runtime) await runtime.stop();
        await db.close();
    }
});
test('Chrome worker runs and saves check-in without interrupting the MCS session', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const subscription = await insertSubscription(db, chromeFixture()), controller = new AbortController();
        let clock = 1000000, fire, calls = 0, socket;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock, createChromeSocket: () => socket = new FakeSocket(db),
            chromeCheckinSetTimer: cb => { fire = cb; return 1; }, chromeCheckinClearTimer: () => {},
            chromeCheckin: async credentials => { calls++; assert.equal(credentials.deviceId, '123'); return { intervalSeconds: 50000 }; } });
        const running = gateway.run({ ...subscription, workerId: 'chrome-checkin', signal: controller.signal,
            onSession: () => { clock += 60001; fire(); } });
        try {
            let saved;
            for (let i = 0; i < 100; i++) {
                saved = (await db.queryDatabase('SELECT chrome_checkin_at_ms,chrome_checkin_interval_seconds FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
                if (saved?.chrome_checkin_at_ms != null) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(calls, 1); assert.equal(Number(saved.chrome_checkin_interval_seconds), 50000);
            assert.equal(Number(saved.chrome_checkin_at_ms), clock); assert.equal(socket.destroyed, false);
        } finally { controller.abort(); await running; }
    } finally { await db.close(); }
});
test('Brave worker uses its Chromium engine version for both MCS login and check-in', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = braveFixture(), subscription = await insertSubscription(db, file), controller = new AbortController();
        let clock = 1000000, fire, socket, checkedVersion;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock, createChromeSocket: () => socket = new FakeSocket(db),
            chromeCheckinSetTimer: cb => { fire = cb; return 1; }, chromeCheckinClearTimer: () => {},
            chromeCheckin: async credentials => { checkedVersion = credentials.browserVersion; return { intervalSeconds: 50000 }; } });
        const running = gateway.run({ ...subscription, workerId: 'brave-checkin', signal: controller.signal,
            onSession: () => { clock += 60001; fire(); } });
        try {
            let saved;
            for (let i = 0; i < 100; i++) {
                saved = (await db.queryDatabase('SELECT chrome_checkin_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
                if (saved?.chrome_checkin_at_ms != null) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(checkedVersion, file.provenance.engineVersion); assert.ok(saved?.chrome_checkin_at_ms != null);
            assert(socket.writes[0].includes(Buffer.from('chrome-' + file.provenance.engineVersion)));
            assert(!socket.writes[0].includes(Buffer.from(file.provenance.browserVersion)));
        } finally { controller.abort(); await running; }
    } finally { await db.close(); }
});
test('invalid Chrome device credentials stop the worker and require re-enrollment without replacing the subscription', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const subscription = await insertSubscription(db, chromeFixture());
        let clock = 1000000, fire;
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, leaseMs: 300000, now: () => clock, createChromeSocket: () => new FakeSocket(db),
            chromeCheckinSetTimer: cb => { fire = cb; return 1; }, chromeCheckinClearTimer: () => {},
            chromeCheckin: async () => { throw Object.assign(new Error('invalid'), { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' }); } });
        await assert.rejects(gateway.run({ ...subscription, workerId: 'chrome-checkin', onSession: () => { clock += 60001; fire(); } }),
            { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' });
        const rows = await db.queryDatabase('SELECT state,reason_code,chrome_checkin_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]);
        assert.equal(rows[0].state, 'requires_reenrollment'); assert.equal(rows[0].reason_code, 'X_PUSH_CHECKIN_UNAUTHORIZED');
        assert.equal(rows[0].chrome_checkin_at_ms, null);
        assert.equal((await db.queryDatabase('SELECT id FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId])).length, 1);
    } finally { await db.close(); }
});
test('a provider loss notice is recorded before ACK and later encrypted posts still route', async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try {
        for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql);
        const file = chromeFixture(), subscription = await insertSubscription(db, file), controller = new AbortController();
        const payload = { notificationType: 'tweet', text: 'fixture-after-control' }, cipher = await encrypted(file, payload);
        const control = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('message_type', 'deleted_messages'), bytes(9, 'provider-loss')]);
        const message = Buffer.concat([bytes(3, file.push.authorizedEntity), bytes(5, file.push.productCategory),
            pair('subtype', file.push.appId), pair('content-encoding', 'aes128gcm'), bytes(9, 'after-loss'), bytes(21, Buffer.from(cipher.data, 'base64url'))]);
        let socket, acks = 0, received;
        class ControlSocket extends EventEmitter {
            constructor() { super(); this.destroyed = false; queueMicrotask(() => this.emit('secureConnect')); }
            write(wire, done) {
                if (wire[0] === 41) { done(); queueMicrotask(() => this.emit('data', encodeFrame(3, bytes(1, 'ok'), { first: true }))); return; }
                if (wire[0] !== 7) { done(); return; }
                db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE action='x.push.provider.deleted_messages'").then(rows => {
                    if (Number(rows[0].n) !== 1) return done(new Error('ACK_BEFORE_AUDIT'));
                    done(); if (++acks === 1) queueMicrotask(() => this.emit('data', encodeFrame(8, message)));
                }, done);
            }
            pause() {} resume() {} destroy() { this.destroyed = true; }
        }
        const gateway = createXPushGateway(db, { enabled: true, chromeEnabled: true, privateWorkerVault: vault, rolloutMode: 'public',
            requestTimeoutMs: 3000, chromeCheckin: syntheticCheckin, createChromeSocket: () => socket = new ControlSocket() });
        await gateway.run({ ...subscription, workerId: 'control-test', signal: controller.signal,
            onSession: () => socket.emit('data', encodeFrame(8, control)), onReceived: value => { received = value; controller.abort(); } });
        assert.deepEqual(received.payload, payload); assert.equal(acks, 2);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 1);
        assert.deepEqual((await db.queryDatabase('SELECT persistent_id FROM automation_x_mcs_pending ORDER BY persistent_id')).map(row => row.persistent_id), ['after-loss', 'provider-loss']);
    } finally { await db.close(); }
});
