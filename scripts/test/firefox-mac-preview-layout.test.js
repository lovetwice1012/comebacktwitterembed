'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { unzipSync } = require('fflate');
const { assembleMacApp, buildMacFirefoxPreview } = require('../build-mac-chrome-preview.cjs');
const { buildMacFirefoxBundle } = require('../build-mac-chrome-setup-bundle.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('Firefox preview layout binds both readers and keeps its own identity', () => {
    const helper = Buffer.from('fixture-helper'), bootstrap = Buffer.from('fixture-bootstrap'), reader = Buffer.from('fixture-reader');
    const args = { bundle: { 'MacSetup.cjs': Buffer.from('fixture'), 'MacLevelDB.node': Buffer.from('fixture') },
        runtime: Buffer.from('runtime'), launcher: Buffer.from('launcher'), helper, license: Buffer.from('node-license'),
        projectLicense: Buffer.from('project-license'), guide: Buffer.from('guide'), browser: 'firefox', firefoxBootstrap: bootstrap, firefoxReader: reader };
    const files = unzipSync(assembleMacApp(args)), root = 'X通知の準備.app/Contents/';
    const manifest = JSON.parse(Buffer.from(files[`${root}Resources/MacSetup-manifest.json`]).toString('utf8'));
    assert.equal(manifest.packageId, 'x-notification-mac-firefox-setup'); assert.equal(manifest.version, '0.1.0-mac-firefox-preview.1');
    assert.equal(manifest.lockSha256, hash(helper)); assert.equal(manifest.bootstrapSha256, hash(bootstrap)); assert.equal(manifest.readerSha256, hash(reader));
    assert.deepEqual(Buffer.from(files[`${root}Resources/FirefoxXPCShellReader.js`]), bootstrap);
    assert.deepEqual(Buffer.from(files[`${root}Resources/Read-PushSubscription.js`]), reader);
    assert(Buffer.from(files[`${root}Info.plist`]).toString('utf8').includes('jp.cbte.xnotification.firefox-setup'));
    assert.throws(() => assembleMacApp({ ...args, firefoxReader: undefined }), /Missing Firefox readers/);
});
test('Firefox preview builds bounded helper and rejects unverified native inputs', async () => {
    const bundle = await buildMacFirefoxBundle();
    assert(bundle['MacSetup.cjs'].length > 0 && bundle['MacSetup.cjs'].length < 1024 * 1024);
    assert(bundle['MacLevelDB.node'].length > 0); assert(bundle['MacDependencies-LICENSE.txt'].length > 0);
    await assert.rejects(buildMacFirefoxPreview({ arch: 'arm64', runtime: Buffer.from('bad'), launcher: Buffer.from('bad'),
        helper: Buffer.from('bad'), license: Buffer.from('bad') }), /input verification failed/);
});
