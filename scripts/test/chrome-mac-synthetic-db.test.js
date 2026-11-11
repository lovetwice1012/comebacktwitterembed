'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fixture, encrypted } = require('./helpers/x-push-fixture.cjs');
const { createChromeMcsStoreAdapter } = require('../../src/automation/chrome-mcs-store-adapter');
const { verifySyntheticMacDatabaseTransfer } = require('../native-test/chrome-mac-synthetic-db.cjs');

test('synthetic Mac intake stores encrypted receipt and replay ID atomically',
    { skip: process.env.CBTE_MAC_DB_FIXTURE !== '1', timeout: 30000 }, async () => {
        const original = fixture(), key = original.push.p256dhPrivateKey;
        const file = { format: original.format, version: 2,
            provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '157.0.0.1', readMethod: 'chrome-gcm-snapshot' },
            push: { deviceId: '123456', securityToken: '987654', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
                productCategory: 'com.chrome.macosx', authorizedEntity: 'sender_123', scope: 'https://x.com/',
                p256dhPublicKey: original.push.p256dhPublicKey, authenticationSecret: original.push.authenticationSecret,
                p256dhPrivateKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d } } };
        const wire = await encrypted(file, { message: 'synthetic' });
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
            assert.equal(decoded.toString('utf8'), JSON.stringify({ message: 'synthetic' }));
        });
    });
