'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { unzipSync } = require('fflate');
const { assembleMacApp, buildMacEdgeReleasePreview } = require('../build-mac-chrome-preview.cjs');
const { buildMacEdgeReleaseBundle } = require('../build-mac-chrome-setup-bundle.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

test('Edge candidate layout binds the signed helpers and has its own application identity', () => {
    const helper = Buffer.from('lock'), identity = Buffer.from('identity'), peer = Buffer.from('peer');
    const args = { bundle: { 'MacSetup.cjs': Buffer.from('entry'), 'MacLevelDB.node': Buffer.from('addon') },
        runtime: Buffer.from('runtime'), launcher: Buffer.from('launcher'), helper, edgeIdentity: identity, edgePeer: peer,
        license: Buffer.from('node-license'), projectLicense: Buffer.from('project-license'), guide: Buffer.from('guide'), browser: 'edge' };
    const files = unzipSync(assembleMacApp(args)), root = 'X通知の準備.app/Contents/';
    const manifest = JSON.parse(Buffer.from(files[`${root}Resources/MacSetup-manifest.json`]).toString('utf8'));
    assert.equal(manifest.packageId, 'x-notification-mac-edge-setup'); assert.equal(manifest.version, '0.1.0-mac-edge-preview.1');
    assert.equal(manifest.lockSha256, hash(helper)); assert.equal(manifest.identitySha256, hash(identity)); assert.equal(manifest.peerSha256, hash(peer));
    assert.deepEqual(Buffer.from(files[`${root}MacOS/MacEdgeIdentity`]), identity);
    assert.deepEqual(Buffer.from(files[`${root}MacOS/MacEdgeSocketOwner`]), peer);
    assert(Buffer.from(files[`${root}Info.plist`]).toString('utf8').includes('jp.cbte.xnotification.edge-setup'));
    assert.throws(() => assembleMacApp({ ...args, edgePeer: undefined }), /Missing Edge helpers/);
});
test('Edge bundle is bounded and candidate refuses unverified executable inputs', async () => {
    const bundle = await buildMacEdgeReleaseBundle();
    assert(bundle['MacSetup.cjs'].length > 0 && bundle['MacSetup.cjs'].length < 4 * 1024 * 1024);
    assert(bundle['MacLevelDB.node'].length > 0 && bundle['MacDependencies-LICENSE.txt'].length > 0);
    await assert.rejects(buildMacEdgeReleasePreview({ arch: 'arm64', runtime: Buffer.from('bad'), launcher: Buffer.from('bad'),
        helper: Buffer.from('bad'), edgeIdentity: Buffer.from('bad'), edgePeer: Buffer.from('bad'), license: Buffer.from('bad') }), /input verification failed/);
});
