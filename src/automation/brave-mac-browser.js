'use strict';

// Experimental stable Brave discovery. It does not launch the browser or
// inspect any ordinary browser profile or Keychain item.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const APP = '/Applications/Brave Browser.app';
const EXECUTABLE = path.join(APP, 'Contents/MacOS/Brave Browser');
const PLIST = path.join(APP, 'Contents/Info.plist');
// Identifier and signing team match Apple's published browser information.
const REQUIREMENT = '=anchor apple generic and identifier "com.brave.Browser" and certificate leaf[subject.OU] = "KL8N8XSYF4"';
const fail = code => Object.assign(new Error(code), { code });

async function verifyInstalledMacBrave() {
    if (process.platform !== 'darwin') throw fail('X_BRAVE_MAC_BROWSER_UNSUPPORTED');
    try {
        async function inspect(filename, isApp) {
            const stat = await fs.lstat(filename);
            if (stat.isSymbolicLink() || (isApp ? !stat.isDirectory() : !stat.isFile())
                || await fs.realpath(filename) !== filename) throw new Error('invalid installation');
            return stat;
        }
        const beforeApp = await inspect(APP, true), beforeExe = await inspect(EXECUTABLE, false), beforePlist = await inspect(PLIST, false);
        async function verifySignature() {
            await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', REQUIREMENT, APP],
                { timeout: 30000, maxBuffer: 16384, windowsHide: true });
        }
        await verifySignature();
        const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', PLIST],
            { timeout: 10000, maxBuffer: 1024, windowsHide: true });
        const browserVersion = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
        if (!/^[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/.test(browserVersion)) throw new Error('invalid version');
        await verifySignature();
        for (const [before, after] of [[beforeApp, await inspect(APP, true)], [beforeExe, await inspect(EXECUTABLE, false)], [beforePlist, await inspect(PLIST, false)]]) {
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('installation changed');
        }
        return Object.freeze({ executable: EXECUTABLE, browserVersion });
    } catch { throw fail('X_BRAVE_MAC_BROWSER_INVALID'); }
}
module.exports = { verifyInstalledMacBrave };
