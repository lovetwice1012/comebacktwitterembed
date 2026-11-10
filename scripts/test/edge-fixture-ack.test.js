'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syntheticNotificationAck } = require('../../experiments/chrome-push/edge-fixture-ack.cjs');
const frame = headers => { const body = Buffer.from(`${headers}\r\n\r\nsynthetic-cipher`); return Buffer.concat([Buffer.from(`NFY 1 WNS\\NOTIF A1 ${body.length}\r\n`), body]); };
test('synthetic ACK preserves notification identity and declared frame length', () => {
    const ack = syntheticNotificationAck(frame('Msg-Id: synthetic-id\r\nContent-Encoding: aes128gcm'), 5);
    const end = ack.indexOf('\r\n'), parts = ack.subarray(0, end).toString('ascii').split(' ');
    assert.deepEqual(parts.slice(0, 4), ['ACK', '5', 'WNS\\NOTIF', 'A1']);
    assert.equal(Number(parts[4]), ack.length - end - 2);
    assert(ack.includes(Buffer.from('Msg-Id: synthetic-id\r\n'))); ack.fill(0);
});
test('synthetic ACK rejects missing, duplicate and invalid message identifiers', () => {
    for (const value of [frame('Content-Encoding: aes128gcm'), frame('Msg-Id: a\r\nMsg-Id: b'), frame('Msg-Id: bad id'), Buffer.from('bad')])
        assert.throws(() => syntheticNotificationAck(value, 5), /PROBE_ACK_INVALID/);
    assert.throws(() => syntheticNotificationAck(frame('Msg-Id: a'), 0), /PROBE_ACK_INVALID/);
});
