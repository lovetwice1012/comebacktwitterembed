'use strict';

// Builds an unsigned, architecture-specific preview. Signing, notarization,
// native Mac testing and publication are separate release gates.
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { zipSync } = require('fflate');
const { buildMacChromeBundle } = require('./build-mac-chrome-setup-bundle.cjs');
const VERSION = '0.1.0-mac-preview.1';
const RUNTIME_HASH = Object.freeze({ arm64: 'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79f',
    x64: '7abcf39bd37ab251015337ff75304d7555f0d8e88c6e0fbf04bce8ce34636f49' });
const LICENSE_HASH = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
const APP = 'X通知の準備.app/Contents/';
const hash = data => createHash('sha256').update(data).digest('hex');
const LAUNCH = `#!/bin/sh\nset -eu\nunset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED DYLD_INSERT_LIBRARIES\ncase "$0" in */*) APP_DIRECTORY=\u0024{0%/*} ;; *) exit 1 ;; esac\nAPP_DIRECTORY=$(CDPATH= cd -P "$APP_DIRECTORY" && pwd -P)\nexec "$APP_DIRECTORY/MacNode" "$APP_DIRECTORY/MacSetup.cjs"\n`;
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleDisplayName</key><string>X通知の準備</string>\n<key>CFBundleName</key><string>X通知の準備</string>\n<key>CFBundleIdentifier</key><string>jp.cbte.xnotification.setup</string>\n<key>CFBundleExecutable</key><string>Launch</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>0.1.0</string>\n<key>CFBundleVersion</key><string>1</string>\n</dict></plist>\n`;

function isMachOExecutable(bytes, arch) {
    return ['arm64', 'x64'].includes(arch) && Buffer.isBuffer(bytes) && bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf
        && bytes.readUInt32LE(4) === (arch === 'arm64' ? 0x0100000c : 0x01000007) && bytes.readUInt32LE(12) === 2;
}
// Pure layout helper; the public preview builder verifies all executable inputs
// before calling it. It is not a signing or release operation.
function assembleMacApp({ bundle, runtime, helper, license }) {
    const manifest = Buffer.from(JSON.stringify({ packageId: 'x-notification-mac-chrome-setup', version: VERSION, lockSha256: hash(helper) }) + '\n');
    const contents = { [`${APP}Info.plist`]: [Buffer.from(PLIST), false], [`${APP}MacOS/Launch`]: [Buffer.from(LAUNCH), true],
        [`${APP}MacOS/MacNode`]: [runtime, true], [`${APP}MacOS/MacStoreLock`]: [helper, true],
        [`${APP}MacOS/MacSetup-manifest.json`]: [manifest, false], [`${APP}MacOS/Node-LICENSE.txt`]: [license, false] };
    for (const [name, data] of Object.entries(bundle)) contents[`${APP}MacOS/${name}`] = [data, false];
    const entries = Object.fromEntries(Object.entries(contents).map(([name, [data, executable]]) => [name,
        [data, { mtime: new Date('2020-01-01T00:00:00Z'), os: 3, attrs: ((executable ? 0o100755 : 0o100644) << 16) >>> 0 }]]));
    return Buffer.from(zipSync(entries, { level: 6 }));
}
async function buildMacChromePreview({ arch, runtime, helper, license }) {
    if (!['arm64', 'x64'].includes(arch) || !Buffer.isBuffer(runtime) || !Buffer.isBuffer(helper) || !Buffer.isBuffer(license)
        || runtime.length > 150 * 1024 * 1024 || helper.length > 4 * 1024 * 1024 || license.length > 1024 * 1024
        || hash(runtime) !== RUNTIME_HASH[arch] || hash(license) !== LICENSE_HASH
        || !isMachOExecutable(runtime, arch) || !isMachOExecutable(helper, arch)) throw new Error('Mac preview input verification failed');
    const bundle = await buildMacChromeBundle();
    const archive = assembleMacApp({ bundle, runtime, helper, license });
    return { archive, sha256: hash(archive), version: VERSION, arch, signed: false };
}
async function readInput(filename, max) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Input must be absolute');
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > max) throw new Error('Invalid preview input');
    const handle = await fs.open(filename, 'r');
    try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.size !== stat.size || actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('Preview input changed');
        const data = await handle.readFile();
        if (data.length !== stat.size) throw new Error('Preview input changed');
        return data;
    } finally { await handle.close(); }
}
async function main(args) {
    if (args.length !== 5) throw new Error('Expected arch, Node executable, lock helper, Node license, output ZIP');
    const [arch, runtimePath, helperPath, licensePath, outputPath] = args;
    if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.zip') throw new Error('Output must be an absolute ZIP path');
    const [runtime, helper, license] = await Promise.all([readInput(runtimePath, 150 * 1024 * 1024),
        readInput(helperPath, 4 * 1024 * 1024), readInput(licensePath, 1024 * 1024)]);
    const result = await buildMacChromePreview({ arch, runtime, helper, license });
    await fs.writeFile(outputPath, result.archive, { flag: 'wx' });
    await fs.writeFile(`${outputPath}.sha256`, `${result.sha256}  ${path.basename(outputPath)}\n`, { flag: 'wx' });
    process.stdout.write(JSON.stringify({ path: outputPath, sha256: result.sha256, arch, version: VERSION, signed: false }) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('Mac preview build failed. No release was published.\n'); process.exitCode = 1; });
module.exports = { assembleMacApp, buildMacChromePreview, isMachOExecutable, RUNTIME_HASH, LICENSE_HASH };
