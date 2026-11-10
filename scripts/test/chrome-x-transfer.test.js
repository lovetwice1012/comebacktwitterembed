'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, randomBytes } = require('node:crypto');
const { generateKeyPairSync } = require('node:crypto');
const { normalizeChromeTransfer, identifyChromeTransfer } = require('../../src/automation/chrome-x-transfer');
const { parseTransferFile, identifyTransfer, createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');

function fixture() {
    const key = createECDH('prime256v1'); key.generateKeys();
    const pub = key.getPublicKey();
    return { format: 'x-notification-subscription', version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '18446744073709551615', securityToken: '1234567890',
            appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', productCategory: 'com.chrome.windows',
            authorizedEntity: 'sender_123', scope: 'https://x.com/', p256dhPublicKey: pub.toString('base64url'),
            authenticationSecret: randomBytes(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'),
                y: pub.subarray(33).toString('base64url'), d: Buffer.from(key.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString('base64url') } } };
}
test('accepts a correctly scoped Chrome record and produces stable domain-separated identities', () => {
    const f = fixture(), normalized = normalizeChromeTransfer(f);
    assert.deepEqual(normalized, f);
    assert.deepEqual(identifyChromeTransfer(f), identifyChromeTransfer(normalized));
    const other = fixture(); other.push.deviceId = f.push.deviceId;
    assert.equal(identifyChromeTransfer(other).deviceHash, identifyChromeTransfer(f).deviceHash);
    assert.notEqual(identifyChromeTransfer(other).contentHash, identifyChromeTransfer(f).contentHash);
    const updated = structuredClone(f); updated.provenance.browserVersion = '141.0.0.1';
    assert.deepEqual(identifyChromeTransfer(updated), identifyChromeTransfer(f));
    updated.push.securityToken = '987654321';
    assert.notEqual(identifyChromeTransfer(updated).contentHash, identifyChromeTransfer(f).contentHash);
});
test('rejects wrong origin, sender or category and unsupported identifiers', () => {
    for (const edit of [f => f.push.scope = 'https://x.com.evil/', f => f.push.appId = f.push.appId.replace('x.com', 'evil.com'),
        f => f.push.appId = f.push.appId.toLowerCase(), f => f.push.productCategory = 'com.chromium.windows',
        f => f.push.authorizedEntity = 'bad sender', f => f.provenance.kind = 'firefox-pushdb']) {
        const f = fixture(); edit(f); assert.throws(() => normalizeChromeTransfer(f), /X_CHROME_TRANSFER_INVALID/);
    }
});
test('rejects invalid 64-bit credentials, key mismatch, extra fields and getters', () => {
    for (const edit of [f => f.push.deviceId = '18446744073709551616', f => f.push.securityToken = '01',
        f => f.push.p256dhPrivateKey.d = Buffer.alloc(32).toString('base64url'),
        f => f.push.authenticationSecret = 'bad', f => f.push.extra = 'ignored',
        f => Object.defineProperty(f.push, 'deviceId', { get() { throw new Error('must not execute'); }, enumerable: true })]) {
        const f = fixture(); edit(f); assert.throws(() => normalizeChromeTransfer(f), /X_CHROME_TRANSFER_INVALID/);
    }
});
test('Chrome transfer is bound and encrypted by the existing hybrid vault', () => {
    const file = fixture(), context = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
    const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const sealer = createTransferPublicSealer({ activeKeyId: 'test', publicKeys: { test: keys.publicKey } });
    const vault = createTransferPrivateWorkerVault({ activeKeyId: 'test', privateKeys: { test: keys.privateKey } });
    assert.deepEqual(parseTransferFile(JSON.stringify(file)), file);
    const envelope = sealer.seal(file, context);
    assert(!JSON.stringify(envelope).includes(file.push.securityToken));
    assert.deepEqual(vault.open(envelope, context), file);
    assert.throws(() => vault.open(envelope, { ...context, ownerUserId: '999' }), /保存された通知設定/);
    assert.equal(identifyTransfer(file).uaidHash, identifyChromeTransfer(file).deviceHash);
});
