'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { countNotifications, createWireCounter, batchTimeoutState, batchTimeoutCode } = require('../../experiments/chrome-push/edge-fixture-frame-count.cjs');

test('fixture observes only notification frame count and passes bytes unchanged', async () => {
    const values = [Buffer.from('CNT 1 CON\r\n'), Buffer.from('NFY 5 WNS\\NOTIF secret-ciphertext'), Buffer.from('NFY 6 WNS\\NOTIF secret-id')];
    const observed = countNotifications({ async next() { return values.shift(); }, send() { return 'sent'; }, close() {} });
    const first = await observed.transport.next(); assert.equal(first.toString(), 'CNT 1 CON\r\n');
    assert.equal(observed.getCount(), 0);
    const second = await observed.transport.next(); assert.equal(second.toString(), 'NFY 5 WNS\\NOTIF secret-ciphertext');
    await observed.transport.next(); assert.equal(observed.getCount(), 2); assert.equal(observed.transport.send(), 'sent');
    assert.equal(batchTimeoutCode(batchTimeoutState(4, observed.getCount(), 3)), 'PROBE_BATCH_TIMEOUT_4_NFYS_2_WIRE_3');
});

test('observation bounds counts and rejects untrusted timeout diagnostics', async () => {
    const observed = countNotifications({ async next() { return Buffer.from('NFY secret'); } });
    for (let i = 0; i < 1002; i++) await observed.transport.next();
    assert.equal(observed.getCount(), 999);
    for (const value of ['batch-timeout-8-nfys-1-wire-1', 'batch-timeout-0-nfys-1000-wire-1', 'batch-timeout-1-nfys-01-wire-1', 'batch-timeout-1-nfys-1-wire-secret', null])
        assert.equal(batchTimeoutCode(value), null);
    assert.throws(() => batchTimeoutState(0, 1000, 1), { message: 'PROBE_OBSERVATION_INVALID' });
    const broken = countNotifications({ async next() { throw Object.assign(new Error('fixed'), { code: 'X_TEST' }); } });
    await assert.rejects(broken.transport.next(), { code: 'X_TEST' }); assert.equal(broken.getCount(), 0);
});

test('independent wire observer counts complete frames across splits without copying payload or trusting payload text', () => {
    const wire = createWireCounter();
    const frames = Buffer.from('CNT 1 CON 0\r\nNFY 9 WNS\\NOTIF 20\r\nNFY 8 WNS\\NOTIF 99\r\nNFY 10 WNS\\NOTIF 3\r\nabc');
    for (const byte of frames) wire.feed(Buffer.from([byte]));
    assert.equal(wire.result(), 2);
    assert.equal(batchTimeoutCode(batchTimeoutState(4, 1, wire.result())), 'PROBE_BATCH_TIMEOUT_4_NFYS_1_WIRE_2');
    assert.equal(batchTimeoutCode(batchTimeoutState(4, 1, 'invalid')), 'PROBE_BATCH_TIMEOUT_4_NFYS_1_WIRE_INVALID');
    const bad = createWireCounter(); bad.feed(Buffer.from('NFY 4 WNS\\NOTIF 999999\r\n')); assert.equal(bad.result(), 'invalid');
    bad.feed(Buffer.from('NFY 4 WNS\\NOTIF 0\r\n')); assert.equal(bad.result(), 'invalid');
});
