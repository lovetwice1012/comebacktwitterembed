'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { createSyntheticStateVault } = require('../../experiments/chrome-push/edge-fixture-state-vault.cjs');
const { createSyntheticTokenStateStore } = require('../../experiments/chrome-push/edge-fixture-state-store.cjs');
const privateKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const context = { subscriptionId: randomUUID(), ownerUserId: '222222222222222222', revision: 1, generation: 1 };
test('synthetic state token is encrypted and bound to owner, subscription, revision and generation', () => {
    const vault = createSyntheticStateVault(privateKey), token = Buffer.from('synthetic-secret-token'), envelope = vault.seal(token, context);
    assert.equal(JSON.stringify(envelope).includes(token.toString()), false);
    const opened = vault.open(envelope, context); assert.deepEqual(opened, token); opened.fill(0);
    for (const changed of [{ ...context, ownerUserId: '333333333333333333' }, { ...context, subscriptionId: randomUUID() },
        { ...context, revision: 2 }, { ...context, generation: 2 }]) assert.throws(() => vault.open(envelope, changed), { code: 'PROBE_STATE_VAULT_INVALID' });
    assert.throws(() => vault.open({ ...envelope, tag: 'A'.repeat(22) }, context), { code: 'PROBE_STATE_VAULT_INVALID' });
    let called = false; const getter = { ...envelope }; Object.defineProperty(getter, 'tag', { enumerable: true, get() { called = true; return envelope.tag; } });
    assert.throws(() => vault.open(getter, context), { code: 'PROBE_STATE_VAULT_INVALID' }); assert.equal(called, false);
    token.fill(0);
});
test('synthetic state vault rejects invalid tokens and weak keys', () => {
    const vault = createSyntheticStateVault(privateKey);
    for (const token of [Buffer.alloc(0), Buffer.alloc(4097, 65), Buffer.from('bad token'), Buffer.from([0xff])])
        assert.throws(() => vault.seal(token, context), { code: 'PROBE_STATE_VAULT_INVALID' });
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => createSyntheticStateVault(weak), { code: 'PROBE_STATE_VAULT_INVALID' });
});
test('synthetic state store refuses production mode, other schemas and non-fixture ports', () => {
    const previous = process.env.NODE_ENV, vault = createSyntheticStateVault(privateKey);
    const db = { schema: `cbte_automation_test_${'a'.repeat(20)}`, fixturePort: 33621, queryDatabase: async () => assert.fail(), withDatabaseTransaction: async () => assert.fail() };
    try {
        process.env.NODE_ENV = 'production'; assert.throws(() => createSyntheticTokenStateStore(db, { vault }), { code: 'PROBE_STATE_CONFIG_INVALID' });
        process.env.NODE_ENV = 'test';
        assert.throws(() => createSyntheticTokenStateStore({ ...db, schema: 'production' }, { vault }), { code: 'PROBE_STATE_CONFIG_INVALID' });
        assert.throws(() => createSyntheticTokenStateStore({ ...db, fixturePort: 3306 }, { vault }), { code: 'PROBE_STATE_CONFIG_INVALID' });
    } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
