'use strict';

// Experimental signed-app version inspection. This does not launch Edge or
// access any browser profile. Actual macOS behavior remains unverified.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyInstalledEdge } = require('./edge-mac-broker');
const run = promisify(execFile);
const APP = '/Applications/Microsoft Edge.app';
const EXECUTABLE = path.join(APP, 'Contents/MacOS/Microsoft Edge');
const PLIST = path.join(APP, 'Contents/Info.plist');
const fail = () => Object.assign(new Error('X_EDGE_MAC_BROWSER_INVALID'), { code: 'X_EDGE_MAC_BROWSER_INVALID' });

async function readVerifiedMacEdgeVersion() {
    try {
        if (await verifyInstalledEdge() !== EXECUTABLE) throw new Error('invalid executable');
        async function inspect() {
            const info = await fs.lstat(PLIST);
            if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(PLIST) !== PLIST) throw new Error('invalid plist');
            return info;
        }
        const before = await inspect();
        const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', PLIST],
            { timeout: 10000, maxBuffer: 1024, windowsHide: true });
        const browserVersion = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
        if (!/^[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/.test(browserVersion)) throw new Error('invalid version');
        if (await verifyInstalledEdge() !== EXECUTABLE) throw new Error('invalid executable');
        const after = await inspect();
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('installation changed');
        return Object.freeze({ executable: EXECUTABLE, browserVersion });
    } catch { throw fail(); }
}
module.exports = { readVerifiedMacEdgeVersion };
