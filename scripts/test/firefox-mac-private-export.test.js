'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createECDH } = require('node:crypto');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
const { writeMacFirefoxExport } = require('../../src/automation/firefox-mac-private-export');

function fixture() {
    const scalar = Buffer.alloc(32); scalar[31] = 1;
    const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(scalar); const point = ecdh.getPublicKey();
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: '22222222-2222-4222-8222-222222222222', channelID: '11111111-1111-4111-8111-111111111111',
            pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-ONLY', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: point.toString('base64url'), authenticationSecret: Buffer.alloc(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'),
                y: point.subarray(33).toString('base64url'), d: scalar.toString('base64url'), ext: true, key_ops: ['deriveBits'] } } };
}

test('Firefox export requires consent, publishes privately once and never uploads', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-export-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-firefox-export-/); await fs.rm(real, { recursive: true });
    });
    const file = fixture(), options = { directory: base, filename: 'notifications.json', file, confirmed: true,
        otherSubscriptionCount: 0, otherSitesConsent: false };
    for (const changes of [{ confirmed: false }, { otherSubscriptionCount: 1 }, { otherSubscriptionCount: -1 },
        { otherSubscriptionCount: 64 }, { otherSitesConsent: 'yes' }, { file: { ...file, version: 3 } }, { filename: '../escape' }])
        await assert.rejects(writeMacFirefoxExport({ ...options, ...changes }), { code: 'X_FIREFOX_MAC_EXPORT_INVALID' });
    assert.deepEqual(await fs.readdir(base), []);
    const saved = await writeMacFirefoxExport(options), target = path.join(base, options.filename), stat = await fs.stat(target);
    assert.deepEqual(saved, { filename: options.filename, containsSensitiveData: true, encrypted: false, uploaded: false });
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1);
    assert.deepEqual(parseTransferFile(await fs.readFile(target, 'utf8')), file);
    await assert.rejects(writeMacFirefoxExport(options), { code: 'X_FIREFOX_MAC_EXPORT_EXISTS' });
    await fs.symlink(target, path.join(base, 'existing-link.json'));
    await assert.rejects(writeMacFirefoxExport({ ...options, filename: 'existing-link.json' }), { code: 'X_FIREFOX_MAC_EXPORT_EXISTS' });
    const supported = { ...options, filename: 'supporter.json', otherSubscriptionCount: 2, otherSitesConsent: true };
    const race = await Promise.allSettled([writeMacFirefoxExport(supported), writeMacFirefoxExport(supported)]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter(result => result.status === 'rejected' && result.reason.code === 'X_FIREFOX_MAC_EXPORT_EXISTS').length, 1);
    assert.deepEqual(parseTransferFile(await fs.readFile(path.join(base, 'supporter.json'), 'utf8')), file);
    const controller = new AbortController(), originalOpen = fs.open.bind(fs);
    const hook = mock.method(fs, 'open', async (...args) => {
        const handle = await originalOpen(...args), write = handle.writeFile.bind(handle);
        handle.writeFile = async (...values) => { await write(...values); controller.abort(); };
        return handle;
    });
    try {
        await assert.rejects(writeMacFirefoxExport({ ...options, filename: 'cancelled.json', signal: controller.signal }),
            { code: 'X_FIREFOX_MAC_EXPORT_CANCELLED' });
    } finally { hook.mock.restore(); }
    await assert.rejects(fs.access(path.join(base, 'cancelled.json')), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(base)).sort(), ['existing-link.json', 'notifications.json', 'supporter.json']);
    await fs.chmod(base, 0o777);
    try { await assert.rejects(writeMacFirefoxExport({ ...options, filename: 'unsafe.json' }), { code: 'X_FIREFOX_MAC_EXPORT_DIRECTORY_UNSAFE' }); }
    finally { await fs.chmod(base, 0o700); }
});
