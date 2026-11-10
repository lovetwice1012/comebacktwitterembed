'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { syntheticReconnectSignature } = require('../../experiments/chrome-push/edge-fixture-signature.cjs');
const { rewriteSyntheticBind, createSyntheticRewriteStream } = require('../../experiments/chrome-push/edge-fixture-rewrite.cjs');
const key = Buffer.alloc(32, 7), token = 'synthetic-token', oldNonce = '1'.repeat(32), newNonce = '2'.repeat(32);
function frame() {
    const signature = syntheticReconnectSignature(key, token, oldNonce).toString('base64');
    const body = `<wns><reconnect-token>${token}</reconnect-token><nonce>${oldNonce}</nonce><signature>${signature}</signature></wns>`;
    return Buffer.from(`BND 1 CON\\WNS 42 ${Buffer.byteLength(body)}\r\n${body}`);
}
test('synthetic bind replacement preserves frame size and validates original signature', () => {
    const before = frame(), after = rewriteSyntheticBind(before, key, token, newNonce);
    assert.equal(after.length, before.length);
    assert(after.includes(Buffer.from(`<nonce>${newNonce}</nonce>`)));
    assert(after.includes(Buffer.from(syntheticReconnectSignature(key, token, newNonce).toString('base64'))));
    assert.throws(() => rewriteSyntheticBind(before, key, 'wrong-token', newNonce), /PROBE_REWRITE_INVALID/);
    assert.throws(() => rewriteSyntheticBind(before, Buffer.alloc(32, 9), token, newNonce), /PROBE_REWRITE_INVALID/);
    assert.throws(() => rewriteSyntheticBind(before, key, token, oldNonce), /PROBE_REWRITE_INVALID/);
});
test('synthetic relay preserves arbitrary frame splits and reports exactly one replacement', async () => {
    const before = frame(), expected = rewriteSyntheticBind(before, key, token, newNonce);
    for (let split = 0; split <= before.length; split++) {
        let rewrites = 0; const output = [];
        const stream = createSyntheticRewriteStream({ key: Buffer.from(key), token, nonce: newNonce, onRewrite: () => { rewrites++; } });
        stream.on('data', chunk => output.push(chunk));
        stream.write(before.subarray(0, split)); stream.end(before.subarray(split)); await once(stream, 'end');
        assert.deepEqual(Buffer.concat(output), expected); assert.equal(rewrites, 1);
    }
});
