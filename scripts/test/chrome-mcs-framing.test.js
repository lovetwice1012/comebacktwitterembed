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
test('decoder can return only complete bounded frames before a malformed suffix', () => {
    const wire = Buffer.concat([encodeFrame(3, Buffer.from('first'), { first: true }), encodeFrame(8, Buffer.from('second')), Buffer.from([255])]);
    const decoder = createFrameDecoder({ captureCompleteOnError: true });
    assert.throws(() => decoder.push(wire), /X_CHROME_MCS_FRAME_INVALID/);
    const completed = decoder.takeCompletedOnError();
    assert.deepEqual(completed.map(frame => frame.payload.toString()), ['first', 'second']);
    assert.deepEqual(decoder.takeCompletedOnError(), []); completed.forEach(frame => frame.payload.fill(0));
    const ordinary = createFrameDecoder(); assert.throws(() => ordinary.push(wire));
    assert.deepEqual(ordinary.takeCompletedOnError(), []);
    const bounded = createFrameDecoder({ captureCompleteOnError: true });
    const many = Buffer.concat([Buffer.from([41]), ...Array.from({ length: 1025 }, () => encodeFrame(1, Buffer.alloc(0)))]);
    assert.throws(() => bounded.push(many));
    assert.equal(bounded.takeCompletedOnError().length, 1024);
});
test('malformed-suffix recovery preserves complete frames across fragmentation boundaries', () => {
    const wire = Buffer.concat([encodeFrame(3, Buffer.from('login'), { first: true }), encodeFrame(8, Buffer.from('owned')),
        encodeFrame(8, Buffer.from('next')), Buffer.from([255])]);
    for (const chunkSize of [1, 2, 3, 5, 7, wire.length]) {
        const decoder = createFrameDecoder({ captureCompleteOnError: true }), frames = []; let rejected = false;
        for (let offset = 0; offset < wire.length; offset += chunkSize) {
            try { frames.push(...decoder.push(wire.subarray(offset, offset + chunkSize))); }
            catch { frames.push(...decoder.takeCompletedOnError()); rejected = true; break; }
        }
        assert.equal(rejected, true); assert.deepEqual(frames.map(frame => frame.payload.toString()), ['login', 'owned', 'next']);
        frames.forEach(frame => frame.payload.fill(0));
    }
});
