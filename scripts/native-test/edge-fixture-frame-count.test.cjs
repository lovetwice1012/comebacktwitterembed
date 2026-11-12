'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { countNotifications, batchTimeoutState, batchTimeoutCode } = require('../../experiments/chrome-push/edge-fixture-frame-count.cjs');

test('fixture observes only notification frame count and passes bytes unchanged', async () => {
    const values = [Buffer.from('CNT 1 CON\r\n'), Buffer.from('NFY 5 WNS\\NOTIF secret-ciphertext'), Buffer.from('NFY 6 WNS\\NOTIF secret-id')];
    const observed = countNotifications({ async next() { return values.shift(); }, send() { return 'sent'; }, close() {} });
    const first = await observed.transport.next(); assert.equal(first.toString(), 'CNT 1 CON\r\n');
    assert.equal(observed.getCount(), 0);
    const second = await observed.transport.next(); assert.equal(second.toString(), 'NFY 5 WNS\\NOTIF secret-ciphertext');
    await observed.transport.next(); assert.equal(observed.getCount(), 2); assert.equal(observed.transport.send(), 'sent');
    assert.equal(batchTimeoutCode(batchTimeoutState(4, observed.getCount())), 'PROBE_BATCH_TIMEOUT_4_NFYS_2');
});

test('observation bounds counts and rejects untrusted timeout diagnostics', async () => {
    const observed = countNotifications({ async next() { return Buffer.from('NFY secret'); } });
    for (let i = 0; i < 1002; i++) await observed.transport.next();
    assert.equal(observed.getCount(), 999);
    for (const value of ['batch-timeout-8-nfys-1', 'batch-timeout-0-nfys-1000', 'batch-timeout-1-nfys-01', 'batch-timeout-1-nfys-secret', null])
        assert.equal(batchTimeoutCode(value), null);
    assert.throws(() => batchTimeoutState(0, 1000), { message: 'PROBE_OBSERVATION_INVALID' });
    const broken = countNotifications({ async next() { throw Object.assign(new Error('fixed'), { code: 'X_TEST' }); } });
    await assert.rejects(broken.transport.next(), { code: 'X_TEST' }); assert.equal(broken.getCount(), 0);
});
