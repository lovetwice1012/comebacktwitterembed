'use strict';

// CI-only adapter for a local test origin. Never use this to rewrite a real
// subscription: X-only production validation remains unchanged.
const assert = require('node:assert/strict');
const { createPrivateKey, generateKeyPairSync } = require('node:crypto');
const { buildChromeTransfer } = require('../../src/automation/chrome-snapshot-reader');
const { parseTransferFile, createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
function vint(n) { const out = []; do { let byte = n % 128; n = Math.floor(n / 128); if (n) byte |= 128; out.push(byte); } while (n); return Buffer.from(out); }
function field(n, data) { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); return Buffer.concat([vint(n * 8 + 2), vint(bytes.length), bytes]); }

function verifySyntheticMacTransfer({ origin, subscription, deviceId, securityToken, appId, category, encryption, browserVersion }) {
    const prefix = `wp:${origin}/#`;
    assert.ok(appId.startsWith(prefix), 'unexpected local app identifier');
    const syntheticId = `wp:https://x.com/#${appId.slice(prefix.length)}`;
    const der = createPrivateKey({ key: encryption.privateKey, format: 'jwk' }).export({ format: 'der', type: 'pkcs8' });
    const record = Buffer.concat([field(1, syntheticId), field(3, Buffer.from(subscription.keys.auth, 'base64url')),
        field(4, encryption.authorizedEntity), field(5, der)]);
    try {
        const result = buildChromeTransfer({ preferences: { gcm: { product_category_for_subtypes: category,
            push_messaging_application_id_map: { [syntheticId]: 'https://x.com/#1#' } } },
        subscription: { ...subscription, scope: 'https://x.com/' }, records: [{ key: `${syntheticId},${encryption.authorizedEntity}`, value: record }],
        deviceId, securityToken, browserVersion, allowMac: true });
        const parsed = parseTransferFile(JSON.stringify(result.file));
        const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
        const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: keys.publicKey } });
        const vault = createTransferPrivateWorkerVault({ activeKeyId: 'fixture', privateKeys: { fixture: keys.privateKey } });
        const owner = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789012345678', revision: 1 };
        const envelope = sealer.seal(parsed, owner), opened = vault.open(envelope, owner);
        assert.ok(JSON.stringify(parsed) === JSON.stringify(opened), 'worker vault round-trip mismatch');
        assert.throws(() => vault.open(envelope, { ...owner, ownerUserId: '999999999999999999' }), { code: 'X_SETUP_DECRYPT_FAILED' });
        return parsed;
    } finally { der.fill(0); record.fill(0); }
}
module.exports = { verifySyntheticMacTransfer };
