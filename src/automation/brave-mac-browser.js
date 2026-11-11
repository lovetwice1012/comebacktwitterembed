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
        const beforeApp = await inspect(APP, true), beforeExe = await inspect(EXECUTABLE, false);
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', REQUIREMENT, APP],
            { timeout: 30000, maxBuffer: 16384, windowsHide: true });
        for (const [before, after] of [[beforeApp, await inspect(APP, true)], [beforeExe, await inspect(EXECUTABLE, false)]]) {
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('installation changed');
        }
        return EXECUTABLE;
    } catch { throw fail('X_BRAVE_MAC_BROWSER_INVALID'); }
}
module.exports = { verifyInstalledMacBrave };
