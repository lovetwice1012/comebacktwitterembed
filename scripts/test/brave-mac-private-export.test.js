'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createECDH } = require('node:crypto');
const { writeExperimentalMacBraveExport } = require('../../src/automation/brave-mac-private-export');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
function fixture() {
    const scalar = Buffer.concat([Buffer.alloc(31), Buffer.from([1])]);
    const key = createECDH('prime256v1'); key.setPrivateKey(scalar);
    const pub = key.getPublicKey();
    return { format: 'x-notification-subscription', version: 2,
        provenance: { kind: 'brave-gcm', adapterVersion: '1.0.0', browserVersion: '157.1.99.55', engineVersion: '157.0.8103.39', readMethod: 'brave-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.brave.macosx', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: pub.toString('base64url'), authenticationSecret: Buffer.alloc(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'),
                y: pub.subarray(33).toString('base64url'), d: scalar.toString('base64url') } } };
}
test('experimental Brave output requires explicit consent and remains excluded from server intake', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-brave-mac-output-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-brave-mac-output-/); await fs.rm(real, { recursive: true });
    });
    const file = fixture(), options = { directory: base, filename: 'brave.json', file, confirmed: true, experimental: true,
        otherSubscriptionCount: 1, otherSitesConsent: true };
    for (const change of [{ experimental: false }, { confirmed: false }, { otherSitesConsent: false }, { otherSubscriptionCount: 64 },
        { file: { ...file, push: { ...file.push, productCategory: 'com.brave.windows' } } }, { filename: '../escape' }])
        await assert.rejects(writeExperimentalMacBraveExport({ ...options, ...change }), { code: 'X_BRAVE_MAC_EXPORT_INVALID' });
    assert.deepEqual(await fs.readdir(base), []);
    const race = await Promise.allSettled([writeExperimentalMacBraveExport(options), writeExperimentalMacBraveExport(options)]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter(result => result.status === 'rejected' && result.reason.code === 'X_BRAVE_MAC_EXPORT_EXISTS').length, 1);
    const filename = path.join(base, options.filename), stat = await fs.stat(filename), saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1); assert.deepEqual(saved, file);
    assert.throws(() => parseTransferFile(JSON.stringify(saved)), error => error.code === 'X_SETUP_INVALID_FILE');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(writeExperimentalMacBraveExport({ ...options, filename: 'cancelled.json', signal: controller.signal }), { code: 'X_BRAVE_MAC_EXPORT_CANCELLED' });
    await assert.rejects(fs.access(path.join(base, 'cancelled.json')), { code: 'ENOENT' });
});
