'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { writeMacChromeExport } = require('../../src/automation/chrome-mac-private-export');

function fixture() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = privateKey.export({ format: 'jwk' });
    return { format: 'x-notification-subscription', version: 2,
        provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion: '140.0.7339.42', readMethod: 'chrome-gcm-snapshot' },
        push: { deviceId: '123', securityToken: '456', appId: 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2',
            productCategory: 'com.chrome.macosx', authorizedEntity: 'sender_123', scope: 'https://x.com/',
            p256dhPublicKey: Buffer.concat([Buffer.from([4]), Buffer.from(key.x, 'base64url'), Buffer.from(key.y, 'base64url')]).toString('base64url'),
            authenticationSecret: randomBytes(16).toString('base64url'), p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, d: key.d } } };
}
test('private export is exclusive, user-confirmed and leaves no partial output', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-mac-output-test-'));
    t.after(async () => {
        const real = await fs.realpath(root); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-output-test-/); await fs.rm(real, { recursive: true });
    });
    const file = fixture(), input = { directory: root, filename: 'X-notifications.json', file, confirmed: true };
    const result = await writeMacChromeExport(input), filename = path.join(root, input.filename), info = await fs.stat(filename);
    assert.deepEqual(result, { filename: input.filename, containsSensitiveData: true, encrypted: false, uploaded: false });
    assert.equal(info.mode & 0o777, 0o600); assert.equal(info.uid, process.getuid()); assert.equal(info.nlink, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), file);
    await assert.rejects(writeMacChromeExport(input), { code: 'X_CHROME_EXPORT_EXISTS' });
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), file);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(writeMacChromeExport({ ...input, filename: 'cancelled.json', signal: controller.signal }), { code: 'X_CHROME_EXPORT_CANCELLED' });
    await assert.rejects(writeMacChromeExport({ ...input, filename: 'no-confirm.json', confirmed: false }), { code: 'X_CHROME_EXPORT_INVALID' });
    await assert.rejects(writeMacChromeExport({ ...input, filename: '../escape.json' }), { code: 'X_CHROME_EXPORT_INVALID' });
    await fs.symlink(filename, path.join(root, 'link.json'));
    await assert.rejects(writeMacChromeExport({ ...input, filename: 'link.json' }), { code: 'X_CHROME_EXPORT_EXISTS' });
    const competing = { ...input, filename: 'concurrent.json' };
    const race = await Promise.allSettled([writeMacChromeExport(competing), writeMacChromeExport(competing)]);
    assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(race.filter(item => item.status === 'rejected' && item.reason.code === 'X_CHROME_EXPORT_EXISTS').length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'concurrent.json'), 'utf8')), file);
    assert.deepEqual((await fs.readdir(root)).sort(), ['X-notifications.json', 'concurrent.json', 'link.json']);
    await fs.chmod(root, 0o777);
    await assert.rejects(writeMacChromeExport({ ...input, filename: 'unsafe.json' }), { code: 'X_CHROME_EXPORT_DIRECTORY_UNSAFE' });
    await fs.chmod(root, 0o700);
});
