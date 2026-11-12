'use strict';

// Disposable SQL fixture for the packaged setup test's clock / lease boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, encrypted, vault, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { createXEventRouter } = require('../../src/automation/x-event-router');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const { makeBatchDue } = require('../../experiments/chrome-push/packaged-cadence-fixture.cjs');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('a packaged fixture advances batch cadence without expiring its live receiver lease', { skip: !port, timeout: 30000 }, async t => {
    const db = await createTestDatabase(port);
    let runtime;
    t.after(async () => { await runtime?.stop(); await db.close(); });
    const now = Date.parse('2026-10-14T03:00:00Z');
    let queueClock = now;
    const subscription = await insertSubscription(db);
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    const store = createXPushStore(db, { now: () => now, leaseMs: 300000 });
    const lease = await store.claim({ ...subscription, workerId: 'packaged-fixture' });
    const monitor = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)", [ownerUserId, JSON.stringify({ subscriptionId: subscription.subscriptionId }), now, now]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, ownerUserId, 'x', String(monitor.insertId)));
    const wire = await encrypted(subscription.file, { notificationType: 'tweet', text: 'synthetic',
        url: 'https://x.com/synthetic/status/1234567890123456789', author: { handle: 'synthetic', id: '12345' } });
    const receipt = await store.recordFrame(lease, { version: 'fixture', data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 });
    await makeBatchDue(db, subscription.subscriptionId, now);
    const queue = createQueue(db, {}, { clock: () => queueClock, rolloutMode: 'public' });
    const gateway = createXPushGateway(db, { enabled: true, store, privateWorkerVault: vault, now: () => now, rolloutMode: 'public' });
    runtime = createXPushRuntime(db, queue, { enabled: true, gateway, router: createXEventRouter(db, queue, { clock: () => queueClock }),
        clock: () => queueClock, rolloutMode: 'public', processingPolicy: 'batch', assertAllowed: () => {}, pageSize: 2, listCandidates: async () => [] });

    // Reproduce the original test bug: moving only the queue clock past the
    // actual lease expiry makes the transactional recovery fence reject it.
    queueClock = now + 301000;
    await assert.rejects(runtime.drain(lease, { recoverySignal: new AbortController().signal }), { code: 'X_PUSH_LEASE_LOST' });
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 0);
    assert.equal((await store.getInbox({ ...subscription, id: receipt.id })).status, 'received');

    // A past batch anchor models elapsed cadence while leaving both queue and
    // lease clocks aligned, allowing the same receipt to route exactly once.
    queueClock = now;
    const result = await runtime.drain(lease, { recoverySignal: new AbortController().signal });
    assert.equal(result.processed, 1);
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
    assert.equal((await store.getInbox({ ...subscription, id: receipt.id })).status, 'routed');
    assert.equal((await runtime.drain(lease, { recoverySignal: new AbortController().signal })).state, 'pending');
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
});
