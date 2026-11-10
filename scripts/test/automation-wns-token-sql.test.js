'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
const { insertSubscription } = require('./helpers/x-push-fixture.cjs');
const key = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey;
const vault = createWnsTokenWorkerVault({ activeKeyId: 'test', privateKeys: { test: key } });
const authorize = async () => {};
const token = Buffer.from('synthetic-wns-token');
async function setup(work) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try { await work(db); } finally { await db.close(); }
}
async function edge(db, options = {}) {
    const sub = await insertSubscription(db);
    await db.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [sub.subscriptionId]);
    const store = createXPushStore(db, options), lease = await store.claim({ ...sub, workerId: 'wns-test' });
    return { sub, store, lease };
}
test('encrypted generation survives worker replacement and concurrent rotations cannot both succeed', async () => setup(async db => {
    const { sub, store, lease } = await edge(db);
    assert.equal(await store.readWnsTokenState(lease, { vault, authorize }), null);
    assert.deepEqual(await store.saveWnsTokenState(lease, { vault, authorize, token, expectedGeneration: 0 }), { generation: 1 });
    const stored = (await db.queryDatabase('SELECT wns_token_sealed_json FROM automation_x_push_receivers'))[0];
    assert(!stored.wns_token_sealed_json.includes(token.toString()));
    const results = await Promise.allSettled([1, 2].map(() => store.saveWnsTokenState(lease, { vault, authorize, token, expectedGeneration: 1 })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'X_PUSH_WNS_STATE_CONFLICT');
    await store.release(lease);
    const successor = createXPushStore(db), next = await successor.claim({ ...sub, workerId: 'successor' });
    const restored = await successor.readWnsTokenState(next, { vault, authorize });
    assert.equal(restored.generation, 2); assert.deepEqual(restored.token, token); restored.token.fill(0);
    await assert.rejects(store.readWnsTokenState(lease, { vault, authorize }), { code: 'X_PUSH_LEASE_LOST' });
    await assert.rejects(successor.readWnsTokenState({ ...next, ownerUserId: '111111' }, { vault, authorize }), { code: 'X_PUSH_SUBSCRIPTION_NOT_FOUND' });
}));
test('failed writes, authorization and expiry preserve previous token; revision change fails closed', async () => setup(async db => {
    let now = 1000;
    const { sub, store, lease } = await edge(db, { now: () => now, leaseMs: 1000 });
    await store.saveWnsTokenState(lease, { vault, authorize, token, expectedGeneration: 0 });
    const failing = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params); if (sql.startsWith('UPDATE automation_x_push_receivers SET wns_token_')) throw new Error('fixture failure'); return result;
    })) };
    await assert.rejects(createXPushStore(failing, { now: () => now }).saveWnsTokenState(lease, { vault, authorize, token, expectedGeneration: 1 }), { code: 'X_PUSH_STORE_UNAVAILABLE' });
    await assert.rejects(store.saveWnsTokenState(lease, { vault, authorize: async () => { throw new Error('denied'); }, token, expectedGeneration: 1 }), { code: 'X_PUSH_STORE_UNAVAILABLE' });
    assert.equal((await store.readWnsTokenState(lease, { vault, authorize })).generation, 1);
    now = 2000;
    await assert.rejects(store.saveWnsTokenState(lease, { vault, authorize, token, expectedGeneration: 1 }), { code: 'X_PUSH_LEASE_LOST' });
    await db.queryDatabase('UPDATE automation_x_subscriptions SET revision=revision+1 WHERE id=?', [sub.subscriptionId]);
    const fresh = createXPushStore(db, { now: () => now, leaseMs: 1000 });
    const newer = await fresh.claim({ ...sub, workerId: 'new-revision' });
    await assert.rejects(fresh.readWnsTokenState(newer, { vault, authorize }), { code: 'X_PUSH_WNS_STATE_INVALID' });
}));
test('Firefox is ineligible and migration repeats without changing existing receipts', async () => setup(async db => {
    const sub = await insertSubscription(db), store = createXPushStore(db), lease = await store.claim({ ...sub, workerId: 'firefox' });
    await assert.rejects(store.saveWnsTokenState(lease, { vault, authorize, token, expectedGeneration: 0 }), { code: 'X_PUSH_WNS_BROWSER_INVALID' });
    const receipt = await store.recordFrame(lease, { version: 'before-wns', data: 'AA', headers: {}, status: 'received', ackCode: 100 });
    for (const column of ['wns_token_sealed_json', 'wns_token_revision', 'wns_token_generation']) await db.queryDatabase(`ALTER TABLE automation_x_push_receivers DROP COLUMN ${column}`);
    const migration = readFileSync(path.resolve(__dirname, '../../migrations/20261110_add_wns_token_state.sql'), 'utf8');
    for (let i = 0; i < 2; i++) for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.queryDatabase(statement);
    assert.equal((await store.getInbox({ ...sub, id: receipt.id })).version, 'before-wns');
}));
test('late lease expiry rolls back rotation and failed read commit clears plaintext', async () => setup(async db => {
    let now = 1000, plaintext;
    const { store, lease } = await edge(db, { now: () => now, leaseMs: 1000 });
    await store.saveWnsTokenState(lease, { vault, authorize, token, expectedGeneration: 0 });
    const delayed = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params); if (sql.startsWith('UPDATE automation_x_push_receivers SET wns_token_')) now = 2000; return result;
    })) };
    await assert.rejects(createXPushStore(delayed, { now: () => now, leaseMs: 1000 }).saveWnsTokenState(lease,
        { vault, authorize, token: Buffer.from('another'), expectedGeneration: 1 }), { code: 'X_PUSH_LEASE_LOST' });
    now = 1000;
    const failingCommit = { queryDatabase: db.queryDatabase, withDatabaseTransaction: work => db.withDatabaseTransaction(async query => {
        await work(query); throw new Error('fixture commit failed');
    }) };
    const trackingVault = { seal: vault.seal, open: (...args) => (plaintext = vault.open(...args)) };
    await assert.rejects(createXPushStore(failingCommit, { now: () => now }).readWnsTokenState(lease,
        { vault: trackingVault, authorize }), { code: 'X_PUSH_STORE_UNAVAILABLE' });
    assert(plaintext && plaintext.every(byte => byte === 0));
    const saved = await store.readWnsTokenState(lease, { vault, authorize });
    assert.equal(saved.generation, 1); assert.deepEqual(saved.token, token); saved.token.fill(0);
}));
