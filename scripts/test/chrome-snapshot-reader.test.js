'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { buildChromeTransfer } = require('../../src/automation/chrome-snapshot-reader');
function vint(n) { const a = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n, value) { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([vint(n * 8 + 2), vint(data.length), data]); }
function fixture() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = pair.publicKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const secret = randomBytes(16), id = 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', sender = 'sender_123';
    return { preferences: { gcm: { product_category_for_subtypes: 'com.chrome.windows', push_messaging_application_id_map: {
        [id]: 'https://x.com/#123#', 'wp:other': 'https://example.com/#5#',
    } } }, subscription: { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/example',
        keys: { p256dh: pub.toString('base64url'), auth: secret.toString('base64url') } },
    records: [{ key: id + ',' + sender, value: Buffer.concat([field(1, id), field(3, secret), field(4, sender),
        field(5, pair.privateKey.export({ format: 'der', type: 'pkcs8' }))]) }], deviceId: '123', securityToken: '456', browserVersion: '140.0.7339.42' };
}
test('selects X and reports other subscriptions without exposing their data', () => {
    const result = buildChromeTransfer(fixture());
    assert.equal(result.otherSubscriptionCount, 1); assert.equal(result.file.version, 2);
    assert(!JSON.stringify(result).includes('example.com'));
    assert(!JSON.stringify(result).includes('/fcm/send/'));
});
test('rejects ambiguous X subscriptions, mismatched keys and foreign endpoint or scope', () => {
    for (const mutate of [f => f.preferences.gcm.push_messaging_application_id_map['second'] = 'https://x.com/#456',
        f => f.subscription.scope = 'https://x.com.attacker/', f => f.subscription.endpoint = 'https://attacker/fcm/send/1',
        f => f.subscription.keys.auth = randomBytes(16).toString('base64url'), f => f.records[0].key += 'wrong',
        f => f.preferences.gcm.product_category_for_subtypes = 'com.other.windows']) {
        const f = fixture(); mutate(f); assert.throws(() => buildChromeTransfer(f), /^Error: X_CHROME_SNAPSHOT_/);
    }
});
