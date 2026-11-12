'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fixture, encrypted } = require('./helpers/x-push-fixture.cjs');
const { createChromeMcsStoreAdapter } = require('../../src/automation/chrome-mcs-store-adapter');
const { verifySyntheticMacDatabaseTransfer, syntheticTransferText } = require('../native-test/chrome-mac-synthetic-db.cjs');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');

test('synthetic upload uses the exact saved JSON and rejects mismatches without exposing contents', () => {
    const original = fixture(), key = original.push.p256dhPrivateKey;
    const source = { format: original.format, version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '157.0.0.1', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123456', securityToken: '987654', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.macosx', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: original.push.p256dhPublicKey, authenticationSecret: original.push.authenticationSecret,
            p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
    const file = parseTransferFile(JSON.stringify(source)), saved = JSON.stringify(file, null, 2);
    assert.equal(syntheticTransferText(file, saved), saved);
    assert.throws(() => syntheticTransferText(file, saved.replace('987654', '987655')), /FIXTURE_TRANSFER_MISMATCH/);
    assert.throws(() => syntheticTransferText(file, '{'), /FIXTURE_TRANSFER_MISMATCH/);
    assert.throws(() => syntheticTransferText(file, 'x'.repeat(32769)), /FIXTURE_TRANSFER_MISMATCH/);
});

test('synthetic Mac intake stores encrypted receipt and replay ID atomically',
    { skip: process.env.CBTE_MAC_DB_FIXTURE !== '1', timeout: 30000 }, async () => {
        const original = fixture(), key = original.push.p256dhPrivateKey;
        const file = { format: original.format, version: 2,
            provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '157.0.0.1', readMethod: 'chrome-gcm-snapshot' },
            push: { deviceId: '123456', securityToken: '987654', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
                productCategory: 'com.chrome.macosx', authorizedEntity: 'sender_123', scope: 'https://x.com/',
                p256dhPublicKey: original.push.p256dhPublicKey, authenticationSecret: original.push.authenticationSecret,
                p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
        const payload = process.env.CBTE_MAC_REAL_ROUTE_FIXTURE === '1'
            ? { notificationType: 'tweet', author: { id: '12345', handle: 'synthetic' }, url: 'https://x.com/synthetic/status/1234567890123456789', text: 'synthetic' }
            : { message: 'synthetic' };
        const wire = await encrypted(file, payload);
        const preflightWire = await encrypted(file, { message: 'preflight' });
        const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
        await verifySyntheticMacDatabaseTransfer(file, async ({ store, lease }) => {
            const adapter = createChromeMcsStoreAdapter({ store, lease, authorize: async () => {}, decrypt: frame =>
                decryptEce(Buffer.from(frame.data, 'base64url'), frame.headers, { public_key: [...Buffer.from(file.push.p256dhPublicKey, 'base64url')],
                    private_key: [...Buffer.from(file.push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(file.push.authenticationSecret, 'base64url')] }) });
            const preflight = { persistentId: 'synthetic-preflight', encrypted: { data: Buffer.from(preflightWire.data, 'base64url'), headers: preflightWire.headers } };
            assert.equal((await adapter.commit(preflight)).status, 'received');
            assert.equal((await adapter.commit(preflight)).duplicate, true);
            const receipt = await adapter.commit({ persistentId: 'synthetic-receipt', encrypted: { data: Buffer.from(wire.data, 'base64url'), headers: wire.headers } });
            assert.equal(receipt.status, 'received');
            assert.deepEqual(new Set(await adapter.pending()), new Set(['synthetic-preflight', 'synthetic-receipt']));
            const decoded = decryptEce(Buffer.from(receipt.data, 'base64url'), receipt.headers, { public_key: [...Buffer.from(file.push.p256dhPublicKey, 'base64url')],
                private_key: [...Buffer.from(file.push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(file.push.authenticationSecret, 'base64url')] });
            assert.equal(decoded.toString('utf8'), JSON.stringify(payload));
        });
    });

test('synthetic Mac Brave HTTP intake and encrypted receipt route use the explicit fixture gate',
    { skip: process.env.CBTE_MAC_DB_FIXTURE !== '1', timeout: 30000 }, async () => {
        const original = fixture(), key = original.push.p256dhPrivateKey;
        const file = { format: original.format, version: 2,
            provenance: { kind: 'brave-gcm', adapterVersion: '1.0.0', browserVersion: '156.1.98.63', engineVersion: '156.0.8078.80', readMethod: 'brave-gcm-snapshot' },
            push: { deviceId: '123456', securityToken: '987654', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
                productCategory: 'com.brave.macosx', authorizedEntity: 'sender_123', scope: 'https://x.com/',
                p256dhPublicKey: original.push.p256dhPublicKey, authenticationSecret: original.push.authenticationSecret,
                p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
        const text = JSON.stringify(file);
        assert.throws(() => syntheticTransferText(file, text), /FIXTURE_TRANSFER_MISMATCH/);
        assert.equal(syntheticTransferText(file, text, { braveMac: true }), text);
        const payload = { notificationType: 'tweet', author: { id: '12345', handle: 'synthetic' },
            url: 'https://x.com/synthetic/status/1234567890123456789', text: 'synthetic' };
        const wire = await encrypted(file, payload);
        const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
        await verifySyntheticMacDatabaseTransfer(file, async ({ store, lease }) => {
            const adapter = createChromeMcsStoreAdapter({ store, lease, authorize: async () => {}, decrypt: frame =>
                decryptEce(Buffer.from(frame.data, 'base64url'), frame.headers, { public_key: [...Buffer.from(file.push.p256dhPublicKey, 'base64url')],
                    private_key: [...Buffer.from(file.push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(file.push.authenticationSecret, 'base64url')] }) });
            const receipt = await adapter.commit({ persistentId: 'synthetic-brave', encrypted: { data: Buffer.from(wire.data, 'base64url'), headers: wire.headers } });
            assert.equal(receipt.status, 'received');
        }, { fileText: text, braveMac: true });
    });
