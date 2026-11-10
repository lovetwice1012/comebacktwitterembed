'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNotification, createAcknowledgement } = require('../../src/automation/edge-wns-notification');
const { syntheticRecipientMatches } = require('../../experiments/chrome-push/edge-fixture-routing.cjs');
const expected = Buffer.from('site-channel');
function frame(headers, data = Buffer.from('synthetic-ciphertext')) {
    const body = Buffer.concat([Buffer.from(headers + '\r\n\r\n', 'ascii'), data]);
    return Buffer.concat([Buffer.from(`NFY 9 WNS\\NOTIF abcd ${body.length}\r\n`, 'ascii'), body]);
}
const invalid = fn => assert.throws(fn, { code: 'X_EDGE_WNS_NOTIFICATION_INVALID' });

test('selects a matching target and builds the observed ACK shape without changing the input', () => {
    const input = frame('Channel: site-channel\r\nMsg-Id: synthetic-id\r\nContent-Encoding: aes128gcm');
    const original = Buffer.from(input), result = parseNotification(input, expected);
    assert.equal(result.kind, 'target'); assert.deepEqual(result.data, Buffer.from('synthetic-ciphertext'));
    assert.deepEqual(result.headers, { encoding: 'aes128gcm' }); assert.equal(syntheticRecipientMatches(input, expected), true);
    const ack = createAcknowledgement(result.acknowledgement, 4), text = ack.toString('ascii');
    assert.match(text, /^ACK 4 WNS\\NOTIF abcd \d+\r\nMS-CV: [A-Za-z0-9+/]+=*\.0\r\nMsg-Id: synthetic-id\r\n\r\n$/);
    assert.equal(Number(text.slice(0, text.indexOf('\r\n')).split(' ').at(-1)), ack.length - text.indexOf('\r\n') - 2);
    result.data.fill(0); assert.deepEqual(input, original);
});

test('returns no foreign payload or channel and permits its independent acknowledgement', () => {
    const foreign = frame('Channel: other-site\r\nMsg-Id: other-id\r\nContent-Encoding: unsupported', Buffer.from('FOREIGN-SENTINEL'));
    const result = parseNotification(foreign, expected);
    assert.deepEqual(result, { kind: 'foreign', acknowledgement: { providerChannel: 'abcd', messageId: 'other-id' } });
    assert(!JSON.stringify(result).includes('FOREIGN-SENTINEL')); assert(!JSON.stringify(result).includes('other-site'));
    assert.match(createAcknowledgement(result.acknowledgement, 1).toString('ascii'), /^ACK 1 WNS\\NOTIF abcd /);
});

test('handles a notification whose command omits the provider channel', () => {
    const five = frame('Channel: site-channel\r\nMsg-Id: synthetic-id\r\nContent-Encoding: aes128gcm');
    const four = Buffer.from(five.toString('latin1').replace('WNS\\NOTIF abcd ', 'WNS\\NOTIF '), 'latin1');
    const result = parseNotification(four, expected);
    assert.equal(result.kind, 'target'); assert.equal(result.acknowledgement.providerChannel, null);
    assert.match(createAcknowledgement(result.acknowledgement, 8).toString('ascii'), /^ACK 8 WNS\\NOTIF \d+\r\n/);
});

test('fails closed on malformed or ambiguous routing, identifiers and target encoding', () => {
    for (const headers of [
        'Msg-Id: x\r\nContent-Encoding: aes128gcm', 'Channel: site-channel\r\nContent-Encoding: aes128gcm',
        'Channel: site-channel\r\nChannel: other\r\nMsg-Id: x\r\nContent-Encoding: aes128gcm',
        'Channel: site-channel\r\nMsg-Id: x\r\nMsg-Id: y\r\nContent-Encoding: aes128gcm',
        'Channel: site-channel\r\nMsg-Id: x\r\nContent-Encoding: aesgcm',
        'Channel: site-channel\r\nMsg-Id: x\r\nContent-Encoding: aes128gcm\r\nContent-Encoding: aes128gcm',
        'Channel: site-channel\r\nMsg-Id: with space\r\nContent-Encoding: aes128gcm',
        'Channel: site-channel\r\nMsg-Id: x\nInjected: y\r\nContent-Encoding: aes128gcm',
    ]) invalid(() => parseNotification(frame(headers), expected));
    const good = frame('Channel: site-channel\r\nMsg-Id: x\r\nContent-Encoding: aes128gcm');
    invalid(() => parseNotification(good.subarray(0, good.length - 1), expected));
    invalid(() => parseNotification(good, Buffer.alloc(0)));
    invalid(() => parseNotification(frame('Channel: site-channel\r\nMsg-Id: x\r\nContent-Encoding: aes128gcm', Buffer.alloc(0)), expected));
    for (const input of [{ providerChannel: 'x!', messageId: 'x' }, { providerChannel: 'abcd', messageId: 'bad\r\nheader' },
        { providerChannel: 'abcd', messageId: 'x', extra: 1 }, Object.defineProperty({ providerChannel: 'abcd' }, 'messageId', { enumerable: true, get() { throw new Error('getter invoked'); } })])
        invalid(() => createAcknowledgement(input, 1));
    for (const sequence of [0, -1, 1.2, 1000001]) invalid(() => createAcknowledgement({ providerChannel: 'abcd', messageId: 'x' }, sequence));
});
