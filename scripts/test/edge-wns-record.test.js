'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { selectXRecord, selectDeviceRecord, hasXSiteRecord, countOtherSiteRecords, partitionStoreRecords, clearRecord } = require('../../src/automation/edge-wns-record');
const { buildEdgeTransfer, buildEdgeTransferFromStore } = require('../../src/automation/edge-wns-snapshot');
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
test('selects a bounded device token and canonical key, rejecting ambiguous records', () => {
    const secret = randomBytes(32), raw = Buffer.concat([bytes(2, 'synthetic-token'), bytes(3, secret.toString('base64'))]);
    const result = selectDeviceRecord(raw); assert.deepEqual(result.deviceKey, secret); assert.equal(result.reconnectToken.toString(), 'synthetic-token');
    result.deviceKey.fill(0); result.reconnectToken.fill(0); assert(secret.some(byte => byte !== 0));
    for (const bad of [Buffer.concat([raw, bytes(2, 'duplicate')]), Buffer.concat([raw, bytes(3, secret.toString('base64'))]),
        Buffer.concat([bytes(2, '<bad>'), bytes(3, secret.toString('base64'))]), Buffer.concat([bytes(2, 'ok'), bytes(3, 'not-base64')]),
        Buffer.concat([raw, Buffer.from([0x80])]), Buffer.alloc(65537)]) invalid(() => selectDeviceRecord(bad));
});
test('subscription presence check returns only a boolean and rejects ambiguous X records', () => {
    const x = fixture(), other = fixture('https://other.example/');
    assert.equal(hasXSiteRecord([]), false); assert.equal(hasXSiteRecord([Buffer.alloc(8), other.record]), false); assert.equal(hasXSiteRecord([other.record, x.record]), true);
    invalid(() => hasXSiteRecord([x.record, x.record])); invalid(() => hasXSiteRecord([Buffer.concat([x.record, Buffer.from([0x80])])]));
});
test('builds only the selected X transfer from matching browser records', async () => {
    const target = fixture(), other = fixture('https://other.example/'), secret = randomBytes(32);
    const deviceRecord = Buffer.concat([bytes(2, 'synthetic-token'), bytes(3, secret.toString('base64'))]);
    const input = { siteRecords: [other.record, target.record], deviceRecord, expected: target.expected, browserVersion: '157.0.0.1',
        agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
        client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' } };
    const { file, otherSubscriptionCount } = await buildEdgeTransfer(input); assert.equal(otherSubscriptionCount, 1);
    assert.equal(file.push.siteChannel, '1;synthetic-channel'); assert.equal(file.push.deviceKey, secret.toString('base64url'));
    assert.equal(file.push.p256dhPublicKey, target.expected.publicKey.toString('base64url'));
    await assert.rejects(buildEdgeTransfer({ ...input, expected: { ...input.expected, auth: randomBytes(16) } }), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' });
    await assert.rejects(buildEdgeTransfer({ ...input, siteRecords: [target.record, target.record] }), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' });
});
test('reports foreign subscription count and refuses records that cannot be classified', () => {
    const x = fixture(), other = fixture('https://other.example/');
    assert.equal(countOtherSiteRecords([x.record]), 0); assert.equal(countOtherSiteRecords([other.record, x.record, other.record]), 2);
    for (const records of [[], [other.record], [x.record, x.record], [x.record, Buffer.from([0])],
        [x.record, Buffer.concat([other.record, metadata('https://other.example/')])]]) invalid(() => countOtherSiteRecords(records));
});
test('whole-store export reports confirmed and uncertain foreign records without exposing their contents', async () => {
    const x = fixture(), other = fixture('https://other.example/'), device = Buffer.concat([bytes(2, 'synthetic-token'), bytes(3, randomBytes(32).toString('base64'))]);
    const input = { records: [device, other.record, x.record, Buffer.alloc(8)], expected: x.expected, browserVersion: '157.0.0.1',
        agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
        client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' } };
    const result = await buildEdgeTransferFromStore(input);
    assert.equal(result.otherSubscriptionCount, 1); assert.equal(result.unclassifiedRecordCount, 1); assert.equal(result.otherNotificationsPossible, true);
    assert(!JSON.stringify(result).includes('other.example'));
    const clean = await buildEdgeTransferFromStore({ ...input, records: [device, x.record] });
    assert.equal(clean.unclassifiedRecordCount, 0); assert.equal(clean.otherNotificationsPossible, false);
    const uncertain = await buildEdgeTransferFromStore({ ...input, records: [device, x.record, Buffer.alloc(8)] });
    assert.equal(uncertain.otherSubscriptionCount, 0); assert.equal(uncertain.otherNotificationsPossible, true);
    invalid(() => partitionStoreRecords([device, device, x.record]));
    invalid(() => partitionStoreRecords([device, x.record, Buffer.concat([Buffer.from('https://x.com/'), Buffer.from([0x80])])]));
    await assert.rejects(buildEdgeTransferFromStore({ ...input, records: [device, x.record, x.record] }), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' });
});
