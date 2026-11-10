'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { firstFixtureNotification } = require('../../experiments/chrome-push/edge-wns-fixture-framing.cjs');
const frame = (prefix, body) => Buffer.concat([Buffer.from(`${prefix} ${body.length}\r\n`), body]);
const notification = (body, headers = 'Content-Encoding: aes128gcm\r\nX-Test: synthetic\r\n\r\n') =>
    frame('NFY 1 WNS\\NOTIF 1', Buffer.concat([Buffer.from(headers), body]));

test('research capture separates an encrypted body across arbitrary chunks and preceding frames', () => {
    const body = Buffer.from([0, 255, 13, 10, 0, 1]);
    const bytes = Buffer.concat([frame('CNT 1 CON', Buffer.from('test')), notification(body)]);
    for (let i = 1; i < bytes.length; i++) assert.deepEqual(firstFixtureNotification([bytes.subarray(0, i), bytes.subarray(i)]), body);
    assert.equal(bytes.at(-1), 1, 'input chunks must not be wiped or modified');
});

test('research capture rejects incomplete, oversized, ambiguous or different encoding frames', () => {
    const good = notification(Buffer.from('synthetic'));
    for (const candidate of [good.subarray(0, good.length - 1), Buffer.from('NFY 1 WNS\\NOTIF 1 999999\r\n'),
        notification(Buffer.from('x'), 'Content-Encoding: aesgcm\r\n\r\n'),
        notification(Buffer.from('x'), 'Content-Encoding: aes128gcm\r\nContent-Encoding: aes128gcm\r\n\r\n'),
        frame('NFY 1 WNS\\NOTIF 1', Buffer.from('Content-Encoding: aes128gcm\r\n'))])
        assert.equal(firstFixtureNotification([candidate]), null);
    assert.equal(firstFixtureNotification([Buffer.alloc(262145)]), null);
    assert.equal(firstFixtureNotification(['not a buffer']), null);
    const invalidHeader = Buffer.from(good); invalidHeader[0] |= 0x80;
    assert.equal(firstFixtureNotification([invalidHeader]), null);
});
