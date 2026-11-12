'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase, applyTestMigration } = require('../lib/automation-test-db');
const { insertSubscription, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createOfflineLease } = require('../../src/automation/x-push-offline-lease');
const frame = version => ({ version, data: 'AA', headers: { encoding: 'aes128gcm' }, status: 'received', ackCode: 100 });

async function fixture(t) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    t.after(() => db.close());
    let clock = 1000; const now = () => clock, subscription = await insertSubscription(db);
    const store = createXPushStore(db, { now, leaseMs: 30000 });
    const lease = await store.claim({ ...subscription, workerId: 'initial' });
    await store.recordFrame(lease, frame('offline-receipt'));
    await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','example','fixture',1,'ready','free',?,'bound',1,0,0)",
        [ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId })]);
    return { db, subscription, store, lease, now, advance: ms => { clock += ms; },
        offline: (options = {}) => createOfflineLease(db, { now, leaseMs: 30000, enabled: true, assertCompatible: () => true, ...options }),
        receiver: async () => (await db.queryDatabase('SELECT * FROM automation_x_push_receivers WHERE subscription_id=?', [subscription.subscriptionId]))[0] };
}

test('processing and receiver claims are mutually exclusive without changing receiver status', async t => {
    const f = await fixture(t), offline = f.offline();
    assert.equal(await offline.claim({ ...f.subscription, workerId: 'offline' }, { authorize: async () => {} }), null);
    await f.store.release(f.lease, { state: 'error', reasonCode: 'X_PUSH_SOCKET_CLOSED' });
    const before = await f.receiver(), processing = await offline.claim({ ...f.subscription, workerId: 'offline' }, { authorize: async () => {} });
    assert.equal(processing.purpose, 'processing'); assert.equal(processing.revision, f.lease.revision);
    const during = await f.receiver();
    for (const name of ['state', 'reason_code', 'retry_at_ms', 'retry_attempt', 'last_connected_at_ms', 'lease_token', 'worker_id', 'lease_expires_at_ms'])
        assert.equal(during[name], before[name], name);
    assert.equal(await f.store.assertLease(processing), true);
    await assert.rejects(f.store.recordFrame(processing, frame('not-receiver')), { code: 'X_PUSH_LEASE_LOST' });
    await assert.rejects(f.store.chromeCheckinState(processing, { authorize: async () => {} }), { code: 'X_PUSH_LEASE_LOST' });
    await offline.release(processing);
    const after = await f.receiver();
    for (const name of ['state', 'reason_code', 'retry_at_ms', 'retry_attempt', 'last_connected_at_ms']) assert.equal(after[name], before[name], name);
    const next = await f.store.claim({ ...f.subscription, workerId: 'next' }); assert.ok(next);
    await assert.rejects(f.store.assertLease(processing), { code: 'X_PUSH_LEASE_LOST' });
} );

test('simultaneous network and processing claims admit only one owner', async t => {
    const f = await fixture(t), offline = f.offline(); await f.store.release(f.lease);
    const [network, processing] = await Promise.all([
        f.store.claim({ ...f.subscription, workerId: 'network-race' }),
        offline.claim({ ...f.subscription, workerId: 'processing-race' }, { authorize: async () => {} }),
    ]);
    assert.ok(network || processing);
    if (network) {
        if (processing) await assert.rejects(f.store.assertLease(processing), { code: 'X_PUSH_LEASE_LOST' });
        await f.store.assertLease(network); await f.store.release(network);
    } else { await f.store.assertLease(processing); await offline.release(processing); }
});

test('network retry is generation fenced while a processing-only lease remains intact', async t => {
    const f = await fixture(t), offline = f.offline();
    assert.equal(f.lease.connectionGeneration, 1);
    await f.store.release(f.lease, { state: 'error', reasonCode: 'X_PUSH_SOCKET_CLOSED' });
    const processing = await offline.claim({ ...f.subscription, workerId: 'offline' }, { authorize: async () => {} });
    const retry = await f.store.recordRetry({ ...f.subscription, revision: f.lease.revision, connectionGeneration: 1 }, 'X_PUSH_SOCKET_CLOSED', 5000);
    assert.equal(retry.recorded, true); assert.equal(await f.store.assertLease(processing), true);
    const current = await f.receiver(); assert.equal(current.processing_lease_token, processing.token); assert.equal(Number(current.retry_at_ms), 6000);
    const noGeneration = await f.store.recordRetry({ ...f.subscription, revision: f.lease.revision }, 'X_PUSH_SOCKET_CLOSED', 5000);
    assert.equal(noGeneration.recorded, false);
    await offline.release(processing); f.advance(5001);
    const next = await f.store.claim({ ...f.subscription, workerId: 'next-generation' });
    assert.equal(next.connectionGeneration, 2); await f.store.resetRetry(next); await f.store.release(next);
    const late = await f.store.recordRetry({ ...f.subscription, revision: f.lease.revision, connectionGeneration: 1 }, 'X_PUSH_SOCKET_CLOSED', 5000);
    assert.equal(late.recorded, false); const after = await f.receiver(); assert.equal(after.retry_at_ms, null);
});

test('processing renewal checks fleet compatibility and release remains available after withdrawal', async t => {
    const f = await fixture(t); await f.store.release(f.lease);
    let compatible = true;
    const offline = f.offline({ assertCompatible: () => compatible });
    let lease = await offline.claim({ ...f.subscription, workerId: 'offline' }, { authorize: async () => {} });
    f.advance(100); lease = await offline.renew(lease, { authorize: async () => {} });
    assert.equal(lease.expiresAtMs, 31100); compatible = false;
    await assert.rejects(offline.renew(lease, { authorize: async () => {} }), { code: 'X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED' });
    assert.equal(await offline.release(lease), true);
});

test('an expired processing claim rolls back the token before commit', async t => {
    const f = await fixture(t); await f.store.release(f.lease);
    const delayed = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('UPDATE automation_x_push_receivers SET processing_lease_token=')) f.advance(30000);
        return result;
    })) };
    const offline = createOfflineLease(delayed, { enabled: true, assertCompatible: () => true, now: f.now, leaseMs: 30000 });
    await assert.rejects(offline.claim({ ...f.subscription, workerId: 'slow' }, { authorize: async () => {} }), { code: 'X_PUSH_LEASE_LOST' });
    const row = await f.receiver(); assert.equal(row.processing_lease_token, null); assert.equal(row.processing_lease_expires_at_ms, null);
});

test('processing claim fails closed on compatibility, authorization, corruption and receiver policy', async t => {
    const f = await fixture(t); await f.store.release(f.lease);
    const disabled = f.offline({ enabled: false });
    assert.equal(await disabled.claim({ ...f.subscription, workerId: 'disabled' }, { authorize: async () => {} }), null);
    const incompatible = f.offline({ assertCompatible: () => false });
    await assert.rejects(incompatible.claim({ ...f.subscription, workerId: 'mixed' }, { authorize: async () => {} }), { code: 'X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED' });
    await assert.rejects(f.offline().claim({ ...f.subscription, ownerUserId: '333333333333333333', workerId: 'other' }, { authorize: async () => {} }), { code: 'X_PUSH_SUBSCRIPTION_NOT_FOUND' });
    await assert.rejects(f.offline().claim({ ...f.subscription, workerId: 'denied' }, { authorize: async () => { throw Object.assign(new Error('denied'), { code: 'X_PUSH_ROLLOUT_WITHDRAWN' }); } }), { code: 'X_PUSH_ROLLOUT_WITHDRAWN' });
    await f.db.queryDatabase("UPDATE automation_x_push_receivers SET state='requires_reenrollment' WHERE subscription_id=?", [f.subscription.subscriptionId]);
    assert.equal(await f.offline().claim({ ...f.subscription, workerId: 'stopped' }, { authorize: async () => {} }), null);
    await f.db.queryDatabase("UPDATE automation_x_push_receivers SET state='stopped',processing_lease_token=? WHERE subscription_id=?", ['a'.repeat(64), f.subscription.subscriptionId]);
    await assert.rejects(f.offline().claim({ ...f.subscription, workerId: 'corrupt' }, { authorize: async () => {} }), { code: 'X_PUSH_OFFLINE_STATE_INVALID' });
    await assert.rejects(f.store.claim({ ...f.subscription, workerId: 'network-corrupt' }), { code: 'X_PUSH_OFFLINE_STATE_INVALID' });
});

test('additive migration is repeatable and an old schema keeps normal receiver claims', async t => {
    const f = await fixture(t); await f.store.release(f.lease);
    const name = '20261112_add_x_push_processing_lease.sql';
    await applyTestMigration(f.db, name); await applyTestMigration(f.db, name);
    for (const column of ['processing_lease_token', 'processing_worker_id', 'processing_lease_expires_at_ms', 'processing_revision', 'connection_generation'])
        await f.db.queryDatabase(`ALTER TABLE automation_x_push_receivers DROP COLUMN ${column}`);
    const legacy = await f.store.claim({ ...f.subscription, workerId: 'legacy' }); assert.ok(legacy);
    assert.equal(legacy.connectionGeneration, undefined);
    assert.equal((await f.store.listInbox(f.subscription)).length, 1);
    await f.store.release(legacy);
});

test('network preempts processing only after retry is due, invalidating old token atomically', async t => {
    const f = await fixture(t), offline = f.offline();
    await f.store.release(f.lease, { state: 'error', reasonCode: 'X_PUSH_SOCKET_CLOSED' });
    await f.store.recordRetry({ ...f.subscription, revision: f.lease.revision, connectionGeneration: f.lease.connectionGeneration }, 'X_PUSH_SOCKET_CLOSED', 5000);
    const processing = await offline.claim({ ...f.subscription, workerId: 'offline' }, { authorize: async () => {} });
    assert.equal(await f.store.claim({ ...f.subscription, workerId: 'too-early' }), null);
    assert.equal(await f.store.assertLease(processing), true);
    f.advance(5001);
    const network = await f.store.claim({ ...f.subscription, workerId: 'network' }); assert.ok(network);
    await assert.rejects(f.store.assertLease(processing), { code: 'X_PUSH_LEASE_LOST' });
    await assert.rejects(offline.renew(processing, { authorize: async () => {} }), { code: 'X_PUSH_LEASE_LOST' });
    await assert.rejects(offline.release(processing), { code: 'X_PUSH_LEASE_LOST' });
    await f.store.assertLease(network); await f.store.release(network);
});

test('asynchronous fleet verifier inside the receiver lock fails and rolls back promptly', async t => {
    const f = await fixture(t); await f.store.release(f.lease);
    let checks = 0, rejectLater;
    const delayed = new Promise((resolve, reject) => { rejectLater = reject; });
    const offline = f.offline({ assertCompatible: () => ++checks === 1 ? true : delayed });
    await assert.rejects(offline.claim({ ...f.subscription, workerId: 'offline' }, { authorize: async () => {} }),
        { code: 'X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED' });
    const receiver = await f.receiver(); assert.equal(receiver.processing_lease_token, null);
    const network = await f.store.claim({ ...f.subscription, workerId: 'network' }); assert.ok(network);
    rejectLater(new Error('late verifier failure')); await new Promise(resolve => setImmediate(resolve));
    await f.store.release(network);
});
