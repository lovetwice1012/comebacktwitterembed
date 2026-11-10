'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syntheticRecipientMatches, syntheticRecipientProof, syntheticChannelStability, compareSyntheticRouting } = require('../../experiments/chrome-push/edge-fixture-routing.cjs');
const bytes = (field, value) => Buffer.concat([Buffer.from([field * 8 + 2, value.length]), Buffer.from(value)]);
const frame = (channel, context, message, cipher) => {
    const payload = Buffer.concat([Buffer.from(`Context: ${context}\r\nMsg-Id: ${message}\r\nContent-Encoding: aes128gcm\r\n\r\n`), cipher]);
    return Buffer.concat([Buffer.from(`NFY 1 WNS\\NOTIF ${channel} ${payload.length}\r\n`), payload]);
};
test('two synthetic notifications report only structural site relationships', () => {
    const first = Buffer.from('first-cipher'), second = Buffer.from('second-cipher');
    const data = Buffer.concat([frame('123', 'aaaa', 'one', first), frame('456', 'bbbb', 'two', second)]);
    const a = Buffer.concat([bytes(1, 'aaaa'), bytes(2, '123')]);
    const b = Buffer.concat([bytes(1, 'bbbb'), bytes(2, '456')]);
    const result = compareSyntheticRouting([data.subarray(0, 15), data.subarray(15)], first, second, a, b);
    assert.equal(result.channelEqual, false); assert.deepEqual(result.firstChannelMatchesFields, [{ field: 2, wire: 2 }]);
    assert.deepEqual(result.secondChannelMatchesFields, [{ field: 2, wire: 2 }]);
    assert.deepEqual(result.headerNamesMatchingOwnRecords, ['context']); assert.deepEqual(result.headerNamesMatchingOtherRecords, []);
    assert.equal(JSON.stringify(result).includes('aaaa'), false); assert.equal(JSON.stringify(result).includes('first-cipher'), false);
    assert.throws(() => compareSyntheticRouting([data], first, first, a, b), /PROBE_ROUTING_INVALID/);
    assert.throws(() => compareSyntheticRouting([data.subarray(0, -1)], first, second, a, b), /PROBE_ROUTING_INVALID/);
});
test('recipient selection rejects other sites before any decryption', () => {
    const make = headers => {
        const payload = Buffer.from(`${headers}\r\n\r\nopaque-synthetic-ciphertext`);
        return Buffer.concat([Buffer.from(`NFY 1 WNS\\NOTIF A1 ${payload.length}\r\n`), payload]);
    };
    const expected = Buffer.from('1;synthetic-first'); let decryptCalls = 0;
    const receive = frame => { if (syntheticRecipientMatches(frame, expected)) decryptCalls++; };
    receive(make('Channel: 1;synthetic-second')); assert.equal(decryptCalls, 0);
    receive(make('Channel: 1;synthetic-first')); assert.equal(decryptCalls, 1);
    const nonAscii = make('Channel: 1;synthetic-first'); nonAscii[nonAscii.indexOf(Buffer.from('1;synthetic-first'))] |= 0x80;
    for (const invalid of [make('Content-Encoding: aes128gcm'), make('Channel: 1;synthetic-first\r\nChannel: 1;synthetic-second'),
        make('Channel: 1;synthetic-first\r\nChannel: '), make('Channel: 1;synthetic-first\r\nmalformed'), nonAscii,
        make('Channel: bad value'), make('Channel: 1;synthetic-first').subarray(0, -1)])
        assert.throws(() => syntheticRecipientMatches(invalid, expected), /PROBE_ROUTING_INVALID/);
    expected.fill(0);
});
test('synthetic two-site proof maps channel headers without inspecting payloads', () => {
    const first = Buffer.from('cipher-a'), other = Buffer.from('cipher-b'), expected = Buffer.from('1;target');
    const make = (channel, ciphertext) => {
        const payload = Buffer.concat([Buffer.from(`Channel: ${channel}\r\n\r\n`), ciphertext]);
        return Buffer.concat([Buffer.from(`NFY 1 WNS\\NOTIF A1 ${payload.length}\r\n`), payload]);
    };
    const data = Buffer.concat([make('1;target', first), make('1;other', other)]);
    assert.deepEqual(syntheticRecipientProof([data], first, other, expected), { targetAccepted: true, otherAccepted: false });
    expected.fill(0);
});
test('synthetic channel comparison detects stable site identities across messages', () => {
    const values = ['a', 'b', 'c', 'd'].map(value => Buffer.from(`cipher-${value}`));
    const make = (channel, ciphertext) => {
        const payload = Buffer.concat([Buffer.from(`Channel: ${channel}\r\n\r\n`), ciphertext]);
        return Buffer.concat([Buffer.from(`NFY 1 WNS\\NOTIF A1 ${payload.length}\r\n`), payload]);
    };
    const data = Buffer.concat([make('1;target', values[0]), make('1;target', values[1]), make('1;other', values[2]), make('1;other', values[3])]);
    assert.deepEqual(syntheticChannelStability([data], ...values), { targetChannelStable: true, otherChannelStable: true, sitesHaveDistinctChannels: true });
    assert.throws(() => syntheticChannelStability([data], values[0], values[0], values[2], values[3]), /PROBE_ROUTING_INVALID/);
});
