'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syntheticChallengeResponse, rewriteSyntheticChallenge } = require('../../experiments/chrome-push/edge-fixture-challenge.cjs');

test('synthetic challenge matches an independently calculated vector', () => {
    const key = Buffer.from('0123456789abcdef'), id = Buffer.from('fedcba9876543210');
    const result = syntheticChallengeResponse('12345678901234567890123456789012', key, id);
    assert.equal(result.toString('hex'), '8f65abd90533a1d616630f44d1d3b3c6');
    result.fill(0); key.fill(0); id.fill(0);
});
test('synthetic challenge rejects unsupported input', () => {
    const key = Buffer.alloc(16, 65), id = Buffer.alloc(16, 66);
    for (const [challenge, productKey, productId] of [['', key, id], ['x'.repeat(257), key, id], ['bad space', key, id],
        ['ok', Buffer.alloc(15), id], ['ok', key, Buffer.alloc(17)]])
        assert.throws(() => syntheticChallengeResponse(challenge, productKey, productId), /PROBE_CHALLENGE_INPUT_INVALID/);
    key.fill(0); id.fill(0);
});
test('synthetic challenge frame is rewritten without changing its size or allowing another application', () => {
    const key = Buffer.from('0123456789abcdef'), id = Buffer.from('fedcba9876543210');
    const body = '<challenge><appId>fedcba9876543210</appId><response>00000000000000000000000000000000</response></challenge>';
    const frame = Buffer.from(`PUT 4 WNS\\CHALLENGE 123 ${body.length}\r\n${body}`);
    const result = rewriteSyntheticChallenge(frame, '12345678901234567890123456789012', key, id);
    assert.equal(result.length, frame.length); assert(result.includes(Buffer.from('8f65abd90533a1d616630f44d1d3b3c6')));
    assert.throws(() => rewriteSyntheticChallenge(frame, 'synthetic', key, Buffer.alloc(16)), /PROBE_CHALLENGE_FRAME_INVALID/);
    result.fill(0); key.fill(0); id.fill(0);
});
