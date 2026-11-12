'use strict';

// Local app bootstrap. It keeps only its own dedicated setup data under an
// existing user-owned Application Support directory; it never discovers a
// normal browser profile or uploads a transfer file.
const fs = require('node:fs/promises');
const path = require('node:path');
const { getOrCreateMacChromeProfile } = require('./chrome-mac-profile-registry');
const { runMacChromeSetup } = require('./chrome-mac-setup-session');
const fail = code => Object.assign(new Error(code), { code });
const DATA_DIRECTORY = 'XNotificationSetup';

async function ensureMacSetupDirectory(applicationSupport) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function'
        || typeof applicationSupport !== 'string' || !path.isAbsolute(applicationSupport)) throw fail('X_CHROME_MAC_APP_INVALID');
    try {
        const parent = path.resolve(applicationSupport), parentStat = await fs.lstat(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid()
            || (parentStat.mode & 0o022) || await fs.realpath(parent) !== parent) throw fail('X_CHROME_MAC_APP_INVALID');
        const base = path.join(parent, DATA_DIRECTORY);
        try { await fs.mkdir(base, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        const info = await fs.lstat(base);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700
            || await fs.realpath(base) !== base) throw fail('X_CHROME_MAC_APP_INVALID');
        return base;
    } catch (error) {
        if (error?.code === 'X_CHROME_MAC_APP_INVALID') throw error;
        throw fail('X_CHROME_MAC_APP_INVALID');
    }
}
async function runMacChromeApp({ applicationSupport, helperPath, expectedSha256, ui }) {
    if (typeof helperPath !== 'string' || !path.isAbsolute(helperPath) || !/^[0-9a-f]{64}$/.test(expectedSha256))
        throw fail('X_CHROME_MAC_APP_INVALID');
    const base = await ensureMacSetupDirectory(applicationSupport), profile = await getOrCreateMacChromeProfile(base);
    return runMacChromeSetup({ rootPath: profile.rootPath, profileId: profile.profileId, helperPath, expectedSha256, ui });
}
module.exports = { ensureMacSetupDirectory, runMacChromeApp };
