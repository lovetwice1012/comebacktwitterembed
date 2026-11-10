'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mcs = require('../../src/automation/chrome-mcs-protobuf');
const { generateKeyPairSync, randomBytes } = require('node:crypto');

// Compact independent fixtures use protobuf's single-byte keys/lengths.
const field = (n, s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s); const l = b.length < 128 ? [b.length] : [(b.length & 127) | 128, b.length >> 7]; return Buffer.concat([Buffer.from([n * 8 + 2, ...l]), b]); };
const entry = (key, value) => field(7, Buffer.concat([field(1, key), field(2, value)]));

test('login serialization follows Chromium fields without losing uint64 precision', () => {
    const actual = mcs.loginRequest({ deviceId: '18446744073709551615', securityToken: '123', clientVersion: '130.0' });
    const expected = Buffer.concat([field(1, 'chrome-130.0'), field(2, 'mcs.android.com'), field(3, '18446744073709551615'),
        field(4, '18446744073709551615'), field(5, '123'), field(6, 'android-ffffffffffffffff'),
        field(8, Buffer.concat([field(1, 'new_vc'), field(2, '1')])), Buffer.from('60007001800102880101', 'hex')]);
    assert.deepEqual(actual, expected);
    for (const id of ['0', '-1', '01', '18446744073709551616', 1])
        assert.throws(() => mcs.loginRequest({ deviceId: id, securityToken: '1', clientVersion: '1' }), /X_CHROME_MCS_PROTO_INVALID/);
});

test('login error is sanitized and malformed or duplicate fields fail closed', () => {
    assert.deepEqual(mcs.loginResponse(field(1, 'ok')), { accepted: true });
    assert.deepEqual(mcs.loginResponse(Buffer.concat([field(1, 'x'), field(3, Buffer.from([8, 0]))])), { accepted: true });
    assert.deepEqual(mcs.loginResponse(Buffer.concat([field(1, 'x'), field(3, Buffer.from([8, 7]))])), { accepted: false, code: 7 });
    for (const b of [Buffer.alloc(0), Buffer.from([10, 5, 1]), Buffer.concat([field(1, 'x'), field(1, 'y')])])
        assert.throws(() => mcs.loginResponse(b), /X_CHROME_MCS_PROTO_INVALID/);
});

test('only the selected app is decoded and unrelated data is discarded', () => {
    const foreign = Buffer.concat([field(5, 'unrelated'), field(7, Buffer.from([255]))]);
    const expected = { expectedCategory: 'chrome', expectedAppId: 'selected', expectedSender: 'sender' };
    assert.deepEqual(mcs.dataMessage(foreign, expected), { matches: false });
    const spoofed = Buffer.concat([field(5, 'unrelated'), entry('subtype', 'selected')]);
    assert.deepEqual(mcs.dataMessage(spoofed, expected), { matches: false });
    const msg = Buffer.concat([field(3, 'sender'), field(5, 'chrome'), field(9, 'persist'), entry('subtype', 'selected'),
        entry('content-encoding', 'aes128gcm'), entry('ignored', 'private'), Buffer.from([0xaa, 1, 2, 1, 2])]);
    const result = mcs.dataMessage(msg, expected);
    assert.deepEqual(mcs.dataMessage(msg, { ...expected, expectedSender: 'other' }), { matches: false });
    assert.equal(result.matches, true); assert.equal(result.from, 'sender'); assert.equal(result.persistentId, 'persist');
    assert.deepEqual(result.rawData, Buffer.from([1, 2])); assert.deepEqual({ ...result.headers }, { 'content-encoding': 'aes128gcm' });
    assert.throws(() => mcs.dataMessage(Buffer.concat([msg, entry('content-encoding', 'aesgcm')]), expected), /X_CHROME_MCS_PROTO_INVALID/);
    assert.throws(() => mcs.dataMessage(Buffer.concat([msg, entry('subtype', 'another')]), expected), /X_CHROME_MCS_PROTO_INVALID/);
    assert.throws(() => mcs.dataMessage(Buffer.concat([msg, entry('message_type', 'deleted_messages')]), expected), /X_CHROME_MCS_PROTO_INVALID/);
});

test('selective acknowledgment uses MCS IQ extension 12', () => {
    assert.equal(mcs.selectiveAck(['abc']).toString('hex'), '10011a003a09080c12050a03616263');
    assert.throws(() => mcs.selectiveAck([]), /X_CHROME_MCS_PROTO_INVALID/);
});
test('encrypted payload accepts supported Web Push headers and rejects plaintext', () => {
    const raw = Buffer.from([1, 2, 3]);
    assert.deepEqual(mcs.encryptedPayload({ matches: true, rawData: raw, headers: { 'content-encoding': 'aes128gcm' } }),
        { data: raw, headers: { encoding: 'aes128gcm' } });
    assert.deepEqual(mcs.encryptedPayload({ matches: true, rawData: Buffer.alloc(0), headers: { 'content-encoding': 'aes128gcm', _googRawData: 'AQID' } }),
        { data: raw, headers: { encoding: 'aes128gcm' } });
    assert.throws(() => mcs.encryptedPayload({ matches: true, rawData: raw, headers: {} }), /X_CHROME_MCS_PROTO_INVALID/);
    assert.throws(() => mcs.encryptedPayload({ matches: true, rawData: Buffer.alloc(0), headers: { 'content-encoding': 'aes128gcm', _googRawData: '@@@' } }), /X_CHROME_MCS_PROTO_INVALID/);
});
test('MCS internal idle controls are distinct from foreign app notifications', () => {
    const control = Buffer.concat([field(5, 'com.google.android.gsf.gtalkservice'), entry('IdleNotification', 'true')]);
    assert.deepEqual(mcs.inspectControlMessage(control), { idle: true });
    assert.equal(mcs.inspectControlMessage(field(5, 'other')), null);
    const response = mcs.idleResponse(3, 0);
    assert(response.includes(Buffer.from('gcm@android.com')));
    assert(response.includes(Buffer.from('IdleNotification')));
    assert(response.includes(Buffer.from('false')));
});

test('Chrome key record is bound to the chosen app and selected subscription keys', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
    const auth = randomBytes(16), der = privateKey.export({ format: 'der', type: 'pkcs8' });
    const record = Buffer.concat([field(1, 'app'), field(3, auth), field(4, 'sender'), field(5, der)]);
    const expected = { expectedAppId: 'app', expectedPublicKey: point, expectedAuthSecret: auth };
    const result = mcs.readEncryptionData(record, expected);
    assert.equal(result.authorizedEntity, 'sender');
    assert.equal(result.privateKey.d, privateKey.export({ format: 'jwk' }).d);
    for (const bad of [{ ...expected, expectedAppId: 'other' }, { ...expected, expectedPublicKey: Buffer.alloc(65) },
        { ...expected, expectedAuthSecret: Buffer.alloc(16) }]) assert.throws(() => mcs.readEncryptionData(record, bad), /X_CHROME_MCS_PROTO_INVALID/);
    assert.throws(() => mcs.readEncryptionData(Buffer.concat([record, field(2, 'old')]), expected), /X_CHROME_MCS_PROTO_INVALID/);
});
