'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOfflineLease } = require('../../src/automation/x-push-offline-lease');
const input = { subscriptionId: '11111111-1111-4111-8111-111111111111', ownerUserId: '222222222222222222', workerId: 'fixture' };

test('offline processing remains closed without both explicit enablement and fleet proof', async () => {
    let transactions = 0;
    const db = { withDatabaseTransaction: async () => { transactions++; throw new Error('must not access DB'); } };
    const disabled = createOfflineLease(db);
    assert.equal(await disabled.claim(input, { authorize: async () => {} }), null);
    for (const assertCompatible of [undefined, async () => false, async () => { throw new Error('private fleet details'); }]) {
        const store = createOfflineLease(db, { enabled: true, assertCompatible });
        await assert.rejects(store.claim(input, { authorize: async () => {} }), error => {
            assert.equal(error.code, 'X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED'); assert(!error.message.includes('private')); return true;
        });
    }
    assert.equal(transactions, 0);
});

test('promise-returning fleet verifier fails promptly and its late rejection is handled', async () => {
    let rejectLater;
    const rejected = new Promise((resolve, reject) => { rejectLater = reject; });
    const db = { withDatabaseTransaction: async () => { throw new Error('unexpected transaction'); } };
    const store = createOfflineLease(db, { enabled: true, assertCompatible: () => rejected });
    await assert.rejects(store.claim({ subscriptionId: '12345678-1234-1234-1234-123456789abc', ownerUserId: '42', workerId: 'test' }, { authorize: async () => {} }),
        { code: 'X_PUSH_OFFLINE_COMPATIBILITY_UNVERIFIED' });
    rejectLater(new Error('late verifier error')); await new Promise(resolve => setImmediate(resolve));
});
