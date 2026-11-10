'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconnectSignature, challengeResponse } = require('../../src/automation/edge-wns-auth');
const invalid = fn => assert.throws(fn, error => error.code === 'X_EDGE_WNS_AUTH_INVALID' && !String(error.stack).includes('synthetic-token-123'));
test('WNS authentication primitives match independent synthetic vectors', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i)), token = Buffer.from('synthetic-token-123'), nonce = '12345678901234567890123456789012';
    const signature = reconnectSignature(key, token, nonce);
    assert.equal(signature.toString('base64'), 'AV4gFSMXXt4XPKowFK9pixo=');
    const productKey = Buffer.from('0123456789abcdef'), productId = Buffer.from('fedcba9876543210');
    const response = challengeResponse(nonce, productKey, productId);
    assert.equal(response.toString('hex'), '8f65abd90533a1d616630f44d1d3b3c6');
    assert.equal(token.toString(), 'synthetic-token-123');
    for (const secret of [key, token, signature, productKey, productId, response]) secret.fill(0);
});
test('WNS authentication rejects malformed or oversized inputs without exposing them', () => {
    const key = Buffer.alloc(32), token = Buffer.from('synthetic-token-123'), nonce = '1'.repeat(32);
    for (const args of [[Buffer.alloc(31), token, nonce], [key, Buffer.alloc(0), nonce], [key, Buffer.alloc(4097, 65), nonce],
        [key, Buffer.from('has space'), nonce], [key, token, '1'.repeat(31)], [key, token, 'x'.repeat(32)], [key, 'string', nonce]])
        invalid(() => reconnectSignature(...args));
    for (const args of [['', Buffer.alloc(16), Buffer.alloc(16)], ['x'.repeat(257), Buffer.alloc(16), Buffer.alloc(16)],
        ['ok', Buffer.alloc(15), Buffer.alloc(16)], ['ok', Buffer.alloc(16), Buffer.alloc(17)]]) invalid(() => challengeResponse(...args));
});
