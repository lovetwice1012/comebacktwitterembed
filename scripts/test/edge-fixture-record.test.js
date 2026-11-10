'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { selectSyntheticEdgeRecord, matchingSyntheticRecordFields, matchingSyntheticTextFields, rewriteSyntheticOrigin } = require('../../experiments/chrome-push/edge-fixture-record.cjs');
const { selectXRecord, clearRecord } = require('../../src/automation/edge-wns-record');
function varint(number) { const result = []; do { let part = number % 128; number = Math.floor(number / 128); if (number) part |= 128; result.push(part); } while (number); return Buffer.from(result); }
const bytes = (field, value) => { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]); };
const metadata = origin => bytes(8, Buffer.concat([bytes(1, 'origin'), bytes(2, origin)]));
test('synthetic record comparison exposes only matching field numbers', () => {
    const record = Buffer.concat([Buffer.from([8, 42]), bytes(2, '2a'), bytes(3, 'private-synthetic')]);
    assert.deepEqual(matchingSyntheticRecordFields(record, '2a'), [{ field: 1, wire: 0 }, { field: 2, wire: 2 }]);
    assert.deepEqual(matchingSyntheticRecordFields(record, 'ff'), []);
    assert.throws(() => matchingSyntheticRecordFields(record, 'not-hex'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.deepEqual(matchingSyntheticTextFields(record, 'private-synthetic'), [{ field: 3, relation: 'exact' }]);
    assert.deepEqual(matchingSyntheticTextFields(record, 'synthetic'), [{ field: 3, relation: 'contains' }]);
    assert.throws(() => matchingSyntheticTextFields(record, 'bad space'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
});
function sample(scope, override = {}) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = pair.privateKey.export({ format: 'jwk' });
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const auth = randomBytes(16), appJwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
    const app = Buffer.concat([Buffer.from([4]), Buffer.from(appJwk.x, 'base64url'), Buffer.from(appJwk.y, 'base64url')]);
    const der = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
    const endpoint = override.endpoint || 'https://wns2-pn1p.notify.windows.com/?token=synthetic';
    const record = Buffer.concat([bytes(1, override.channel || '1;123456789'), bytes(3, endpoint), bytes(6, auth), bytes(7, der), metadata(scope), bytes(16, override.appKey || app)]);
    return { record, auth, publicKey, endpoint, applicationServerKey: app };
}
test('fixture-only origin substitution preserves subscription fields for the X selector', () => {
    const scope = 'http://127.0.0.1:12345/', item = sample(scope), changed = rewriteSyntheticOrigin(item.record, scope);
    try {
        const result = selectXRecord([changed], { endpoint: item.endpoint, auth: item.auth, publicKey: item.publicKey, applicationServerKey: item.applicationServerKey });
        try { assert.deepEqual(result.publicKey, item.publicKey); assert.equal(result.scope, 'https://x.com/'); }
        finally { clearRecord(result); }
    } finally { changed.fill(0); }
    assert.throws(() => rewriteSyntheticOrigin(item.record, 'https://x.com/'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => rewriteSyntheticOrigin(Buffer.concat([item.record, metadata(scope)]), scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
});
test('synthetic Edge selector chooses the exact local site and rejects another site and duplicates', () => {
    const first = sample('http://127.0.0.1:12345/'), second = sample('http://localhost:12345/');
    const chosen = selectSyntheticEdgeRecord([Buffer.from([0]), second.record, first.record], 'http://127.0.0.1:12345/');
    assert.equal(chosen.endpoint, first.endpoint); assert.deepEqual(chosen.auth, first.auth); assert.deepEqual(chosen.publicKey, first.publicKey);
    assert.throws(() => selectSyntheticEdgeRecord([second.record], 'http://127.0.0.1:12345/'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([first.record, first.record], 'http://127.0.0.1:12345/'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([first.record], 'https://x.com/'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
});
test('synthetic Edge selector rejects ambiguous, malformed and foreign endpoints', () => {
    const scope = 'http://localhost:12345/', valid = sample(scope), badEndpoint = sample(scope, { endpoint: 'https://attacker.invalid/token' });
    assert.throws(() => selectSyntheticEdgeRecord([badEndpoint.record], scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([sample(scope, { appKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]) }).record], scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([Buffer.concat([valid.record, metadata(scope)])], scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([Buffer.concat([valid.record, bytes(6, randomBytes(16))])], scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([Buffer.concat([valid.record, bytes(1, '1;duplicate')])], scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([sample(scope, { channel: 'bad channel' }).record], scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([Buffer.concat([valid.record, Buffer.from([0x80])])], scope), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
    assert.throws(() => selectSyntheticEdgeRecord([valid.record], 'http://localhost:99999/'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
});
