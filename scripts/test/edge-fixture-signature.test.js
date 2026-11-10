'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syntheticReconnectSignature } = require('../../experiments/chrome-push/edge-fixture-signature.cjs');

test('synthetic reconnect signature matches an independently calculated vector', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const result = syntheticReconnectSignature(key, 'synthetic-token-123', '12345678901234567890123456789012');
    assert.equal(result.toString('base64'), 'AV4gFSMXXt4XPKowFK9pixo=');
    assert.equal(result.length, 17); assert.equal(result[0], 1);
    result.fill(0); key.fill(0);
});
test('synthetic reconnect signature rejects missing, malformed and oversized inputs', () => {
    const key = Buffer.alloc(32), token = 'synthetic', nonce = '1'.repeat(32);
    for (const args of [[Buffer.alloc(31), token, nonce], [key, '', nonce], [key, 'x'.repeat(4097), nonce],
        [key, 'has space', nonce], [key, token, '1'.repeat(31)], [key, token, 'a'.repeat(32)]])
        assert.throws(() => syntheticReconnectSignature(...args), /PROBE_SIGNATURE_INPUT_INVALID/);
    key.fill(0);
});
