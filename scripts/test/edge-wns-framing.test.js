'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrameDecoder, MAX_HEADER, MAX_PAYLOAD, MAX_CHUNK } = require('../../src/automation/edge-wns-framing');
const { firstFixtureNotification } = require('../../experiments/chrome-push/edge-wns-fixture-framing.cjs');
const { syntheticRecipientMatches } = require('../../experiments/chrome-push/edge-fixture-routing.cjs');
const wire = (line, payload) => Buffer.concat([Buffer.from(`${line} ${payload.length}\r\n`, 'ascii'), payload]);
const invalid = action => assert.throws(action, { code: 'X_EDGE_WNS_FRAME_INVALID' });

test('reassembles fragmented WNS notifications and remains compatible with existing routing research', () => {
    const body = Buffer.concat([Buffer.from('Channel: local-test\r\nContent-Encoding: aes128gcm\r\n\r\n'), Buffer.from([0, 255, 13, 10, 9])]);
    const frame = wire('NFY 9 WNS\\NOTIF 4a', body);
    for (let split = 0; split <= frame.length; split++) {
        const decoder = createFrameDecoder(), received = [...decoder.push(frame.subarray(0, split)), ...decoder.push(frame.subarray(split))];
        decoder.finish(); assert.deepEqual(received, [frame]);
        assert.equal(syntheticRecipientMatches(received[0], Buffer.from('local-test')), true);
        assert.deepEqual(firstFixtureNotification(received), Buffer.from([0, 255, 13, 10, 9]));
    }
    const decoder = createFrameDecoder(), received = [];
    for (const byte of frame) received.push(...decoder.push(Buffer.from([byte])));
    decoder.finish(); assert.deepEqual(received, [frame]);
});

test('handles adjacent frames, zero payload, maximum boundaries and input ownership', () => {
    const a = wire('CNT 1 CON', Buffer.alloc(0)), b = wire('BND 3 CON', Buffer.from('body'));
    const together = Buffer.concat([a, b]), original = Buffer.from(together), decoder = createFrameDecoder();
    const frames = decoder.push(together); decoder.finish(); assert.deepEqual(frames, [a, b]);
    frames[0].fill(0); assert.deepEqual(together, original);
    const maximumHeader = `N ${'A'.repeat(MAX_HEADER - 4)} 0\r\n`;
    assert.equal(Buffer.byteLength(maximumHeader), MAX_HEADER + 2);
    const headerDecoder = createFrameDecoder(); assert.equal(headerDecoder.push(Buffer.from(maximumHeader)).length, 1); headerDecoder.finish();
    const huge = wire('NFY 1 WNS\\NOTIF 1', Buffer.alloc(MAX_PAYLOAD, 7)), big = createFrameDecoder();
    assert.deepEqual([...big.push(huge.subarray(0, 1000)), ...big.push(huge.subarray(1000))], [huge]); big.finish();
});

test('rejects malformed, oversized or incomplete streams and remains failed afterward', () => {
    const bad = ['\n', '\rX', 'X\r\n', 'X  -1\r\n', 'X 1000000\r\n', 'X 1\n', 'X \u0001 0\r\n', `${'A'.repeat(MAX_HEADER + 1)}\r\n`];
    for (const value of bad) {
        const decoder = createFrameDecoder(); invalid(() => decoder.push(Buffer.from(value))); invalid(() => decoder.push(wire('X', Buffer.alloc(0))));
    }
    for (const value of [Buffer.from('X'), Buffer.from('X 1\r'), Buffer.from('X 2\r\na')]) {
        const decoder = createFrameDecoder(); decoder.push(value); invalid(() => decoder.finish()); invalid(() => decoder.push(Buffer.alloc(0)));
    }
    const limited = createFrameDecoder({ maxPayload: 1 }); invalid(() => limited.push(Buffer.from('X 2\r\n')));
    const large = createFrameDecoder(); invalid(() => large.push(Buffer.alloc(MAX_CHUNK + 1)));
    const tooMany = createFrameDecoder(); invalid(() => tooMany.push(Buffer.from('X 0\r\n'.repeat(1025))));
    const invalidType = createFrameDecoder(); invalidType.push(Buffer.from('X ')); invalid(() => invalidType.push('0')); invalid(() => invalidType.finish());
    for (const value of [-1, MAX_PAYLOAD + 1, 1.5, '1']) invalid(() => createFrameDecoder({ maxPayload: value }));
    const finished = createFrameDecoder(); finished.finish(); invalid(() => finished.push(Buffer.alloc(0))); invalid(() => finished.finish());
});
