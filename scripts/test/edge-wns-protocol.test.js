'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrameDecoder } = require('../../src/automation/edge-wns-framing');
const { createNonce, connectFrame, deviceFrame, bindFrame, challengeFrame } = require('../../src/automation/edge-wns-protocol');
const invalid = fn => assert.throws(fn, error => error.code === 'X_EDGE_WNS_PROTOCOL_INVALID' && !String(error.stack).includes('synthetic-token-123'));
const metadata = () => ({ channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic client', clientVersion: '1.2.3.4',
    nonce: '12345678901234567890123456789012', reconnectToken: Buffer.from('synthetic-token-123'), deviceKey: Buffer.from(Array.from({ length: 32 }, (_, i) => i)) });
test('builds bounded synthetic WNS requests with caller-supplied metadata and verified signatures', () => {
    const input = metadata(), productKey = Buffer.from('0123456789abcdef'), productId = Buffer.from('fedcba9876543210');
    const frames = [connectFrame({ os: 'Test OS', osVersion: '1.0', architecture: 'x64', locale: 'en' }, 1), deviceFrame(2), bindFrame(input, 3),
        challengeFrame({ channel: 'abc', serverNonce: input.nonce, productKey, productId }, 4)];
    try {
        const decoder = createFrameDecoder(); assert.deepEqual(decoder.push(Buffer.concat(frames)), frames); decoder.finish();
        const bind = frames[2].toString('ascii'); assert.match(bind, /^BND 3 CON\\WNS abc /);
        assert(bind.includes('<signature>AV4gFSMXXt4XPKowFK9pixo=</signature>'));
        assert(bind.includes('<reconnect-token>synthetic-token-123</reconnect-token>'));
        const challenge = frames[3].toString('ascii'); assert.match(challenge, /^PUT 4 WNS\\CHALLENGE abc /);
        assert(challenge.includes('<response>8f65abd90533a1d616630f44d1d3b3c6</response>'));
        assert.match(createNonce(), /^[1-9]\d{31}$/);
    } finally { for (const value of [...frames, input.deviceKey, input.reconnectToken, productKey, productId]) value.fill(0); }
});
test('rejects injection, missing metadata, weak keys and invalid sequence numbers', () => {
    const input = metadata();
    for (const bad of [{ ...input, channel: 'bad path' }, { ...input, protocolVersion: 'bad<xml' }, { ...input, clientName: 'x&y' },
        { ...input, reconnectToken: Buffer.from('bad<token') }, { ...input, deviceKey: Buffer.alloc(31) }, { ...input, extra: 1 }]) invalid(() => bindFrame(bad, 3));
    const getter = { ...input }; Object.defineProperty(getter, 'clientName', { enumerable: true, get() { throw new Error('getter invoked'); } });
    invalid(() => bindFrame(getter, 3)); invalid(() => bindFrame(input, 0));
    invalid(() => connectFrame({ os: 'bad\nheader', osVersion: '1', architecture: 'x64', locale: 'en' }, 1));
    invalid(() => challengeFrame({ channel: 'abc', serverNonce: 'x', productKey: Buffer.alloc(16), productId: Buffer.alloc(16, 0xc1) }, 4));
    invalid(() => challengeFrame({ channel: 'abc', serverNonce: 'x', productKey: Buffer.alloc(15), productId: Buffer.alloc(16, 65) }, 4));
    input.reconnectToken.fill(0); input.deviceKey.fill(0);
});
