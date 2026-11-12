'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { buildSyntheticBraveMacTransfer } = require('../native-test/brave-mac-synthetic-transfer.cjs');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
function fixture() {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = keys.publicKey.export({ format: 'jwk' }), privateKey = keys.privateKey.export({ format: 'jwk' });
    const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(publicKey.x, 'base64url'), Buffer.from(publicKey.y, 'base64url')]).toString('base64url');
    const origin = 'http://127.0.0.1:12345';
    return { origin, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh, auth: randomBytes(16).toString('base64url') } },
        deviceId: '123', securityToken: '456', appId: `wp:${origin}/#01234567-89AB-4CDE-8FAB-012345678-V2`,
        category: 'com.brave.macosx', encryption: { privateKey, authorizedEntity: 'sender_123' },
        browserVersion: '1.85.123.45', engineVersion: '157.0.8103.39' };
}
test('synthetic Brave Mac transfer substitutes only loopback and keeps server intake closed', () => {
    const input = fixture(), result = buildSyntheticBraveMacTransfer(input);
    assert.equal(result.file.push.productCategory, 'com.brave.macosx'); assert.equal(result.file.provenance.engineVersion, input.engineVersion);
    assert.throws(() => parseTransferFile(JSON.stringify(result.file)), { code: 'X_SETUP_INVALID_FILE' });
    assert.throws(() => buildSyntheticBraveMacTransfer({ ...input, origin: 'https://x.com' }), /FIXTURE_ORIGIN_INVALID/);
    assert.throws(() => buildSyntheticBraveMacTransfer({ ...input, origin: 'http://127.0.0.1:99999' }), /does not match/);
});
