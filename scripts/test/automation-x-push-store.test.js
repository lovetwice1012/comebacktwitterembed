'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXPushStore, validateFrame, safeHeaders } = require('../../src/automation/x-push-store');
const { insertSubscription } = require('./helpers/x-push-fixture.cjs');
const code = expected => error => error.code === expected;
async function setup(work) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try { for (const sql of require('../../src/automation/x-push-schema.sql').SCHEMA) await db.queryDatabase(sql); await work(db); }
    finally { await db.close(); }
}
const frame = version => ({ version, data: 'AA', headers: { encoding: 'aes128gcm' }, status: 'received', ackCode: 100 });

test('encrypted frame validation rejects headers, getters, text and oversized input', () => {
    assert.deepEqual(safeHeaders(null), {});
    for (const headers of [{ endpoint: 'SENTINEL' }, { encoding: 'a\nb' }, { get encoding() { throw new Error('must not run'); } }, { encoding: 'a'.repeat(4097) }])
        assert.throws(() => safeHeaders(headers), code('X_PUSH_FRAME_INVALID'));
    for (const changed of [{ data: 'plaintext value' }, { data: 'a'.repeat(65537) }, { version: '' }, { version: 'a\n' }, { ackCode: 101 }, { status: 'routed' }])
        assert.throws(() => validateFrame({ ...frame('v1'), ...changed }), code('X_PUSH_FRAME_INVALID'));
});

test('SQL claim races have one winner; owner checks and random expired tokens fence old workers', async () => setup(async db => {
    let clock = 1000;
    const subscription = await insertSubscription(db), store = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    assert.equal((await store.status(subscription)).state, 'awaiting');
    await assert.rejects(store.claim({ ...subscription, ownerUserId: '333333333333333333', workerId: 'foreign' }), code('X_PUSH_SUBSCRIPTION_NOT_FOUND'));
    const claims = await Promise.all([store.claim({ ...subscription, workerId: 'a' }), store.claim({ ...subscription, workerId: 'b' })]);
    assert.equal(claims.filter(Boolean).length, 1);
    const old = claims.find(Boolean);
    assert.match(old.token, /^[0-9a-f]{64}$/);
    assert.equal((await store.status(subscription)).state, 'connecting');
    clock = 1500;
    const renewed = await store.renew(old); assert.equal(renewed.expiresAtMs, 2500);
    clock = 2500;
    assert.equal((await store.status(subscription)).reasonCode, 'X_PUSH_LEASE_EXPIRED');
    const next = await store.claim({ ...subscription, workerId: 'successor' }); assert.notEqual(next.token, old.token);
    for (const action of [() => store.renew(old), () => store.markState(old, 'listening'), () => store.release(old), () => store.recordFrame(old, frame('stale'))])
        await assert.rejects(action(), code('X_PUSH_LEASE_LOST'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    await store.markState(next, 'listening');
    assert.equal((await store.status(subscription)).state, 'listening');
    await store.release(next); assert.equal((await store.status(subscription)).state, 'stopped');
}));

test('SQL replay keeps original ACK code across restart; encrypted inbox recovery stays owner scoped', async () => setup(async db => {
    const subscription = await insertSubscription(db), store = createXPushStore(db);
    let lease = await store.claim({ ...subscription, workerId: 'a' });
    const input = { ...frame('failure'), status: 'decryption_failed', ackCode: 101 };
    const first = await store.recordFrame(lease, input); assert.equal(first.duplicate, false);
    await store.release(lease);
    const restarted = createXPushStore(db); lease = await restarted.claim({ ...subscription, workerId: 'restart' });
    const repeated = await restarted.recordFrame(lease, frame('failure'));
    assert.equal(repeated.id, first.id); assert.equal(repeated.duplicate, true); assert.equal(repeated.ackCode, 101);
    const success = await restarted.recordFrame(lease, frame('success'));
    const received = await restarted.listInbox(subscription); assert.deepEqual(received.map(row => row.id), [success.id]);
    assert.equal(await restarted.getInbox({ ...subscription, id: first.id, ownerUserId: '333333333333333333' }), null);
    assert.equal((await restarted.listInbox({ ...subscription, ownerUserId: '333333333333333333' })).length, 0);
    assert.equal(await restarted.markRouted(lease, success.id), true);
    assert.equal(await restarted.markRouted(lease, success.id), false);
    assert.equal((await restarted.listInbox(subscription)).length, 0);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 2);
}));

test('SQL rollback and lease expiry during insert leave no committed receipt', async () => setup(async db => {
    let clock = 1000;
    const subscription = await insertSubscription(db), store = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    const lease = await store.claim({ ...subscription, workerId: 'a' });
    const wrapping = transform => ({ queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params); if (sql.startsWith('INSERT INTO automation_x_push_inbox')) transform(); return result;
    })) });
    const rollback = createXPushStore(wrapping(() => { throw Object.assign(new Error('SENSITIVE SQL SENTINEL'), { code: 'ER_FIXTURE_ROLLBACK' }); }), { now: () => clock, leaseMs: 1000 });
    await assert.rejects(rollback.recordFrame(lease, frame('rollback')), error => error.code === 'X_PUSH_STORE_UNAVAILABLE' && !error.stack.includes('SENSITIVE'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    const expired = createXPushStore(wrapping(() => { clock = 2000; }), { now: () => clock, leaseMs: 1000 });
    await assert.rejects(expired.recordFrame(lease, frame('expired')), code('X_PUSH_LEASE_LOST'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
}));

test('SQL renewal cannot revive a generation that expires during authorization or its UPDATE', async () => setup(async db => {
    let clock = 1000;
    const subscription = await insertSubscription(db), store = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    const first = await store.claim({ ...subscription, workerId: 'a' });
    await assert.rejects(store.renew(first, { authorize: async () => { clock = 2000; } }), code('X_PUSH_LEASE_LOST'));
    assert.equal(Number((await db.queryDatabase('SELECT lease_expires_at_ms FROM automation_x_push_receivers'))[0].lease_expires_at_ms), 2000);
    const second = await store.claim({ ...subscription, workerId: 'b' });
    const delayed = createXPushStore({ queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('UPDATE automation_x_push_receivers SET lease_expires_at_ms=')) clock = 3000;
        return result;
    })) }, { now: () => clock, leaseMs: 1000 });
    clock = 2500;
    await assert.rejects(delayed.renew(second), code('X_PUSH_LEASE_LOST'));
    assert.equal(Number((await db.queryDatabase('SELECT lease_expires_at_ms FROM automation_x_push_receivers'))[0].lease_expires_at_ms), 3000);
    const successor = await store.claim({ ...subscription, workerId: 'c' }); assert.notEqual(successor.token, second.token);
}));

test('SQL deletion cascades ciphertext and receiver; changed revision and reenrollment cannot silently resume', async () => setup(async db => {
    const subscription = await insertSubscription(db), store = createXPushStore(db);
    const lease = await store.claim({ ...subscription, workerId: 'a' });
    await store.recordFrame(lease, frame('v1'));
    await store.auditUse(lease, 'opened');
    await store.release(lease, { state: 'requires_reenrollment', reasonCode: 'X_PUSH_UAID_CHANGED' });
    assert.equal(await store.claim({ ...subscription, workerId: 'b' }), null);
    const audit = JSON.stringify(await db.queryDatabase('SELECT * FROM automation_audit'));
    for (const secret of [subscription.file.push.uaid, subscription.file.push.channelID, subscription.file.push.pushEndpoint, subscription.file.push.p256dhPrivateKey.d]) assert(!audit.includes(secret));
    await db.queryDatabase("UPDATE automation_x_push_receivers SET state='stopped' WHERE subscription_id=?", [subscription.subscriptionId]);
    const second = await store.claim({ ...subscription, workerId: 'c' });
    await db.queryDatabase('UPDATE automation_x_subscriptions SET revision=2 WHERE id=?', [subscription.subscriptionId]);
    await assert.rejects(store.recordFrame(second, frame('new')), code('X_PUSH_LEASE_LOST'));
    await db.queryDatabase('DELETE FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_receivers')).length, 0);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    await assert.rejects(store.renew(second), code('X_PUSH_SUBSCRIPTION_NOT_FOUND'));
}));

test('SQL retry cooldown and attempt survive restart, reject stale identities and never overwrite an active successor', async () => setup(async db => {
    let clock = 1000;
    const subscription = await insertSubscription(db), input = { ...subscription, revision: 1 };
    const store = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    assert.deepEqual(await store.recordRetry(input, 'X_PUSH_SOCKET_FAILED', 1000), { recorded: true, retryAtMs: 2000, retryAttempt: 1 });
    const restarted = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    assert.equal((await restarted.status(subscription)).retryAtMs, 2000);
    clock = 1999;
    assert.equal(await restarted.claim({ ...subscription, workerId: 'too-early' }), null);
    clock = 2000;
    const successor = await restarted.claim({ ...subscription, workerId: 'successor' }); assert(successor);
    assert.deepEqual(await store.recordRetry(input, 'X_PUSH_BACKOFF', 1800000), { recorded: false, retryAtMs: 2000, retryAttempt: 1 });
    await assert.rejects(store.recordRetry({ ...input, revision: 2 }, 'X_PUSH_SOCKET_FAILED', 1000), code('X_PUSH_REVISION_CONFLICT'));
    await assert.rejects(store.recordRetry({ ...input, ownerUserId: '333333333333333333' }, 'X_PUSH_SOCKET_FAILED', 1000), code('X_PUSH_SUBSCRIPTION_NOT_FOUND'));
    await restarted.assertLease(successor);
    await restarted.release(successor);
    assert.deepEqual(await store.recordRetry(input, 'X_PUSH_SOCKET_FAILED', 500), { recorded: true, retryAtMs: 2500, retryAttempt: 2 });
    assert.deepEqual(await store.recordRetry(input, 'X_PUSH_SOCKET_FAILED', 10), { recorded: true, retryAtMs: 2500, retryAttempt: 3 });
    clock = 2500;
    const reenroll = await restarted.claim({ ...subscription, workerId: 'reenroll' });
    await restarted.release(reenroll, { state: 'requires_reenrollment', reasonCode: 'X_PUSH_UAID_CHANGED' });
    assert.equal((await store.recordRetry(input, 'X_PUSH_SOCKET_FAILED', 500)).recorded, false);
    clock = 10000000;
    assert.equal(await store.claim({ ...subscription, workerId: 'never-recreate' }), null);
}));

test('SQL retry can fence an expired generation; attempt cap and successful lease reset are durable', async () => setup(async db => {
    let clock = 1000;
    const subscription = await insertSubscription(db), input = { ...subscription, revision: 1 };
    const store = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    const expired = await store.claim({ ...subscription, workerId: 'expired' });
    clock = 2000;
    await store.recordRetry(input, 'X_PUSH_SOCKET_FAILED', 1000);
    await assert.rejects(store.renew(expired), code('X_PUSH_LEASE_LOST'));
    await db.queryDatabase('UPDATE automation_x_push_receivers SET retry_attempt=4294967295 WHERE subscription_id=?', [subscription.subscriptionId]);
    assert.equal((await store.recordRetry(input, 'X_PUSH_BACKOFF', 1800000)).retryAttempt, 64);
    clock += 1800000;
    const next = await store.claim({ ...subscription, workerId: 'next' });
    assert.deepEqual(await store.resetRetry(next), { retryAtMs: null, retryAttempt: 0 });
    const restarted = createXPushStore(db, { now: () => clock });
    assert.equal((await restarted.status(subscription)).retryAtMs, null);
    assert.equal((await restarted.status(subscription)).retryAttempt, 0);
    await store.release(next);
}));
