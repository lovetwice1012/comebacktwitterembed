'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, encrypted, vault, ownerUserId } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createXPushGateway } = require('../../src/automation/x-push-gateway');
const { createXEventRouter } = require('../../src/automation/x-event-router');
const { createQueue } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const { createSyntheticDurableReceiver } = require('../../experiments/chrome-push/edge-fixture-durable.cjs');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), channel = Buffer.from('1;synthetic-target');
const post = { notificationType: 'tweet', author: { id: '12345', handle: 'synthetic' },
    url: 'https://x.com/synthetic/status/1234567890123456789', text: 'synthetic-content' };
function frame(cipher, id = 'synthetic-id', site = '1;synthetic-target') {
    const body = Buffer.concat([Buffer.from(`Channel: ${site}\r\nMsg-Id: ${id}\r\nContent-Encoding: aes128gcm\r\n\r\n`), cipher]);
    return Buffer.concat([Buffer.from(`NFY 1 WNS\\NOTIF A1 ${body.length}\r\n`), body]);
}
async function fixture(work) {
    if (port !== 33621) throw new Error('Synthetic WNS SQL requires the disposable loopback port 33621');
    const db = await createTestDatabase(port);
    try {
        let now = 1000;
        const subscription = await insertSubscription(db), store = createXPushStore(db, { now: () => now, leaseMs: 1000 });
        const lease = await store.claim({ ...subscription, workerId: 'fixture-first' });
        const wire = await encrypted(subscription.file, post), cipher = Buffer.from(wire.data, 'base64url');
        try { await work({ db, subscription, store, lease, cipher, clock: () => now, advance: value => { now += value; } }); }
        finally { cipher.fill(0); }
    } finally { await db.close(); }
}
test('synthetic WNS ciphertext survives a post-commit stop and is routed once after lease takeover', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    let inboxId, acknowledgements = 0;
    const receiver = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store: f.store, lease: f.lease, channel,
        authorize: async () => {}, beforeAck: async saved => { inboxId = saved.id; throw new Error('SYNTHETIC_STOP'); }, sendAck: async () => { acknowledgements++; } });
    await assert.rejects(receiver.receive(frame(f.cipher), 5), /SYNTHETIC_STOP/); assert.equal(acknowledgements, 0);
    const retained = await f.store.getInbox({ ...f.subscription, id: inboxId });
    assert.equal(retained.status, 'received'); assert.equal(retained.data, f.cipher.toString('base64url'));
    f.advance(1001);
    const successor = await createXPushStore(f.db, { now: f.clock, leaseMs: 1000 }).claim({ ...f.subscription, workerId: 'fixture-successor' });
    await assert.rejects(f.store.assertLease(f.lease), { code: 'X_PUSH_LEASE_LOST' });
    await f.db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
    const monitor = await f.db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
        [ownerUserId, JSON.stringify({ subscriptionId: f.subscription.subscriptionId }), f.clock(), f.clock()]);
    await f.db.withDatabaseTransaction(query => entitlements.assignSlot(query, ownerUserId, 'x', String(monitor.insertId)));
    const gateway = createXPushGateway(f.db, { enabled: true, store: f.store, privateWorkerVault: vault, now: f.clock });
    const payload = await gateway.decryptInbox(successor, retained), queue = createQueue(f.db, {}, { clock: f.clock, rolloutMode: 'public' });
    const router = createXEventRouter(f.db, queue, { clock: f.clock });
    assert.equal((await router.routeReceived({ lease: successor, inbox: retained, payload, processingMode: 'batch' })).state, 'routed');
    await f.store.markRouted(successor, inboxId);
    const again = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store: f.store, lease: successor, channel,
        authorize: async () => {}, sendAck: async () => { acknowledgements++; } });
    assert.equal((await again.receive(frame(f.cipher), 6)).duplicate, true);
    assert.equal(acknowledgements, 1);
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 1);
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 1);
}));
test('synthetic WNS SQL failure rolls back ciphertext without sending an ACK', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    let acknowledgements = 0;
    const failing = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('INSERT INTO automation_x_push_inbox')) throw new Error('synthetic-db-failure');
        return result;
    })) };
    const store = createXPushStore(failing, { now: f.clock, leaseMs: 1000 });
    const receiver = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store, lease: f.lease, channel,
        authorize: async () => {}, sendAck: async () => { acknowledgements++; } });
    await assert.rejects(receiver.receive(frame(f.cipher), 5), { code: 'X_PUSH_STORE_UNAVAILABLE' });
    assert.equal(acknowledgements, 0); assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 0);
}));
test('synthetic WNS lease expiry during insert rolls back and never ACKs', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    let acknowledgements = 0;
    const slow = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('INSERT INTO automation_x_push_inbox')) f.advance(1001);
        return result;
    })) };
    const receiver = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store: createXPushStore(slow, { now: f.clock, leaseMs: 1000 }),
        lease: f.lease, channel, authorize: async () => {}, sendAck: async () => { acknowledgements++; } });
    await assert.rejects(receiver.receive(frame(f.cipher), 5), { code: 'X_PUSH_LEASE_LOST' });
    assert.equal(acknowledgements, 0); assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 0);
}));
test('synthetic WNS expiry after commit keeps ciphertext for a successor and withholds ACK', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    let acknowledgements = 0;
    const receiver = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store: f.store, lease: f.lease, channel,
        authorize: async () => {}, beforeAck: async () => f.advance(1001), sendAck: async () => { acknowledgements++; } });
    await assert.rejects(receiver.receive(frame(f.cipher), 5), { code: 'X_PUSH_LEASE_LOST' });
    assert.equal(acknowledgements, 0); assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 1);
    const successor = await f.store.claim({ ...f.subscription, workerId: 'fixture-successor' });
    assert(successor); assert.equal((await f.store.listInbox(successor)).length, 1);
}));
test('synthetic WNS authorization revoked after commit withholds ACK', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    let acknowledgements = 0, allowed = true;
    const receiver = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store: f.store, lease: f.lease, channel,
        authorize: async () => { if (!allowed) throw new Error('synthetic-revocation'); }, beforeAck: async () => { allowed = false; },
        sendAck: async () => { acknowledgements++; } });
    await assert.rejects(receiver.receive(frame(f.cipher), 5), { code: 'X_PUSH_STORE_UNAVAILABLE' });
    assert.equal(acknowledgements, 0); assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 1);
}));
test('synthetic WNS recipient and identifier conflicts never persist foreign data or ACK collisions', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    let acknowledgements = 0;
    const receiver = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store: f.store, lease: f.lease, channel,
        authorize: async () => {}, sendAck: async () => { acknowledgements++; } });
    assert.deepEqual(await receiver.receive(frame(f.cipher, 'foreign-id', '1;other'), 5), { state: 'discarded' });
    assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 0);
    await receiver.receive(frame(f.cipher), 6); assert.equal(acknowledgements, 2);
    await assert.rejects(receiver.receive(frame(Buffer.from('different'), 'synthetic-id'), 7), { code: 'X_EDGE_WNS_RECEIPT_CONFLICT' });
    assert.equal(acknowledgements, 2); assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n), 1);
    const forged = createSyntheticDurableReceiver({ scope: 'http://127.0.0.1:32123/', store: f.store,
        lease: { ...f.lease, ownerUserId: '999999999999999999' }, channel, authorize: async () => {}, sendAck: async () => { acknowledgements++; } });
    await assert.rejects(forged.receive(frame(f.cipher, 'foreign-owner'), 8), { code: 'X_PUSH_SUBSCRIPTION_NOT_FOUND' });
    assert.equal(acknowledgements, 2);
}));
