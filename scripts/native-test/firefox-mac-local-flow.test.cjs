'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, createECDH } = require('node:crypto');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { withMacFirefoxSnapshot } = require('../../src/automation/firefox-mac-snapshot');
const { prepareMacFirefoxReaderResult, consumeMacFirefoxReaderResult } = require('../../src/automation/firefox-mac-reader-result');
const { writeMacFirefoxExport } = require('../../src/automation/firefox-mac-private-export');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
const helper = process.env.MAC_LOCK_HELPER;
function file() {
    const scalar = Buffer.alloc(32); scalar[31] = 1; const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(scalar); const publicKey = ecdh.getPublicKey();
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: '22222222-2222-4222-8222-222222222222', channelID: '11111111-1111-4111-8111-111111111111',
            pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-ONLY', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: publicKey.toString('base64url'), authenticationSecret: Buffer.alloc(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: publicKey.subarray(1, 33).toString('base64url'),
                y: publicKey.subarray(33).toString('base64url'), d: scalar.toString('base64url'), ext: true, key_ops: ['deriveBits'] } } };
}
test('simulated reader: locked snapshot, private result and consented local export compose safely',
    { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-local-flow-'));
        t.after(async () => {
            const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
            assert.match(path.basename(real), /^cbte-firefox-local-flow-/); await fs.rm(real, { recursive: true });
        });
        const profile = await createMacFirefoxProfile(base), idb = path.join(profile.profilePath, 'storage/permanent/chrome/idb');
        await fs.mkdir(idb, { recursive: true });
        await fs.writeFile(path.join(profile.profilePath, '.parentlock'), '');
        await fs.writeFile(path.join(profile.profilePath, 'prefs.js'), 'user_pref("dom.push.userAgentID", "22222222-2222-4222-8222-222222222222");\n');
        await fs.writeFile(path.join(idb, '2918063365piupsah.sqlite'), 'synthetic-db');
        const data = await withMacFirefoxSnapshot({ rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper,
            expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex'), work: async ({ snapshotPath, uaid, signal }) => {
                assert.equal(signal.aborted, false);
                const capability = await prepareMacFirefoxReaderResult({ rootPath: profile.rootPath, profileId: profile.profileId,
                    snapshotPath, expectedUaid: uaid, expectedVersion: '160.0' });
                // Synthetic stand-in; this does not launch or verify Firefox.
                const token = path.basename(snapshotPath).slice('firefox-snapshot-'.length);
                const resultPath = path.join(profile.rootPath, `firefox-result-${token}.json`);
                await fs.writeFile(resultPath, JSON.stringify({ ok: true, export: file(), otherSubscriptionCount: 1 }), { mode: 0o600 });
                const result = await consumeMacFirefoxReaderResult(capability);
                await assert.rejects(fs.access(resultPath), { code: 'ENOENT' });
                return result;
            } });
        assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-') || name.startsWith('firefox-result-')));
        const options = { directory: base, filename: 'notifications.json', file: data.file, confirmed: true,
            otherSubscriptionCount: data.otherSubscriptionCount, otherSitesConsent: false };
        await assert.rejects(writeMacFirefoxExport(options), { code: 'X_FIREFOX_MAC_EXPORT_INVALID' });
        await assert.rejects(fs.access(path.join(base, options.filename)), { code: 'ENOENT' });
        const saved = await writeMacFirefoxExport({ ...options, otherSitesConsent: true });
        assert.equal(saved.uploaded, false); assert.equal(saved.encrypted, false);
        assert.deepEqual(parseTransferFile(await fs.readFile(path.join(base, options.filename), 'utf8')), file());
    });
