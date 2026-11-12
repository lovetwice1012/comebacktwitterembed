'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBindResponse } = require('../../src/automation/edge-wns-bind');
function frame(xml, command = 'BND 3 CON', headers = 'MS-CV: synthetic') {
    const payload = Buffer.from(`${headers}\r\n\r\n${xml}`, 'ascii');
    return Buffer.concat([Buffer.from(`${command} ${payload.length}\r\n`, 'ascii'), payload]);
}
const valid = '<response><ver>1.0</ver><nonce>synthetic-nonce</nonce><reconnect-token>synthetic-token</reconnect-token></response>';
const invalid = fn => assert.throws(fn, error => error.code === 'X_EDGE_WNS_BIND_INVALID' && !String(error.stack).includes('synthetic-token'));
test('parses an authenticated bind envelope and returns caller-owned token bytes', () => {
    const source = frame(valid), original = Buffer.from(source), result = parseBindResponse(source, 3);
    assert.equal(result.version, '1.0'); assert.equal(result.nonce, 'synthetic-nonce'); assert.equal(result.reconnectToken.toString(), 'synthetic-token');
    result.reconnectToken.fill(0); assert.deepEqual(source, original);
});
test('rejects malformed, ambiguous or unsafe bind responses without exposing tokens', () => {
    for (const xml of [
        valid.replace('<nonce>synthetic-nonce</nonce>', ''),
        valid.replace('</response>', '<nonce>other</nonce></response>'),
        valid.replace('<nonce>', '<nonce attr="x">'),
        valid.replace('<nonce>synthetic-nonce</nonce>', '<wrapper><nonce>synthetic-nonce</nonce></wrapper>'),
        valid.replace('synthetic-token', 'synthetic&amp;token'),
        '<!DOCTYPE response>'+valid, '<?xml version="1.0"?>'+valid,
        valid.replace('</response>', '</other>'), valid.replace('synthetic-token', 'x'.repeat(4097)),
    ]) invalid(() => parseBindResponse(frame(xml), 3));
    invalid(() => parseBindResponse(frame(valid, 'BND 4 CON'), 3));
    invalid(() => parseBindResponse(frame(valid, 'BND 3 CON', 'Bad\nHeader: x'), 3));
    const source = frame(valid); invalid(() => parseBindResponse(source.subarray(0, -1), 3));
    invalid(() => parseBindResponse(source, 0));
});
