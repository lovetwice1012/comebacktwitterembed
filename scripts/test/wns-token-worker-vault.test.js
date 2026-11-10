'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { createWnsTokenWorkerVault, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const old = generateKeyPairSync('rsa', { modulusLength: 3072 });
const next = generateKeyPairSync('rsa', { modulusLength: 3072 });
const context = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789012345678', revision: 1, generation: 1 };
const token = Buffer.from('synthetic-token-never-real');
const make = (activeKeyId = 'old', privateKeys = { old: old.privateKey }) => createWnsTokenWorkerVault({ activeKeyId, privateKeys });

test('encrypts random envelopes and binds owner, subscription, revision and generation', () => {
    const vault = make(), first = vault.seal(token, context), second = vault.seal(token, context);
    assert.notDeepEqual(first, second);
    assert(!JSON.stringify(first).includes(token.toString()));
    assert.deepEqual(vault.open(first, context), token);
    for (const change of [
        { subscriptionId: '44444444-4444-4444-8444-444444444444' }, { ownerUserId: '999' }, { revision: 2 }, { generation: 2 },
    ]) assert.throws(() => vault.open(first, { ...context, ...change }), { code: 'X_SETUP_DECRYPT_FAILED' });
    const transfer = createTransferPrivateWorkerVault({ activeKeyId: 'old', privateKeys: { old: old.privateKey } });
    assert.throws(() => transfer.open(first, context), { code: 'X_SETUP_DECRYPT_FAILED' });
});
test('rotation preserves access only while previous private key remains available', () => {
    const first = make().seal(token, context);
    const rotated = make('next', { old: old.privateKey, next: next.privateKey });
    assert.deepEqual(rotated.open(first, context), token);
    const second = rotated.seal(token, { ...context, generation: 2 });
    assert.equal(second.keyId, 'next');
    assert.throws(() => make('next', { next: next.privateKey }).open(first, context), { code: 'X_SETUP_DECRYPT_FAILED' });
});
test('rejects malformed, tampered, unsafe and out-of-bound inputs without revealing token', () => {
    const vault = make(), envelope = vault.seal(token, context);
    for (const value of [Buffer.alloc(0), Buffer.alloc(4097, 65), Buffer.from('a\nb'), 'not a buffer'])
        assert.throws(() => vault.seal(value, context), { code: 'X_SETUP_VAULT_UNAVAILABLE' });
    const getter = { ...envelope }; Object.defineProperty(getter, 'tag', { get() { throw new Error('getter invoked'); }, enumerable: true });
    for (const value of [getter, { ...envelope, tag: 'bad' }, { ...envelope, ciphertext: 'AA=' }, { ...envelope, keyId: 'missing' }, { ...envelope, extra: 1 }]) {
        assert.throws(() => vault.open(value, context), error => error.code === 'X_SETUP_DECRYPT_FAILED' && !String(error.stack).includes(token.toString()));
    }
    assert.throws(() => vault.seal(token, { ...context, generation: 0 }), { code: 'X_SETUP_VAULT_UNAVAILABLE' });
});
