'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { selectXRecord, clearRecord } = require('../../src/automation/edge-wns-record');
function varint(number) { const out = []; do { let byte = number % 128; number = Math.floor(number / 128); if (number) byte |= 128; out.push(byte); } while (number); return Buffer.from(out); }
function bytes(field, value) { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]); }
function metadata(scope) { return bytes(8, Buffer.concat([bytes(1, 'origin'), bytes(2, scope)])); }
function point(key) { const jwk = key.export({ format: 'jwk' }); return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]); }
function fixture(scope = 'https://x.com/') {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), app = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const expected = { endpoint: 'https://wns2-pn1p.notify.windows.com/?token=synthetic', publicKey: point(keys.publicKey), auth: randomBytes(16), applicationServerKey: point(app.publicKey) };
    const record = Buffer.concat([bytes(1, '1;synthetic-channel'), bytes(3, expected.endpoint), bytes(6, expected.auth),
        bytes(7, keys.privateKey.export({ format: 'der', type: 'pkcs8' })), metadata(scope), bytes(16, expected.applicationServerKey)]);
    return { record, expected };
}
const invalid = fn => assert.throws(fn, error => error.code === 'X_EDGE_WNS_RECORD_INVALID' && !String(error.stack).includes('synthetic-channel'));

test('selects only X and verifies subscription identity against the browser', () => {
    const target = fixture(), other = fixture('https://other.example/');
    const result = selectXRecord([Buffer.from([0]), other.record, target.record], target.expected);
    assert.equal(result.scope, 'https://x.com/'); assert.equal(result.endpoint, target.expected.endpoint);
    assert.deepEqual(result.publicKey, target.expected.publicKey); assert.deepEqual(result.auth, target.expected.auth);
    assert.deepEqual(result.applicationServerKey, target.expected.applicationServerKey); assert.equal(result.channel.toString(), '1;synthetic-channel');
    assert.equal(result.privateKey.length, 32); clearRecord(result);
    for (const key of ['channel', 'publicKey', 'auth', 'privateKey', 'applicationServerKey']) assert(result[key].every(byte => byte === 0));
    assert(target.expected.auth.some(byte => byte !== 0));
});

test('rejects mismatched or ambiguous site identity and preserves foreign isolation', () => {
    const target = fixture(), foreign = fixture('https://other.example/');
    invalid(() => selectXRecord([foreign.record], target.expected));
    invalid(() => selectXRecord([target.record, target.record], target.expected));
    invalid(() => selectXRecord([target.record], { ...target.expected, auth: randomBytes(16) }));
    invalid(() => selectXRecord([target.record], { ...target.expected, publicKey: fixture().expected.publicKey }));
    invalid(() => selectXRecord([target.record], { ...target.expected, applicationServerKey: fixture().expected.applicationServerKey }));
    invalid(() => selectXRecord([target.record], { ...target.expected, endpoint: 'https://attacker.invalid/' }));
    invalid(() => selectXRecord([target.record], { ...target.expected, endpoint: target.expected.endpoint + '#fragment' }));
    invalid(() => selectXRecord([Buffer.concat([target.record, metadata('https://x.com/')])], target.expected));
    invalid(() => selectXRecord([Buffer.concat([target.record, bytes(6, randomBytes(16))])], target.expected));
    invalid(() => selectXRecord([Buffer.concat([target.record, Buffer.from([0x80])])], target.expected));
});

test('rejects unsafe shapes, invalid curves and oversized data without inspecting accessors', () => {
    const target = fixture();
    invalid(() => selectXRecord(Array(129).fill(target.record), target.expected));
    invalid(() => selectXRecord([Buffer.alloc(65537)], target.expected));
    invalid(() => selectXRecord([target.record], { ...target.expected, publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]) }));
    invalid(() => selectXRecord([target.record], { ...target.expected, extra: 'not allowed' }));
    const accessor = { ...target.expected }; Object.defineProperty(accessor, 'auth', { enumerable: true, get() { throw new Error('getter invoked'); } });
    invalid(() => selectXRecord([target.record], accessor));
});
