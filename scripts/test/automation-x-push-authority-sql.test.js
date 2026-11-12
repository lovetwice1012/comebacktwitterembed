'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { insertSubscription, vault, FakeSocket, encrypted, notification, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const authority = state => () => { if (!state.allowed) throw new Error('synthetic guardian denied'); };

test('guardian revoked during rollout lookup opens no socket and creates no receiver', { timeout: 30000 }, async t => {
    const db = await createTestDatabase(port), entered = deferred(), release = deferred(), state = { allowed: true };
    t.after(async () => { release.resolve(); await db.close(); });
    await grantTestDonor(db, ownerUserId); const subscription = await insertSubscription(db);
    let sockets = 0, opens = 0, delayed = false;
    const wrapped = { ...db, queryDatabase: async (sql, params) => {
        const rows = await db.queryDatabase(sql, params);
        if (!delayed && /^SELECT is_donor FROM users/.test(sql)) { delayed = true; entered.resolve(); await release.promise; }
        return rows;
    } };
    const gateway = createXPushGateway(wrapped, { enabled: true, rolloutMode: 'supporters', privateWorkerVault: { open(...args) { opens++; return vault.open(...args); } },
        createSocket: () => { sockets++; throw new Error('unexpected socket'); } });
    const run = gateway.run({ ...subscription, workerId: 'lookup-authority', assertAllowed: authority(state) });
    await entered.promise; state.allowed = false; release.resolve();
    await assert.rejects(run, { code: 'X_PUSH_AUTHORITY_UNAVAILABLE' });
    assert.equal(sockets, 0); assert.equal(opens, 0);
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_push_receivers'))[0].n), 0);
});

test('timed-out claim aborts a delayed transaction and never opens a provider socket', { timeout: 30000 }, async t => {
    const db = await createTestDatabase(port), entered = deferred(), release = deferred(), settled = deferred();
    t.after(async () => { release.resolve(); await settled.promise; await db.close(); });
    const subscription = await insertSubscription(db); let delayed = false, sockets = 0;
    const wrapped = { ...db, withDatabaseTransaction: work => {
        const pending = db.withDatabaseTransaction(query => work(async (sql, params) => {
            const value = await query(sql, params);
            if (!delayed && /^SELECT \* FROM automation_x_subscriptions WHERE id=\? AND owner_user_id=\? FOR UPDATE/.test(sql)) {
                delayed = true; entered.resolve(); await release.promise;
            }
            return value;
        }));
        pending.then(settled.resolve, settled.resolve); return pending;
    } };
    const gateway = createXPushGateway(wrapped, { enabled: true, rolloutMode: 'public', requestTimeoutMs: 100,
        privateWorkerVault: vault, createSocket: () => { sockets++; throw new Error('unexpected socket'); } });
    const run = gateway.run({ ...subscription, workerId: 'timeout-fixture' });
    await entered.promise; await assert.rejects(run, { code: 'X_PUSH_STORE_TIMEOUT' });
    release.resolve(); await settled.promise;
    assert.equal(sockets, 0); assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_push_receivers'))[0].n), 0);
});

test('guardian revoked after claim closes the owned lease before vault access', { timeout: 30000 }, async t => {
    const db = await createTestDatabase(port), state = { allowed: true }; t.after(() => db.close());
    const subscription = await insertSubscription(db); let sockets = 0, opens = 0;
    const gateway = createXPushGateway(db, { enabled: true, rolloutMode: 'public', privateWorkerVault: { open(...args) { opens++; return vault.open(...args); } },
        createSocket: () => { sockets++; throw new Error('unexpected socket'); } });
    const result = await gateway.run({ ...subscription, workerId: 'after-claim', assertAllowed: authority(state), onClaim: () => { state.allowed = false; } });
    assert.equal(result.state, 'authority_unavailable'); assert.equal(opens, 0); assert.equal(sockets, 0);
    const row = (await db.queryDatabase('SELECT state,reason_code,lease_token FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
    assert.equal(row.state, 'stopped'); assert.equal(row.reason_code, null); assert.equal(row.lease_token, null);
});

for (const mismatch of [false, true]) test(`guardian revoked while Firefox HELLO is pending cannot write ${mismatch ? 'reenrollment' : 'listening'} state`, { timeout: 30000 }, async t => {
    const db = await createTestDatabase(port), entered = deferred(), state = { allowed: true };
    t.after(() => db.close());
    const subscription = await insertSubscription(db); let peer;
    const gateway = createXPushGateway(db, { enabled: true, rolloutMode: 'public', requestTimeoutMs: 3000, privateWorkerVault: vault,
        createSocket: () => new FakeSocket((message, socket) => { if (message.messageType === 'hello') { peer = socket; entered.resolve(); } }) });
    const running = gateway.run({ ...subscription, workerId: 'hello-authority', assertAllowed: authority(state) });
    await entered.promise; state.allowed = false;
    peer.reply({ messageType: 'hello', status: 200, uaid: mismatch ? '00000000-0000-4000-8000-000000000001' : subscription.file.push.uaid, use_webpush: true });
    const result = await running; assert.equal(result.state, 'authority_unavailable');
    const receiver = (await db.queryDatabase('SELECT state,reason_code,lease_token,retry_attempt FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
    assert.equal(receiver.state, 'stopped'); assert.equal(receiver.reason_code, null); assert.equal(receiver.lease_token, null); assert.equal(Number(receiver.retry_attempt), 0);
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0].n), 1);
});

for (const phase of ['during-insert', 'after-commit']) test(`guardian revoked ${phase} prevents ACK and preserves the correct durable state`, { timeout: 30000 }, async t => {
    const db = await createTestDatabase(port), state = { allowed: true }; t.after(() => db.close());
    const subscription = await insertSubscription(db), wire = await encrypted(subscription.file, { notificationType: 'tweet', text: 'synthetic' });
    let ackCount = 0, receiptTransaction = false;
    const wrapped = { ...db, withDatabaseTransaction: async work => {
        let wroteReceipt = false;
        const result = await db.withDatabaseTransaction(query => work(async (sql, params) => {
            const value = await query(sql, params);
            if (/^INSERT INTO automation_x_push_inbox/.test(sql)) {
                wroteReceipt = true; receiptTransaction = true;
                if (phase === 'during-insert') state.allowed = false;
            }
            return value;
        }));
        if (phase === 'after-commit' && wroteReceipt) state.allowed = false;
        return result;
    } };
    const gateway = createXPushGateway(wrapped, { enabled: true, rolloutMode: 'public', requestTimeoutMs: 3000, privateWorkerVault: vault,
        createSocket: () => new FakeSocket((message, socket) => {
            if (message.messageType === 'hello') {
                socket.reply({ messageType: 'hello', status: 200, uaid: message.uaid, use_webpush: true });
                queueMicrotask(() => socket.reply(notification(subscription.file, 'synthetic-receipt', wire)));
            } else if (message.messageType === 'ack') ackCount++;
        }) });
    const result = await gateway.run({ ...subscription, workerId: `receipt-${phase}`, assertAllowed: authority(state) });
    assert.equal(result.state, 'authority_unavailable'); assert.equal(receiptTransaction, true); assert.equal(ackCount, 0);
    const rows = await db.queryDatabase('SELECT status FROM automation_x_push_inbox WHERE subscription_id=?', [subscription.subscriptionId]);
    assert.equal(rows.length, phase === 'after-commit' ? 1 : 0);
    if (rows.length) assert.equal(rows[0].status, 'received');
    const receiver = (await db.queryDatabase('SELECT state,reason_code,lease_token FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0];
    assert.equal(receiver.state, 'stopped'); assert.equal(receiver.reason_code, null); assert.equal(receiver.lease_token, null);
});
