'use strict';
// Synthetic local-origin adapter. Never pass real profiles or subscriptions.
const assert = require('node:assert/strict');
const { createPrivateKey } = require('node:crypto');
const { buildChromeTransfer } = require('../../src/automation/chrome-snapshot-reader');
function vint(n) { const out = []; do { let byte = n % 128; n = Math.floor(n / 128); if (n) byte |= 128; out.push(byte); } while (n); return Buffer.from(out); }
function field(n, data) { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); return Buffer.concat([vint(n * 8 + 2), vint(bytes.length), bytes]); }
function buildSyntheticBraveMacTransfer({ origin, subscription, deviceId, securityToken, appId, category, encryption, browserVersion, engineVersion }) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(origin)) throw new Error('FIXTURE_ORIGIN_INVALID');
    const prefix = `wp:${origin}/#`;
    assert.ok(appId.startsWith(prefix), 'synthetic subscription does not match the fixture origin');
    const syntheticId = `wp:https://x.com/#${appId.slice(prefix.length)}`;
    const der = createPrivateKey({ key: encryption.privateKey, format: 'jwk' }).export({ format: 'der', type: 'pkcs8' });
    const record = Buffer.concat([field(1, syntheticId), field(3, Buffer.from(subscription.keys.auth, 'base64url')),
        field(4, encryption.authorizedEntity), field(5, der)]);
    try {
        return buildChromeTransfer({ preferences: { gcm: { product_category_for_subtypes: category,
            push_messaging_application_id_map: { [syntheticId]: 'https://x.com/#1#' } } },
            subscription: { ...subscription, scope: 'https://x.com/' }, records: [{ key: `${syntheticId},${encryption.authorizedEntity}`, value: record }],
            deviceId, securityToken, browserVersion, engineVersion, allowMac: true, allowBraveMac: true });
    } finally { der.fill(0); record.fill(0); }
}
module.exports = { buildSyntheticBraveMacTransfer };
