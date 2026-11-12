'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { encodeRequest, decodeResponse, checkin } = require('../../src/automation/chrome-checkin');
const identity = { deviceId: '18446744073709551615', securityToken: '9223372036854775810', browserVersion: '131.0.6778.85' };
const enc = n => { n = BigInt(n); const b = []; do { let v = Number(n & 127n); n >>= 7n; if (n) v |= 128; b.push(v); } while (n); return Buffer.from(b); };
const num = (f, n) => Buffer.concat([enc(f * 8), enc(n)]);
const bin = (f, b) => { b = Buffer.from(b); return Buffer.concat([enc(f * 8 + 2), enc(b.length), b]); };
const fixed = (f, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return Buffer.concat([enc(f * 8 + 1), b]); };
function response(...extra) { return Buffer.concat([num(1, 1), fixed(7, identity.deviceId), fixed(8, identity.securityToken), ...extra]); }
function setting(name, value) { return bin(5, Buffer.concat([bin(1, name), bin(2, value)])); }
test('check-in matches Chromium wire fields including full uint64 device ID and fixed64 token', () => {
    const build = Buffer.concat([num(1, 1), bin(2, identity.browserVersion), num(3, 1)]);
    const expected = Buffer.concat([num(2, identity.deviceId), bin(4, Buffer.concat([num(12, 3), bin(13, build)])),
        fixed(13, identity.securityToken), num(14, 3), num(22, 0)]);
    assert.deepEqual(encodeRequest(identity), expected);
    assert.throws(() => encodeRequest({ ...identity, deviceId: '0' }));
    assert.throws(() => encodeRequest({ ...identity, browserVersion: 'evil\nheader' }));
});
test('Mac check-in uses the source browser platform and leaves Windows encoding unchanged', () => {
    const build = Buffer.concat([num(1, 2), bin(2, identity.browserVersion), num(3, 1)]);
    const expected = Buffer.concat([num(2, identity.deviceId), bin(4, Buffer.concat([num(12, 3), bin(13, build)])),
        fixed(13, identity.securityToken), num(14, 3), num(22, 0)]);
    assert.deepEqual(encodeRequest({ ...identity, platform: 'macos' }), expected);
    assert.deepEqual(encodeRequest({ ...identity, platform: 'windows' }), encodeRequest(identity));
    for (const platform of ['linux', '', null, 2]) assert.throws(() => encodeRequest({ ...identity, platform }), { code: 'X_PUSH_CHECKIN_INVALID' });
});
test('check-in applies full and incremental settings, minimum interval and deletions', () => {
    assert.equal(decodeResponse(response(num(9, 0), setting('checkin_interval', '120')), identity).intervalSeconds, 43200);
    assert.equal(decodeResponse(response(num(9, 1)), identity, 100000).intervalSeconds, 100000);
    assert.equal(decodeResponse(response(num(9, 1), setting('delete_checkin_interval', '')), identity, 100000).intervalSeconds, 172800);
    assert.equal(decodeResponse(response(num(9, 1), bin(10, 'checkin_interval')), identity, 100000).intervalSeconds, 100000);
    assert.equal(decodeResponse(response(setting('checkin_interval', '50000')), identity, 100000).intervalSeconds, 100000);
    assert.equal(decodeResponse(response(num(9, 1), setting('checkin_interval', '50000'), setting('delete_checkin_interval', '')), identity, 100000).intervalSeconds, 172800);
    assert.equal(decodeResponse(response(num(9, 1), setting('delete_checkin_interval', ''), setting('checkin_interval', '50000')), identity, 100000).intervalSeconds, 50000);
    assert.equal(decodeResponse(response(num(9, 1), setting('checkin_interval', '-1')), identity).intervalSeconds, 43200);
    assert.equal(decodeResponse(response(num(9, 1), setting('checkin_interval', '999999999')), identity).intervalSeconds, 999999999);
    assert.equal(decodeResponse(response(num(9, 0)), identity, 100000).intervalSeconds, 172800);
    assert.throws(() => decodeResponse(response(num(9, 0), setting('checkin_interval', '4294967296')), identity));
    assert.throws(() => decodeResponse(response(num(9, 1), setting('checkin_url', 'https://example.com/')), identity), { code: 'X_PUSH_CHECKIN_CONFIG_CHANGED' });
    assert.throws(() => decodeResponse(response(num(9, 1), setting('gcm_hostname', 'example.com')), identity), { code: 'X_PUSH_CHECKIN_CONFIG_CHANGED' });
    assert.equal(decodeResponse(response(num(9, 1), setting('gcm_hostname', 'mtalk.google.com'), setting('gcm_secure_port', '5228')), identity).intervalSeconds, 172800);
    assert.equal(decodeResponse(response(num(9, 1), setting('checkin_url', 'https://example.com/'), setting('delete_checkin_url', '')), identity).intervalSeconds, 172800);
    assert.throws(() => decodeResponse(Buffer.concat([response(), fixed(7, 1)]), identity));
    assert.throws(() => decodeResponse(Buffer.from([0x3b]), identity));
    assert.throws(() => decodeResponse(response(), { ...identity, deviceId: '1' }), { code: 'X_PUSH_CHECKIN_ID_CHANGED' });
});
function fakeRequest(status, body, capture) {
    return (options, callback) => {
        capture.options = options;
        const req = new EventEmitter(); req.destroy = () => {};
        req.end = data => { capture.body = data; const res = new PassThrough(); res.statusCode = status; callback(res); res.end(body); };
        return req;
    };
}
test('check-in posts only to the fixed HTTPS endpoint and never leaks its token into URLs', async () => {
    const capture = {};
    assert.deepEqual(await checkin(identity, { request: fakeRequest(200, response(), capture) }), { intervalSeconds: 172800 });
    assert.deepEqual(capture.options, { protocol: 'https:', hostname: 'android.clients.google.com', port: 443, path: '/checkin', method: 'POST',
        headers: { 'content-type': 'application/x-protobuf', 'content-length': String(capture.body.length) } });
    await assert.rejects(checkin(identity, { request: fakeRequest(401, Buffer.alloc(0), {}) }), { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' });
    await assert.rejects(checkin(identity, { request: fakeRequest(302, Buffer.alloc(0), {}) }), { code: 'X_PUSH_CHECKIN_NETWORK' });
});
test('aborted and oversized check-ins fail safely', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(checkin(identity, { signal: controller.signal }), { code: 'X_PUSH_CHECKIN_STOPPED' });
    await assert.rejects(checkin(identity, { request: fakeRequest(200, Buffer.alloc(256 * 1024 + 1), {}) }), { code: 'X_PUSH_CHECKIN_INVALID' });
});
