'use strict';

// Experimental discovery for the installed stable Firefox only. This does
// not launch the app, inspect a browser profile, or read user notifications.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const APP = '/Applications/Firefox.app';
const EXECUTABLE = path.join(APP, 'Contents/MacOS/firefox');
const PLIST = path.join(APP, 'Contents/Info.plist');
// Apple password-manager-resources records this identifier and Mozilla team.
const REQUIREMENT = '=anchor apple generic and identifier "org.mozilla.firefox" and certificate leaf[subject.OU] = "43AQ936H96"';
const fail = code => Object.assign(new Error(code), { code });

async function verifyInstalledMacFirefox() {
    if (process.platform !== 'darwin') throw fail('X_FIREFOX_MAC_BROWSER_UNSUPPORTED');
    try {
        async function inspect(filename, kind) {
            const stat = await fs.lstat(filename);
            if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
                || await fs.realpath(filename) !== filename) throw new Error('invalid installation');
            return stat;
        }
        async function signature() {
            await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', REQUIREMENT, APP],
                { timeout: 30000, maxBuffer: 16384, windowsHide: true });
        }
        const paths = [[APP, 'directory'], [EXECUTABLE, 'file'], [PLIST, 'file']];
        const before = [];
        for (const [filename, kind] of paths) before.push(await inspect(filename, kind));
        await signature();
        const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', PLIST],
            { timeout: 10000, maxBuffer: 1024, windowsHide: true });
        const version = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
        if (!/^[0-9A-Za-z._+-]{1,64}$/.test(version)) throw new Error('invalid version');
        await signature();
        for (let i = 0; i < paths.length; i++) {
            const after = await inspect(paths[i][0], paths[i][1]), previous = before[i];
            if (after.dev !== previous.dev || after.ino !== previous.ino || after.size !== previous.size
                || after.mtimeMs !== previous.mtimeMs || after.ctimeMs !== previous.ctimeMs) throw new Error('installation changed');
        }
        return { executable: EXECUTABLE, version };
    } catch { throw fail('X_FIREFOX_MAC_BROWSER_INVALID'); }
}
module.exports = { verifyInstalledMacFirefox };
