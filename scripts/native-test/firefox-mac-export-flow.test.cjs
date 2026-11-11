'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash, createECDH } = require('node:crypto');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
const helper = process.env.MAC_LOCK_HELPER;

function fixture() {
    const scalar = Buffer.alloc(32); scalar[31] = 1; const curve = createECDH('prime256v1'); curve.setPrivateKey(scalar);
    const pub = curve.getPublicKey();
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: '22222222-2222-4222-8222-222222222222', channelID: '11111111-1111-4111-8111-111111111111',
            pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-ONLY', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: pub.toString('base64url'), authenticationSecret: Buffer.alloc(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'),
                y: pub.subarray(33).toString('base64url'), d: scalar.toString('base64url'), ext: true, key_ops: ['deriveBits'] } } };
}

test('experimental Firefox composition preserves consent and uncertain-process boundaries',
    { skip: !helper || process.platform === 'win32', timeout: 30000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-flow-fixture-'));
        let profile; const cwdPaths = [];
        t.after(async () => {
            const real = await fs.realpath(base); assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-firefox-flow-fixture-/);
            for (const cwd of cwdPaths) {
                assert.equal(path.dirname(cwd), profile.rootPath); assert.match(path.basename(cwd), /^firefox-reader-cwd-[0-9a-f]{32}$/);
                try { const stat = await fs.lstat(cwd); if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.chmod(cwd, 0o700); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            await fs.rm(real, { recursive: true });
        });
        profile = await createMacFirefoxProfile(base);
        const idb = path.join(profile.profilePath, 'storage/permanent/chrome/idb'); await fs.mkdir(idb, { recursive: true });
        await fs.writeFile(path.join(profile.profilePath, '.parentlock'), '');
        await fs.writeFile(path.join(profile.profilePath, 'prefs.js'), 'user_pref("dom.push.userAgentID", "22222222-2222-4222-8222-222222222222");\n');
        await fs.writeFile(path.join(idb, '2918063365piupsah.sqlite'), 'synthetic-db');
        const bootstrapPath = path.join(base, 'FirefoxXPCShellReader.js'), readerPath = path.join(base, 'Read-PushSubscription.js');
        const script = Buffer.from('synthetic script\n'), hash = value => createHash('sha256').update(value).digest('hex');
        await fs.writeFile(bootstrapPath, script, { mode: 0o600 }); await fs.writeFile(readerPath, script, { mode: 0o600 });
        const modulePath = path.resolve(__dirname, '../../src/automation/firefox-mac-export-flow.js');
        const source = await fs.readFile(modulePath, 'utf8'), realRequire = createRequire(modulePath), module = { exports: {} };
        const fakeRequire = name => name === './firefox-mac-browser' ? { verifyInstalledMacFirefox: async () => ({ executable: '/synthetic/firefox', version: '160.0' }) } : realRequire(name);
        vm.runInNewContext(source, { module, exports: module.exports, require: fakeRequire, AbortSignal, Object });
        const exportFlow = module.exports.exportExperimentalMacFirefoxNotifications, file = fixture(), output = path.join(base, 'result.json');
        const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper, expectedSha256: hash(await fs.readFile(helper)),
            bootstrapPath, bootstrapSha256: hash(script), readerPath, readerSha256: hash(script), experimental: true };
        await assert.rejects(exportFlow({ ...args, runReader: async input => {
            cwdPaths.push(input.cwd); return { stopped: true, success: false };
        }, confirmSave: async () => assert.fail('failed reader must not save') }), { code: 'X_FIREFOX_MAC_FLOW_READER_FAILED' });
        assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-') || name.startsWith('firefox-reader-cwd-')));
        const runReader = async input => {
            cwdPaths.push(input.cwd); assert.deepEqual(await fs.readdir(input.cwd), []); assert.deepEqual(input.bootstrapBytes, script);
            await fs.writeFile(input.resultPath, JSON.stringify({ ok: true, export: file, otherSubscriptionCount: 1 }), { mode: 0o600, flag: 'wx' });
            return { stopped: true, success: true };
        };
        const choice = { confirmed: true, directory: base, filename: 'result.json', otherSitesConsent: false };
        await assert.rejects(exportFlow({ ...args, runReader, confirmSave: async () => choice }), { code: 'X_FIREFOX_MAC_FLOW_CONFIRMATION_REQUIRED' });
        await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
        const result = await exportFlow({ ...args, runReader, confirmSave: async info => {
            assert.equal(info.otherSubscriptionCount, 1); assert.equal(info.otherNotificationsMayReachServer, true);
            return { ...choice, otherSitesConsent: true };
        } });
        assert.equal(result.state, 'saved'); assert.deepEqual(parseTransferFile(await fs.readFile(output, 'utf8')), file);
        await assert.rejects(exportFlow({ ...args, runReader: async input => {
            cwdPaths.push(input.cwd); return { stopped: false, success: false };
        }, confirmSave: async () => assert.fail('must not save while termination is uncertain') }),
        { code: 'X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED' });
        const entries = await fs.readdir(profile.rootPath);
        assert(entries.some(name => name.startsWith('firefox-snapshot-')));
        assert(entries.some(name => name.startsWith('firefox-reader-cwd-')));
        assert.equal(await fs.readFile(path.join(idb, '2918063365piupsah.sqlite'), 'utf8'), 'synthetic-db');
    });
