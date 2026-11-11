'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync } = require('fflate');
const { assembleMacApp, buildMacChromePreview, buildMacBravePreview, isMachOExecutable } = require('../build-mac-chrome-preview.cjs');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function macho(cpu, min = 0x000d0500) {
    const value = Buffer.alloc(56); value.writeUInt32LE(0xfeedfacf, 0); value.writeUInt32LE(cpu, 4); value.writeUInt32LE(2, 12);
    value.writeUInt32LE(1, 16); value.writeUInt32LE(24, 20); value.writeUInt32LE(0x32, 32); value.writeUInt32LE(24, 36);
    value.writeUInt32LE(1, 40); value.writeUInt32LE(min, 44); return value;
}
test('unsigned Mac preview layout preserves executable permissions and local manifest', async () => {
    const runtime = macho(0x0100000c), helper = macho(0x0100000c), bundle = { 'MacSetup.cjs': Buffer.from('fixture'), 'MacLevelDB.node': Buffer.from('fixture') };
    const zip = assembleMacApp({ bundle, runtime, helper, license: Buffer.from('test license'),
        projectLicense: Buffer.from('project license'), guide: Buffer.from('test guide') }), files = unzipSync(zip);
    const root = 'X通知の準備.app/Contents/', manifest = JSON.parse(Buffer.from(files[`${root}MacOS/MacSetup-manifest.json`]).toString());
    assert(Buffer.from(files[`${root}Info.plist`]).toString().includes('<key>LSMinimumSystemVersion</key><string>13.5</string>'));
    assert.equal(manifest.packageId, 'x-notification-mac-chrome-setup');
    assert.equal(manifest.lockSha256, createHash('sha256').update(helper).digest('hex'));
    assert.equal(Buffer.from(files['はじめに.txt']).toString(), 'test guide');
    assert.equal(Buffer.from(files[`${root}MacOS/LICENSE.txt`]).toString(), 'project license');
    const launch = Buffer.from(files[`${root}MacOS/Launch`]).toString();
    assert(launch.includes('MacNode')); assert(launch.includes('MacSetup.cjs')); assert(launch.includes('unset NODE_OPTIONS'));
    const modes = {};
    for (let pos = 0; pos < zip.length - 46; pos++) {
        if (zip.readUInt32LE(pos) !== 0x02014b50) continue;
        const length = zip.readUInt16LE(pos + 28), extra = zip.readUInt16LE(pos + 30), comment = zip.readUInt16LE(pos + 32);
        const name = zip.subarray(pos + 46, pos + 46 + length).toString('utf8');
        modes[name] = zip.readUInt32LE(pos + 38) >>> 16; pos += 45 + length + extra + comment;
    }
    for (const name of ['Launch', 'MacNode', 'MacStoreLock']) assert.equal(modes[`${root}MacOS/${name}`], 0o100755);
    assert.equal(modes[`${root}MacOS/MacSetup.cjs`], 0o100644);
    assert(isMachOExecutable(runtime, 'arm64')); assert(!isMachOExecutable(runtime, 'x64'));
    assert(!isMachOExecutable(macho(0x0100000c, 0x000e0000), 'arm64'));
    assert(!isMachOExecutable(runtime.subarray(0, 40), 'arm64'));
    await assert.rejects(buildMacChromePreview({ arch: 'arm64', runtime, helper, license: Buffer.from('test license') }), /input verification failed/);
});
test('experimental Brave preview uses its own identity and rejects unverified inputs', async () => {
    const runtime = macho(0x0100000c), helper = macho(0x0100000c), bundle = { 'MacSetup.cjs': Buffer.from('fixture') };
    const args = { bundle, runtime, helper, license: Buffer.from('test'), projectLicense: Buffer.from('project'), guide: Buffer.from('internal preview') };
    const files = unzipSync(assembleMacApp({ ...args, browser: 'brave' })), root = 'X通知の準備.app/Contents/';
    const manifest = JSON.parse(Buffer.from(files[`${root}MacOS/MacSetup-manifest.json`]).toString());
    assert.equal(manifest.packageId, 'x-notification-mac-brave-setup'); assert.equal(manifest.version, '0.1.0-mac-brave-preview.1');
    assert.equal(manifest.lockSha256, createHash('sha256').update(helper).digest('hex'));
    assert(Buffer.from(files[`${root}Info.plist`]).toString().includes('jp.cbte.xnotification.brave-setup'));
    assert.throws(() => assembleMacApp({ ...args, browser: 'other' }), /Unsupported Mac preview/);
    await assert.rejects(buildMacBravePreview({ arch: 'arm64', runtime, helper, license: Buffer.from('test') }), /input verification failed/);
});
test('preview CLI refuses unverified binaries without creating output', async t => {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-mac-preview-test-'));
    t.after(async () => {
        const real = await fs.realpath(root); assert.equal(path.dirname(real).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(real), /^cbte-mac-preview-test-/); await fs.rm(real, { recursive: true });
    });
    const runtime = path.join(root, 'node'), helper = path.join(root, 'helper'), license = path.join(root, 'license'), output = path.join(root, 'preview.zip');
    await fs.writeFile(runtime, macho(0x0100000c)); await fs.writeFile(helper, macho(0x0100000c)); await fs.writeFile(license, 'not the Node license');
    const child = spawnSync(process.execPath, [path.join(__dirname, '../build-mac-chrome-preview.cjs'), 'arm64', runtime, helper, license, output],
        { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(child.status, 0); assert(!child.stderr.includes(root));
    await assert.rejects(fs.access(output), { code: 'ENOENT' }); await assert.rejects(fs.access(`${output}.sha256`), { code: 'ENOENT' });
});
