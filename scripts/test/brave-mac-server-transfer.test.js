'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, generateKeyPairSync, randomBytes } = require('node:crypto');
const { parseTransferFile, identifyTransfer, createTransferPublicSealer, createTransferPrivateWorkerVault,
    createTransferSealer, createTransferWorkerVault } = require('../../src/automation/x-setup-transfer');

function fixture() {
    const key = createECDH('prime256v1'); key.generateKeys();
    const pub = key.getPublicKey();
    return { format: 'x-notification-subscription', version: 2,
        provenance: { kind: 'brave-gcm', adapterVersion: '1.0.0', browserVersion: '156.1.98.63', engineVersion: '156.0.8078.80', readMethod: 'brave-gcm-snapshot' },
        push: { deviceId: '123456', securityToken: '654321', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.brave.macosx', authorizedEntity: 'fixture_sender', scope: 'https://x.com/',
            p256dhPublicKey: pub.toString('base64url'), authenticationSecret: randomBytes(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url'),
                d: Buffer.from(key.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString('base64url') } } };
}
const context = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '222222222222222222', revision: 1 };
test('Mac Brave file requires a separate opt-in throughout parsing, identity and both vault families', () => {
    const file = fixture(), text = JSON.stringify(file), gate = { allowBraveMac: true };
    assert.throws(() => parseTransferFile(text), { code: 'X_SETUP_INVALID_FILE' });
    assert.throws(() => identifyTransfer(file), { code: 'X_SETUP_INVALID_FILE' });
    assert.deepEqual(parseTransferFile(text, gate), file);
    assert.match(identifyTransfer(file, gate).contentHash, /^[a-f0-9]{64}$/);
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const publicConfig = { activeKeyId: 'test', publicKeys: { test: pair.publicKey } };
    const privateConfig = { activeKeyId: 'test', privateKeys: { test: pair.privateKey } };
    assert.throws(() => createTransferPublicSealer(publicConfig).seal(file, context), { code: 'X_SETUP_INVALID_FILE' });
    const envelope = createTransferPublicSealer({ ...publicConfig, ...gate }).seal(file, context);
    assert.throws(() => createTransferPrivateWorkerVault(privateConfig).open(envelope, context), { code: 'X_SETUP_DECRYPT_FAILED' });
    const vault = createTransferPrivateWorkerVault({ ...privateConfig, ...gate });
    assert.deepEqual(vault.open(envelope, context), file);
    assert.throws(() => vault.open(envelope, { ...context, ownerUserId: '333333333333333333' }), { code: 'X_SETUP_DECRYPT_FAILED' });
    const key = randomBytes(32), secretConfig = { activeKeyId: 'test', keys: { test: key } };
    assert.throws(() => createTransferSealer(secretConfig).seal(file, context), { code: 'X_SETUP_INVALID_FILE' });
    const legacyEnvelope = createTransferSealer({ ...secretConfig, ...gate }).seal(file, context);
    assert.throws(() => createTransferWorkerVault(secretConfig).open(legacyEnvelope, context), { code: 'X_SETUP_DECRYPT_FAILED' });
    assert.deepEqual(createTransferWorkerVault({ ...secretConfig, ...gate }).open(legacyEnvelope, context), file);
    const invalid = structuredClone(file); invalid.push.productCategory = 'com.chrome.macosx';
    assert.throws(() => parseTransferFile(JSON.stringify(invalid), gate), { code: 'X_SETUP_INVALID_FILE' });
});
