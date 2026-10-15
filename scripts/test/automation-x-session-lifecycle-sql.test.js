'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, FakeSocket, vault, encrypted } = require('./helpers/x-push-fixture.cjs');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const A = { userId: '222222222222222222' }, B = { userId: '333333333333333333' };

async function waitFor(check) {
    const end = Date.now() + 5000;
    while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert(check(), 'the owned fake socket completed its expected transition');
}

async function fixture(work) {
    const db = await createTestDatabase(port);
    let runtime;
    try {
        const opened = [], closed = [], leases = new Map();
        const gateway = createXPushGateway(db, { enabled: true, rolloutMode: 'public', privateWorkerVault: vault,
            requestTimeoutMs: 1000, pingIntervalMs: 100,
            createSocket: () => new FakeSocket((message, socket) => {
                if (message.messageType === 'hello') {
                    opened.push(message.uaid); socket.once('close', () => closed.push(message.uaid));
                    socket.reply({ messageType: 'hello', status: 200, uaid: message.uaid, use_webpush: true });
                } else if (!Object.keys(message).length) socket.reply({});
            }) });
        const wrapped = { ...gateway, store: { ...gateway.store,
            beginProcessing: async () => ({ ready: false, dueAtMs: Date.now() + 60000 }) },
        run: input => gateway.run({ ...input,
            onSession: value => { leases.set(input.subscriptionId, value.lease); input.onSession?.(value); },
            onLease: value => { leases.set(input.subscriptionId, value.lease); input.onLease?.(value); } }) };
        runtime = createXPushRuntime(db, {}, { enabled: true, gateway: wrapped, processingPolicy: 'batch',
            rolloutMode: 'public', assertAllowed: () => {}, maxConnections: 1, pageSize: 100 });
        const quota = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' });
        await work({ db, quota, gateway, runtime, opened, closed, leases });
    } finally {
        try { await runtime?.stop(); } finally { await db.close(); }
    }
}

test('S4-6: releasing the last monitor frees the receiver cap without restarting or deleting ciphertext', { skip: !port }, async () => fixture(async f => {
    const sa = await insertSubscription(f.db, undefined, A.userId), sb = await insertSubscription(f.db, undefined, B.userId);
    const a = await f.quota.register(A, { accountHandle: 'first', notificationSettings: { subscriptionId: sa.subscriptionId } });
    await f.runtime.tick(); await waitFor(() => f.opened.includes(sa.file.push.uaid) && f.leases.has(sa.subscriptionId));
    const wire = await encrypted(sa.file, { synthetic: 'durable retained ciphertext' });
    await f.gateway.store.recordFrame(f.leases.get(sa.subscriptionId), { version: 'retained', data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 });
    const before = await f.db.queryDatabase('SELECT id,data_ciphertext,status FROM automation_x_push_inbox WHERE subscription_id=?', [sa.subscriptionId]);
    await f.quota.release(A, a.id, { expectedRevision: a.revision });
    await f.quota.register(B, { accountHandle: 'second', notificationSettings: { subscriptionId: sb.subscriptionId } });
    await f.runtime.tick(); await waitFor(() => f.opened.includes(sb.file.push.uaid));
    assert.equal(f.runtime.status().sessions, 1); assert.deepEqual(f.closed, [sa.file.push.uaid]);
    assert.deepEqual(await f.db.queryDatabase('SELECT id,data_ciphertext,status FROM automation_x_push_inbox WHERE subscription_id=?', [sa.subscriptionId]), before);
    const status = await f.gateway.store.status({ subscriptionId: sa.subscriptionId, ownerUserId: A.userId, revision: 1 });
    assert.equal(status.retryAttempt, 0, 'intentional resource release is not a connection failure');
}));

test('S4-6: another eligible monitor keeps a shared session until its last user is paused', { skip: !port }, async () => fixture(async f => {
    const subscription = await insertSubscription(f.db, undefined, A.userId);
    const one = await f.quota.register(A, { accountHandle: 'one', notificationSettings: { subscriptionId: subscription.subscriptionId } });
    const two = await f.quota.register(A, { accountHandle: 'two', notificationSettings: { subscriptionId: subscription.subscriptionId } });
    await f.runtime.tick(); await waitFor(() => f.opened.length === 1);
    await f.quota.update(A, one.id, { expectedRevision: one.revision, enabled: false });
    await f.runtime.tick(); assert.equal(f.closed.length, 0); assert.equal(f.runtime.status().sessions, 1);
    await f.quota.update(A, two.id, { expectedRevision: two.revision, enabled: false });
    await f.runtime.tick(); assert.equal(f.closed.length, 1); assert.equal(f.runtime.status().sessions, 0);
}));

test('S4-6: rebinding moves the socket and subscription deletion closes only its session', { skip: !port }, async () => fixture(async f => {
    const one = await insertSubscription(f.db, undefined, A.userId), two = await insertSubscription(f.db, undefined, A.userId);
    const monitor = await f.quota.register(A, { accountHandle: 'rebound', notificationSettings: { subscriptionId: one.subscriptionId } });
    await f.runtime.tick(); await waitFor(() => f.opened.includes(one.file.push.uaid));
    await f.quota.update(A, monitor.id, { expectedRevision: monitor.revision, notificationSettings: { subscriptionId: two.subscriptionId } });
    await f.runtime.tick(); await waitFor(() => f.opened.includes(two.file.push.uaid));
    assert(f.closed.includes(one.file.push.uaid)); assert.equal(f.runtime.status().sessions, 1);
    await f.db.queryDatabase('DELETE FROM automation_x_subscriptions WHERE id=? AND owner_user_id=?', [two.subscriptionId, A.userId]);
    await f.runtime.tick(); assert(f.closed.includes(two.file.push.uaid)); assert.equal(f.runtime.status().sessions, 0);
}));

test('S4-6: an eligibility DB failure retains a healthy connection and retries without opening duplicates', { skip: !port }, async () => fixture(async f => {
    const one = await insertSubscription(f.db, undefined, A.userId);
    await f.quota.register(A, { accountHandle: 'stable', notificationSettings: { subscriptionId: one.subscriptionId } });
    await f.runtime.tick(); await waitFor(() => f.opened.length === 1);
    const query = f.db.queryDatabase;
    f.db.queryDatabase = async (sql, params) => {
        if (sql.includes('WHERE s.id IN (?)')) throw Object.assign(new Error('isolated transient read failure'), { code: 'FIXTURE_DB_FAILURE' });
        return query(sql, params);
    };
    await assert.rejects(f.runtime.tick(), { code: 'FIXTURE_DB_FAILURE' });
    assert.equal(f.closed.length, 0); assert.equal(f.runtime.status().sessions, 1);
    f.db.queryDatabase = query;
    await f.runtime.tick(); assert.equal(f.opened.length, 1); assert.equal(f.closed.length, 0);
}));
