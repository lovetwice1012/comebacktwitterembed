'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createChromeMcsStoreAdapter } = require('../../src/automation/chrome-mcs-store-adapter');
const { createChromeMcsSession } = require('../../src/automation/chrome-mcs-session');
const { insertSubscription } = require('./helpers/x-push-fixture.cjs');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const frame = version => ({ version, data: 'AA', headers: { encoding: 'aes128gcm' }, status: 'received', ackCode: 100 });
async function setup(work) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try { for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await db.queryDatabase(sql); await work(db); }
    finally { await db.close(); }
}
test('100 unconfirmed receipts bound reconnect state and a rejected 101st leaves no partial receipt', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db);
    let lease = await store.claim({ ...sub, workerId: 'saturated' });
    for (let i = 0; i < 100; i++) await store.recordMcsFrame(lease, frame(`pending-${i}`));
    assert.equal((await store.pendingMcs(lease)).length, 100);
    assert.equal((await store.recordMcsFrame(lease, frame('pending-0'))).duplicate, true);
    await assert.rejects(store.recordMcsFrame(lease, frame('overflow')), { code: 'X_PUSH_MCS_PENDING_LIMIT' });
    await assert.rejects(store.recordMcsControl(lease, { kind: 'deleted_messages', persistentId: 'overflow-control' }), { code: 'X_PUSH_MCS_PENDING_LIMIT' });
    assert.equal((await db.queryDatabase("SELECT id FROM automation_x_push_inbox WHERE subscription_id=? AND version='overflow'", [sub.subscriptionId])).length, 0);
    assert.equal((await db.queryDatabase("SELECT id FROM automation_audit WHERE entity_id=? AND action='x.push.provider.deleted_messages'", [sub.subscriptionId])).length, 0);
    await store.release(lease);
    const successor = createXPushStore(db); lease = await successor.claim({ ...sub, workerId: 'successor' });
    const pending = await successor.pendingMcs(lease);
    assert.equal(pending.length, 100);
    assert.equal(await successor.confirmMcs(lease, pending), 100);
    assert.equal((await successor.recordMcsFrame(lease, frame('overflow'))).duplicate, false);
    assert.deepEqual(await successor.pendingMcs(lease), ['overflow']);
}));
test('saturated session closes without ACK and recovers after replay confirmation from a simulated server', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db);
    let lease = await store.claim({ ...sub, workerId: 'saturated-session' }), writes = 0, deliveries = 0;
    const bytes = (n, value) => Buffer.concat([Buffer.from([n * 8 + 2, Buffer.byteLength(value)]), Buffer.from(value)]);
    const pair = (key, value) => bytes(7, Buffer.concat([bytes(1, key), bytes(2, value)]));
    const incoming = id => ({ tag: 8, payload: Buffer.concat([bytes(3, 'sender'), bytes(5, 'com.chrome.windows'), pair('subtype', 'app'),
        pair('content-encoding', 'aes128gcm'), bytes(9, id), Buffer.from([0xaa, 1, 1, 42])]) });
    const login = { tag: 3, payload: Buffer.concat([bytes(1, 'ok'), Buffer.from([48, 1])]) };
    const makeSession = current => createChromeMcsSession({ credentials: { deviceId: '1', securityToken: '2', clientVersion: '140.0' },
        route: { expectedCategory: 'com.chrome.windows', expectedAppId: 'app', expectedSender: 'sender' },
        store: createChromeMcsStoreAdapter({ store, lease: current, authorize: async () => {}, decrypt: async () => {} }),
        send: async () => { writes++; }, onReceipt: () => { deliveries++; } });
    let session = makeSession(lease); await session.start(); await session.receive(login);
    for (let i = 0; i < 100; i++) await session.receive(incoming(`pending-${i}`));
    const before = writes;
    await assert.rejects(session.receive(incoming('overflow')), { code: 'X_PUSH_MCS_PENDING_LIMIT' });
    assert.equal(writes, before); assert.equal(deliveries, 100);
    await assert.rejects(session.receive(incoming('overflow')), { code: 'X_CHROME_SESSION_INVALID' });
    await store.release(lease); lease = await store.claim({ ...sub, workerId: 'successor-session' });
    session = makeSession(lease); await session.start(); assert.equal((await store.pendingMcs(lease)).length, 100);
    await session.receive(login); assert.equal((await store.pendingMcs(lease)).length, 0);
    await session.receive(incoming('overflow')); assert.equal(deliveries, 101);
    assert.deepEqual(await store.pendingMcs(lease), ['overflow']);
}));
test('MCS receipt and pending ACK persist together across workers and are owner/lease fenced', async () => setup(async db => {
    const sub = await insertSubscription(db), first = createXPushStore(db);
    let lease = await first.claim({ ...sub, workerId: 'one' });
    const receipt = await first.recordMcsFrame(lease, frame('id-1'));
    assert.deepEqual(await first.pendingMcs(lease), ['id-1']);
    assert.equal((await first.recordMcsFrame(lease, frame('id-1'))).id, receipt.id);
    await first.release(lease);
    const second = createXPushStore(db); lease = await second.claim({ ...sub, workerId: 'two' });
    assert.deepEqual(await second.pendingMcs(lease), ['id-1']);
    await assert.rejects(second.confirmMcs({ ...lease, ownerUserId: '333333333333333333' }, ['id-1']), e => e.code === 'X_PUSH_SUBSCRIPTION_NOT_FOUND');
    await assert.rejects(second.confirmMcs(lease, ['id-1'], { authorize: async () => { throw new Error('denied'); } }), e => e.code === 'X_PUSH_STORE_UNAVAILABLE');
    assert.deepEqual(await second.pendingMcs(lease), ['id-1']);
    assert.equal(await second.confirmMcs(lease, ['id-1']), 1);
    assert.deepEqual(await second.pendingMcs(lease), []);
    assert.equal((await second.getInbox({ ...sub, id: receipt.id })).id, receipt.id);
}));
test('failure inserting pending ACK rolls back ciphertext too', async () => setup(async db => {
    const sub = await insertSubscription(db), plain = createXPushStore(db);
    const lease = await plain.claim({ ...sub, workerId: 'one' });
    const failing = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (sql.startsWith('INSERT INTO automation_x_mcs_pending')) throw new Error('fixture database failure');
        return query(sql, params);
    })) };
    await assert.rejects(createXPushStore(failing).recordMcsFrame(lease, frame('rollback')), e => e.code === 'X_PUSH_STORE_UNAVAILABLE');
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    assert.deepEqual(await plain.pendingMcs(lease), []);
}));
test('expired lease at commit rolls back receipt and pending ACK', async () => setup(async db => {
    let now = 1000;
    const sub = await insertSubscription(db), plain = createXPushStore(db, { now: () => now, leaseMs: 1000 });
    const lease = await plain.claim({ ...sub, workerId: 'one' });
    const delayed = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('INSERT INTO automation_x_mcs_pending')) now = 2000;
        return result;
    })) };
    await assert.rejects(createXPushStore(delayed, { now: () => now, leaseMs: 1000 }).recordMcsFrame(lease, frame('late')),
        e => e.code === 'X_PUSH_LEASE_LOST');
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_mcs_pending')).length, 0);
}));
test('session store adapter saves only ciphertext and recovers failed decryptions', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db);
    const lease = await store.claim({ ...sub, workerId: 'adapter' });
    let calls = 0;
    const adapter = createChromeMcsStoreAdapter({ store, lease, authorize: async () => { calls++; }, decrypt: async () => { throw new Error('plaintext should not be recorded'); } });
    const receipt = await adapter.commit({ persistentId: 'encrypted-1', encrypted: { data: Buffer.from([1, 2, 3]), headers: { encoding: 'aes128gcm' } } });
    assert.equal(receipt.status, 'decryption_failed'); assert.equal(receipt.data, 'AQID'); assert.equal(receipt.ackCode, 101);
    assert.deepEqual(await adapter.pending(), ['encrypted-1']);
    await adapter.confirm(['encrypted-1']); assert.deepEqual(await adapter.pending(), []);
    assert(calls >= 4);
}));
test('additive migration is repeatable and rollback leaves existing Firefox receipts intact', async () => setup(async db => {
    assert.match(db.schema, /^cbte_automation_test_[0-9a-f]{20}$/);
    const sub = await insertSubscription(db), store = createXPushStore(db);
    const lease = await store.claim({ ...sub, workerId: 'migration' });
    const old = await store.recordFrame(lease, frame('firefox-existing'));
    await db.queryDatabase('DROP TABLE automation_x_mcs_pending');
    const migration = readFileSync(path.resolve(__dirname, '../../migrations/20261110_add_chrome_mcs_pending.sql'), 'utf8');
    await db.queryDatabase(migration); await db.queryDatabase(migration);
    assert.equal((await store.getInbox({ ...sub, id: old.id })).version, 'firefox-existing');
    await db.queryDatabase('DROP TABLE automation_x_mcs_pending');
    assert.equal((await store.getInbox({ ...sub, id: old.id })).version, 'firefox-existing');
}));
test('check-in timestamps survive worker replacement, enforce ownership and reset on subscription revision', async () => setup(async db => {
    let clock = 1000;
    const sub = await insertSubscription(db), first = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    let lease = await first.claim({ ...sub, workerId: 'one' });
    assert.deepEqual(await first.chromeCheckinState(lease), { checkedAtMs: null, intervalSeconds: 172800 });
    assert.deepEqual(await first.recordChromeCheckin(lease, { intervalSeconds: 50000 }), { checkedAtMs: 1000, intervalSeconds: 50000 });
    await first.release(lease); clock = 1100;
    const second = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    lease = await second.claim({ ...sub, workerId: 'two' });
    assert.deepEqual(await second.chromeCheckinState(lease), { checkedAtMs: 1000, intervalSeconds: 50000 });
    await assert.rejects(second.recordChromeCheckin({ ...lease, ownerUserId: '333333333333333333' }, { intervalSeconds: 50000 }), { code: 'X_PUSH_SUBSCRIPTION_NOT_FOUND' });
    await assert.rejects(second.recordChromeCheckin(lease, { intervalSeconds: 10 }), { code: 'X_PUSH_CHECKIN_STATE_INVALID' });
    clock = 2100;
    await assert.rejects(second.recordChromeCheckin(lease, { intervalSeconds: 50000 }), { code: 'X_PUSH_LEASE_LOST' });
    assert.equal(Number((await db.queryDatabase('SELECT chrome_checkin_at_ms FROM automation_x_push_receivers'))[0].chrome_checkin_at_ms), 1000);
    await db.queryDatabase('UPDATE automation_x_subscriptions SET revision=revision+1 WHERE id=?', [sub.subscriptionId]);
    const third = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    lease = await third.claim({ ...sub, workerId: 'three' });
    assert.deepEqual(await third.chromeCheckinState(lease), { checkedAtMs: null, intervalSeconds: 172800 });
}));
test('check-in migration is repeatable and retains existing Firefox receiver data', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db);
    const lease = await store.claim({ ...sub, workerId: 'migration' });
    const old = await store.recordFrame(lease, frame('before-checkin-migration'));
    for (const name of ['chrome_checkin_at_ms', 'chrome_checkin_interval_seconds', 'chrome_checkin_revision'])
        await db.queryDatabase(`ALTER TABLE automation_x_push_receivers DROP COLUMN ${name}`);
    const migration = readFileSync(path.resolve(__dirname, '../../migrations/20261110_add_chrome_checkin.sql'), 'utf8');
    const statements = migration.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < 2; i++) for (const statement of statements) await db.queryDatabase(statement);
    assert.equal((await store.getInbox({ ...sub, id: old.id })).version, 'before-checkin-migration');
    assert.deepEqual(await store.chromeCheckinState(lease), { checkedAtMs: null, intervalSeconds: 172800 });
}));
test('check-in update rolls back when its lease expires before commit', async () => setup(async db => {
    let clock = 1000;
    const sub = await insertSubscription(db), store = createXPushStore(db, { now: () => clock, leaseMs: 1000 });
    const lease = await store.claim({ ...sub, workerId: 'checkin-rollback' });
    const failing = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('UPDATE automation_x_push_receivers SET chrome_checkin_at_ms=')) clock = 2000;
        return result;
    })) };
    await assert.rejects(createXPushStore(failing, { now: () => clock, leaseMs: 1000 })
        .recordChromeCheckin(lease, { intervalSeconds: 50000 }), { code: 'X_PUSH_LEASE_LOST' });
    const row = (await db.queryDatabase('SELECT chrome_checkin_at_ms,chrome_checkin_interval_seconds,chrome_checkin_revision FROM automation_x_push_receivers WHERE subscription_id=?', [sub.subscriptionId]))[0];
    assert.equal(row.chrome_checkin_at_ms, null); assert.equal(row.chrome_checkin_interval_seconds, null); assert.equal(row.chrome_checkin_revision, null);
}));
test('provider control notices are durable, owner-scoped, deduplicated and never create an inbox payload', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db);
    let lease = await store.claim({ ...sub, workerId: 'control-one' });
    const notice = { kind: 'deleted_messages', persistentId: 'provider-loss-1' };
    assert.deepEqual(await store.recordMcsControl(lease, notice), { duplicate: false });
    assert.deepEqual(await store.pendingMcs(lease), ['provider-loss-1']);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_push_inbox')).length, 0);
    const audit = await db.queryDatabase("SELECT * FROM automation_audit WHERE action='x.push.provider.deleted_messages'");
    assert.equal(audit.length, 1); assert(!JSON.stringify(audit).includes('provider-loss-1'));
    const status = await require('../../src/automation/x-setup').createXSetup(db, { sealer: null, rolloutMode: 'public' }).status({ userId: sub.ownerUserId });
    assert.equal(status.subscriptions[0].lastProviderLossAtMs, Number(audit[0].created_at_ms));
    const other = await require('../../src/automation/x-setup').createXSetup(db, { sealer: null, rolloutMode: 'public' }).status({ userId: '333333333333333333' });
    assert.deepEqual(other.subscriptions, []);
    await assert.rejects(store.recordMcsControl({ ...lease, ownerUserId: '333333333333333333' }, notice), { code: 'X_PUSH_SUBSCRIPTION_NOT_FOUND' });
    await assert.rejects(store.recordMcsFrame(lease, frame('provider-loss-1')), { code: 'X_PUSH_MCS_ID_CONFLICT' });
    await store.release(lease); lease = await store.claim({ ...sub, workerId: 'control-two' });
    assert.deepEqual(await store.pendingMcs(lease), ['provider-loss-1']);
    assert.deepEqual(await store.recordMcsControl(lease, notice), { duplicate: true });
    await store.confirmMcs(lease, ['provider-loss-1']);
    assert.deepEqual(await store.recordMcsControl(lease, notice), { duplicate: true });
    assert.equal((await db.queryDatabase("SELECT id FROM automation_audit WHERE action='x.push.provider.deleted_messages'")).length, 1);
    await assert.rejects(store.recordMcsControl(lease, { ...notice, kind: 'send_error' }), { code: 'X_PUSH_MCS_ID_CONFLICT' });
    await assert.rejects(store.recordMcsFrame(lease, frame('provider-loss-1')), { code: 'X_PUSH_MCS_ID_CONFLICT' });
    await store.recordMcsControl(lease, { kind: 'send_error', persistentId: null });
    assert.equal((await db.queryDatabase("SELECT id FROM automation_audit WHERE action='x.push.provider.send_error'")).length, 1);
}));
test('provider control audit failure rolls back the pending acknowledgment', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db), lease = await store.claim({ ...sub, workerId: 'control-failure' });
    const failing = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (sql.startsWith('INSERT INTO automation_audit')) throw new Error('synthetic audit failure');
        return query(sql, params);
    })) };
    await assert.rejects(createXPushStore(failing).recordMcsControl(lease, { kind: 'deleted_messages', persistentId: 'loss-rollback' }),
        { code: 'X_PUSH_STORE_UNAVAILABLE' });
    assert.deepEqual(await store.pendingMcs(lease), []);
    assert.equal((await db.queryDatabase("SELECT id FROM automation_audit WHERE action='x.push.provider.deleted_messages'")).length, 0);
}));
test('control pending migration is repeatable and preserves prior receipts', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db), lease = await store.claim({ ...sub, workerId: 'control-migration' });
    const old = await store.recordFrame(lease, frame('legacy-receipt'));
    const existing = await store.recordMcsFrame(lease, frame('existing-pending'));
    await db.queryDatabase('ALTER TABLE automation_x_mcs_pending MODIFY COLUMN inbox_id BIGINT UNSIGNED NOT NULL');
    const migration = readFileSync(path.resolve(__dirname, '../../migrations/20261110_allow_chrome_mcs_control_pending.sql'), 'utf8');
    const statements = migration.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < 2; i++) for (const statement of statements) await db.queryDatabase(statement);
    await store.recordMcsControl(lease, { kind: 'deleted_messages', persistentId: 'control-after-migration' });
    assert.equal((await store.getInbox({ ...sub, id: old.id })).version, 'legacy-receipt');
    assert.equal((await store.getInbox({ ...sub, id: existing.id })).version, 'existing-pending');
    assert((await store.pendingMcs(lease)).includes('existing-pending'));
    await assert.rejects(db.queryDatabase('ALTER TABLE automation_x_mcs_pending MODIFY COLUMN inbox_id BIGINT UNSIGNED NOT NULL'));
    assert((await store.pendingMcs(lease)).includes('control-after-migration'));
    await store.confirmMcs(lease, ['control-after-migration']);
    await db.queryDatabase('ALTER TABLE automation_x_mcs_pending MODIFY COLUMN inbox_id BIGINT UNSIGNED NOT NULL');
    assert.equal((await store.getInbox({ ...sub, id: old.id })).version, 'legacy-receipt');
    assert.deepEqual(await store.pendingMcs(lease), ['existing-pending']);
}));
