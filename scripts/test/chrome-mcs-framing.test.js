'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFrameDecoder, encodeFrame } = require('../../src/automation/chrome-mcs-framing');

test('MCS version, tags and varint lengths survive all input chunk boundaries', () => {
    for (const length of [0, 1, 127, 128, 16384]) {
        const payload = Buffer.alloc(length, 0x5a);
        const wire = Buffer.concat([encodeFrame(3, payload, { first: true }), encodeFrame(0, Buffer.alloc(0))]);
        for (const chunkSize of [1, 2, 7, 128, 65536]) {
            const decoder = createFrameDecoder(); const frames = [];
            for (let i = 0; i < wire.length; i += chunkSize) frames.push(...decoder.push(wire.subarray(i, i + chunkSize)));
            decoder.finish();
            assert.deepEqual(frames, [{ tag: 3, payload }, { tag: 0, payload: Buffer.alloc(0) }]);
        }
    }
});

test('reject unsupported version, malformed lengths, tags and truncated frames', () => {
    for (const bytes of [[40], [41, 16], [41, 3, 0x80, 0], [41, 3, 0x80, 0x80, 0x80, 0x80, 0x10], [41, 3, 0x81, 0x80, 0x04]]) {
        const decoder = createFrameDecoder();
        assert.throws(() => decoder.push(Buffer.from(bytes)), /X_CHROME_MCS_FRAME_INVALID/);
        assert.throws(() => decoder.push(Buffer.alloc(0)), /X_CHROME_MCS_FRAME_INVALID/);
    }
    for (const bytes of [[], [41, 3], [41, 3, 2, 1]]) {
        const decoder = createFrameDecoder(); decoder.push(Buffer.from(bytes));
        assert.throws(() => decoder.finish(), /X_CHROME_MCS_FRAME_INVALID/);
    }
});

test('accept Chromium legacy version and enforce outgoing limits', () => {
    const decoder = createFrameDecoder({ maxFrame: 1 });
    assert.deepEqual(decoder.push(Buffer.from([38, 1, 1, 42])), [{ tag: 1, payload: Buffer.from([42]) }]);
    decoder.finish();
    assert.throws(() => encodeFrame(1, Buffer.alloc(2), { maxFrame: 1 }), /X_CHROME_MCS_FRAME_INVALID/);
    assert.throws(() => encodeFrame(16, Buffer.alloc(0)), /X_CHROME_MCS_FRAME_INVALID/);
});
