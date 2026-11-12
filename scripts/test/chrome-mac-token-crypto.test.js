'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, pbkdf2Sync } = require('node:crypto');
const { decryptMacChromiumDeviceToken } = require('../../src/automation/chrome-mac-token-crypto');

const password = Buffer.from('synthetic-passphrase');
// Independently generated using Python hashlib and cryptography; no browser data.
const vector = Buffer.concat([Buffer.from('v10'), Buffer.from('4290e3080757d83cc1efe4cb31df9bbccf92e4a6faa5af1a2aecbcf3aea053e7', 'hex')]);
function encryptFixture(value) {
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    try {
        const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
        return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.from(value)), cipher.final()]);
    } finally { key.fill(0); }
}
test('decrypts a synthetic Chromium v10 macOS device token', () => {
    assert.equal(decryptMacChromiumDeviceToken(vector, password), '18446744073709551615');
    assert.equal(decryptMacChromiumDeviceToken(encryptFixture('1'), password), '1');
    assert.equal(password.toString(), 'synthetic-passphrase');
});
test('rejects unknown, truncated, wrong-key and noncanonical token values', () => {
    for (const value of [Buffer.alloc(0), Buffer.from('v20' + 'x'.repeat(16)), vector.subarray(0, -1),
        encryptFixture('0'), encryptFixture('0123'), encryptFixture('18446744073709551616'), encryptFixture('not-a-token')]) {
        assert.throws(() => decryptMacChromiumDeviceToken(value, password), { code: 'X_CHROME_MAC_TOKEN_INVALID' });
    }
    assert.throws(() => decryptMacChromiumDeviceToken(vector, Buffer.from('wrong-password')), { code: 'X_CHROME_MAC_TOKEN_INVALID' });
    assert.throws(() => decryptMacChromiumDeviceToken(vector, Buffer.alloc(0)), { code: 'X_CHROME_MAC_TOKEN_INVALID' });
});
