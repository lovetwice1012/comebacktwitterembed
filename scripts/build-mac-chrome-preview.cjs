'use strict';

// Builds an unsigned, architecture-specific preview. Signing, notarization,
// native Mac testing and publication are separate release gates.
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { zipSync } = require('fflate');
const { buildMacChromeBundle, buildMacBraveBundle, buildMacFirefoxBundle } = require('./build-mac-chrome-setup-bundle.cjs');
const { isMacExecutable: isMachOExecutable, isRestrictedMacExecutable } = require('./lib/mac-macho.cjs');
const VERSION = '0.1.0-mac-preview.1';
const BRAVE_VERSION = '0.1.0-mac-brave-preview.1';
const FIREFOX_VERSION = '0.1.0-mac-firefox-preview.1';
const RUNTIME_HASH = Object.freeze({ arm64: 'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b',
    x64: '7abcf39bd37ab251015337ff75304d7555f0d8e88c6e0fbf04bce8ce34636f49' });
const LICENSE_HASH = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
const APP = 'X通知の準備.app/Contents/';
const hash = data => createHash('sha256').update(data).digest('hex');
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleDisplayName</key><string>X通知の準備</string>\n<key>CFBundleName</key><string>X通知の準備</string>\n<key>CFBundleIdentifier</key><string>jp.cbte.xnotification.setup</string>\n<key>CFBundleExecutable</key><string>Launch</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>0.1.0</string>\n<key>CFBundleVersion</key><string>1</string>\n<key>LSMinimumSystemVersion</key><string>13.5</string>\n</dict></plist>\n`;

// Pure layout helper; the public preview builder verifies all executable inputs
// before calling it. It is not a signing or release operation.
function assembleMacApp({ bundle, runtime, launcher, helper, license, projectLicense, guide, browser = 'chrome', firefoxBootstrap, firefoxReader }) {
    if (!['chrome', 'brave', 'firefox'].includes(browser)) throw new Error('Unsupported Mac preview');
    if (!Buffer.isBuffer(launcher) || !launcher.length || !Buffer.isBuffer(projectLicense) || !projectLicense.length || !Buffer.isBuffer(guide) || !guide.length)
        throw new Error('Missing preview documentation');
    if (browser === 'firefox' && (!Buffer.isBuffer(firefoxBootstrap) || !firefoxBootstrap.length || !Buffer.isBuffer(firefoxReader) || !firefoxReader.length))
        throw new Error('Missing Firefox readers');
    const manifest = Buffer.from(JSON.stringify({ packageId: browser === 'brave' ? 'x-notification-mac-brave-setup'
        : browser === 'firefox' ? 'x-notification-mac-firefox-setup' : 'x-notification-mac-chrome-setup',
    version: browser === 'brave' ? BRAVE_VERSION : browser === 'firefox' ? FIREFOX_VERSION : VERSION, lockSha256: hash(helper),
    ...(browser === 'firefox' ? { bootstrapSha256: hash(firefoxBootstrap), readerSha256: hash(firefoxReader) } : {}) }) + '\n');
    const plist = browser === 'brave' ? PLIST.replace('jp.cbte.xnotification.setup', 'jp.cbte.xnotification.brave-setup')
        : browser === 'firefox' ? PLIST.replace('jp.cbte.xnotification.setup', 'jp.cbte.xnotification.firefox-setup') : PLIST;
    const contents = { [`${APP}Info.plist`]: [Buffer.from(plist), false], [`${APP}MacOS/Launch`]: [launcher, true],
        [`${APP}MacOS/MacNode`]: [runtime, true], [`${APP}MacOS/MacStoreLock`]: [helper, true],
        [`${APP}Resources/MacSetup-manifest.json`]: [manifest, false], [`${APP}Resources/Node-LICENSE.txt`]: [license, false],
        [`${APP}Resources/LICENSE.txt`]: [projectLicense, false], 'はじめに.txt': [guide, false] };
    for (const [name, data] of Object.entries(bundle)) contents[`${APP}${name === 'MacLevelDB.node' ? 'MacOS' : 'Resources'}/${name}`] = [data, false];
    if (browser === 'firefox') {
        contents[`${APP}Resources/FirefoxXPCShellReader.js`] = [firefoxBootstrap, false];
        contents[`${APP}Resources/Read-PushSubscription.js`] = [firefoxReader, false];
    }
    const entries = Object.fromEntries(Object.entries(contents).map(([name, [data, executable]]) => [name,
        [data, { mtime: new Date('2020-01-01T00:00:00Z'), os: 3, attrs: ((executable ? 0o100755 : 0o100644) << 16) >>> 0 }]]));
    return Buffer.from(zipSync(entries, { level: 6 }));
}
async function buildMacPreview({ arch, runtime, launcher, helper, license, browser }) {
    if (!['arm64', 'x64'].includes(arch) || !Buffer.isBuffer(runtime) || !Buffer.isBuffer(launcher) || !Buffer.isBuffer(helper) || !Buffer.isBuffer(license)
        || runtime.length > 150 * 1024 * 1024 || launcher.length > 4 * 1024 * 1024 || helper.length > 4 * 1024 * 1024 || license.length > 1024 * 1024
        || hash(runtime) !== RUNTIME_HASH[arch] || hash(license) !== LICENSE_HASH
        || !isMachOExecutable(runtime, arch) || !isRestrictedMacExecutable(launcher, arch) || !isMachOExecutable(helper, arch)) throw new Error('Mac preview input verification failed');
    if (!['chrome', 'brave', 'firefox'].includes(browser)) throw new Error('Unsupported Mac preview');
    const [bundle, projectLicense, guide, firefoxBootstrap, firefoxReader] = await Promise.all([
        browser === 'brave' ? buildMacBraveBundle() : browser === 'firefox' ? buildMacFirefoxBundle() : buildMacChromeBundle(),
        readInput(path.resolve(__dirname, '../client/angelic-setup/LICENSE'), 1024 * 1024),
        readInput(path.resolve(__dirname, browser === 'brave' ? '../client/angelic-setup/mac/Brave-試験用.txt'
            : browser === 'firefox' ? '../client/angelic-setup/mac/Firefox-試験用.txt' : '../client/angelic-setup/mac/はじめに.txt'), 64 * 1024),
        browser === 'firefox' ? readInput(path.resolve(__dirname, '../client/angelic-setup/mac/FirefoxXPCShellReader.js'), 1024 * 1024) : null,
        browser === 'firefox' ? readInput(path.resolve(__dirname, '../client/angelic-setup/Read-PushSubscription.js'), 1024 * 1024) : null]);
    const archive = assembleMacApp({ bundle, runtime, launcher, helper, license, projectLicense, guide, browser, firefoxBootstrap, firefoxReader });
    return { archive, sha256: hash(archive), version: browser === 'brave' ? BRAVE_VERSION : browser === 'firefox' ? FIREFOX_VERSION : VERSION, arch, signed: false };
}
const buildMacChromePreview = options => buildMacPreview({ ...options, browser: 'chrome' });
const buildMacBravePreview = options => buildMacPreview({ ...options, browser: 'brave' });
const buildMacFirefoxPreview = options => buildMacPreview({ ...options, browser: 'firefox' });
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
    if (args.length !== 6) throw new Error('Expected arch, Node executable, launcher, lock helper, Node license, output ZIP');
    const [arch, runtimePath, launcherPath, helperPath, licensePath, outputPath] = args;
    if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.zip') throw new Error('Output must be an absolute ZIP path');
    const [runtime, launcher, helper, license] = await Promise.all([readInput(runtimePath, 150 * 1024 * 1024), readInput(launcherPath, 4 * 1024 * 1024),
        readInput(helperPath, 4 * 1024 * 1024), readInput(licensePath, 1024 * 1024)]);
    const result = await buildMacChromePreview({ arch, runtime, launcher, helper, license });
    await fs.writeFile(outputPath, result.archive, { flag: 'wx' });
    await fs.writeFile(`${outputPath}.sha256`, `${result.sha256}  ${path.basename(outputPath)}\n`, { flag: 'wx' });
    process.stdout.write(JSON.stringify({ path: outputPath, sha256: result.sha256, arch, version: VERSION, signed: false }) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('Mac preview build failed. No release was published.\n'); process.exitCode = 1; });
module.exports = { assembleMacApp, buildMacChromePreview, buildMacBravePreview, buildMacFirefoxPreview, readInput, isMachOExecutable, RUNTIME_HASH, LICENSE_HASH };
