'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { createSyntheticStateVault } = require('../../experiments/chrome-push/edge-fixture-state-vault.cjs');
const { createSyntheticTokenStateStore } = require('../../experiments/chrome-push/edge-fixture-state-store.cjs');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const privateKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const authorize = async () => {};
async function fixture(work) {
    if (port !== 33621 || process.env.NODE_ENV !== 'test') throw new Error('Synthetic state SQL requires the disposable loopback DB');
    const raw = await createTestDatabase(port), db = { ...raw, fixturePort: port };
    try {
        let now = 1000;
        const clock = () => now, subscription = await insertSubscription(db), store = createXPushStore(db, { now: clock, leaseMs: 1000 });
        const lease = await store.claim({ ...subscription, workerId: 'fixture-first' });
        const vault = createSyntheticStateVault(privateKey), state = createSyntheticTokenStateStore(db, { vault, now: clock });
        await state.initialize();
        await work({ db, subscription, store, lease, vault, state, clock, advance: value => { now += value; } });
    } finally { await db.close(); }
}
test('synthetic rotated token is encrypted, generation-fenced and recoverable by a successor', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const first = Buffer.from('synthetic-token-one'), next = Buffer.from('synthetic-token-two');
    try {
        assert.deepEqual(await f.state.save(f.lease, first, 0, authorize), { generation: 1 });
        const row = (await f.db.queryDatabase('SELECT generation,sealed_json FROM cbte_fixture_wns_state'))[0];
        assert.equal(Number(row.generation), 1); assert.equal(row.sealed_json.includes(first.toString()), false);
        await assert.rejects(f.state.save(f.lease, next, 0, authorize), { code: 'PROBE_STATE_GENERATION_CONFLICT' });
        await assert.rejects(f.state.read({ ...f.lease, ownerUserId: '999999999999999999' }, authorize), { code: 'PROBE_STATE_LEASE_LOST' });
        f.advance(1001); const successor = await f.store.claim({ ...f.subscription, workerId: 'fixture-successor' });
        await assert.rejects(f.state.read(f.lease, authorize), { code: 'PROBE_STATE_LEASE_LOST' });
        const saved = await f.state.read(successor, authorize); assert.equal(saved.generation, 1); assert.deepEqual(saved.token, first); saved.token.fill(0);
        assert.deepEqual(await f.state.save(successor, next, 1, authorize), { generation: 2 });
        const updated = await f.state.read(successor, authorize); assert.deepEqual(updated.token, next); updated.token.fill(0);
    } finally { first.fill(0); next.fill(0); }
}));
test('simultaneous synthetic updates with one generation commit exactly once', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const a = Buffer.from('synthetic-a'), b = Buffer.from('synthetic-b');
    try {
        const results = await Promise.allSettled([f.state.save(f.lease, a, 0, authorize), f.state.save(f.lease, b, 0, authorize)]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PROBE_STATE_GENERATION_CONFLICT');
        const saved = await f.state.read(f.lease, authorize); assert.equal(saved.generation, 1);
        assert(saved.token.equals(a) || saved.token.equals(b)); saved.token.fill(0);
    } finally { a.fill(0); b.fill(0); }
}));
test('SQL failure or lease expiry before commit rolls back synthetic state', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const token = Buffer.from('synthetic-rollback');
    try {
        for (const mode of ['failure', 'expiry']) {
            const traced = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
                const result = await query(sql, params);
                if (sql.startsWith('UPDATE cbte_fixture_wns_state')) { if (mode === 'expiry') f.advance(1001); else throw new Error('synthetic-db-failure'); }
                return result;
            })) };
            const state = createSyntheticTokenStateStore(traced, { vault: f.vault, now: f.clock });
            await assert.rejects(state.save(f.lease, token, 0, authorize), { code: mode === 'expiry' ? 'PROBE_STATE_LEASE_LOST' : 'PROBE_STATE_STORE_UNAVAILABLE' });
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM cbte_fixture_wns_state'))[0].n), 0);
        }
    } finally { token.fill(0); }
}));
test('failed synthetic rotation preserves the previous committed token and generation', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const first = Buffer.from('synthetic-first'), second = Buffer.from('synthetic-next');
    try {
        await f.state.save(f.lease, first, 0, authorize);
        const traced = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
            const result = await query(sql, params);
            if (sql.startsWith('UPDATE cbte_fixture_wns_state')) throw new Error('synthetic-failure-after-update');
            return result;
        })) };
        const failing = createSyntheticTokenStateStore(traced, { vault: f.vault, now: f.clock });
        await assert.rejects(failing.save(f.lease, second, 1, authorize), { code: 'PROBE_STATE_STORE_UNAVAILABLE' });
        const saved = await f.state.read(f.lease, authorize);
        assert.equal(saved.generation, 1); assert.deepEqual(saved.token, first); saved.token.fill(0);
        assert.deepEqual(await f.state.save(f.lease, second, 1, authorize), { generation: 2 });
    } finally { first.fill(0); second.fill(0); }
}));
test('changing the stored generation without resealing is rejected', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const token = Buffer.from('synthetic-tamper');
    try {
        await f.state.save(f.lease, token, 0, authorize);
        await f.db.queryDatabase('UPDATE cbte_fixture_wns_state SET generation=2 WHERE subscription_id=?', [f.subscription.subscriptionId]);
        await assert.rejects(f.state.read(f.lease, authorize), { code: 'PROBE_STATE_VAULT_INVALID' });
    } finally { token.fill(0); }
}));
test('failed read transaction clears decrypted synthetic token and retains the committed state', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const token = Buffer.from('synthetic-read-failure'); let borrowed;
    try {
        await f.state.save(f.lease, token, 0, authorize);
        const observedVault = { seal: f.vault.seal, open: (...args) => { borrowed = f.vault.open(...args); return borrowed; } };
        const failing = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(async query => {
            await work(query); throw new Error('synthetic-failure-before-commit');
        }) };
        const state = createSyntheticTokenStateStore(failing, { vault: observedVault, now: f.clock });
        await assert.rejects(state.read(f.lease, authorize), { code: 'PROBE_STATE_STORE_UNAVAILABLE' });
        assert(borrowed && borrowed.every(byte => byte === 0));
        const saved = await f.state.read(f.lease, authorize); assert.deepEqual(saved.token, token); saved.token.fill(0);
    } finally { token.fill(0); }
}));
