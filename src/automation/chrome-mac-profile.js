'use strict';

// Creates and verifies only a new tool-owned profile directory. Browser
// launching, termination, ACL verification and snapshotting belong to the
// calling Mac setup app. Never scan or modify an existing browser profile.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { parseUniqueJson } = require('./strict-json');
const fail = code => Object.assign(new Error(code), { code });
const APP_ID = 'x-notification-setup';
const BROWSERS = Object.freeze({ chrome: { prefix: 'x-notification-setup-', folder: 'chrome-profile' },
    edge: { prefix: 'x-notification-edge-', folder: 'edge-profile' },
    firefox: { prefix: 'x-notification-firefox-', folder: 'firefox-profile' } });
function requirePosix() {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW)
        throw fail('X_CHROME_MAC_PROFILE_UNSUPPORTED');
}
function isPrivateDirectory(stat) {
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700;
}
async function verifyMacBrowserProfile(root, expectedProfileId, browser) {
    requirePosix();
    try {
        const selected = Object.hasOwn(BROWSERS, browser) ? BROWSERS[browser] : null;
        if (!selected || typeof root !== 'string' || !path.isAbsolute(root)
            || !new RegExp(`^${selected.prefix}[0-9a-f]{32}$`).test(path.basename(root))
            || typeof expectedProfileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expectedProfileId)) throw fail('X_CHROME_MAC_PROFILE_INVALID');
        const expected = path.resolve(root), real = await fs.realpath(expected), rootStat = await fs.lstat(expected);
        if (real !== expected || !isPrivateDirectory(rootStat)) throw fail('X_CHROME_MAC_PROFILE_INVALID');
        const profilePath = path.join(expected, selected.folder), profileStat = await fs.lstat(profilePath);
        if (!isPrivateDirectory(profileStat) || await fs.realpath(profilePath) !== profilePath) throw fail('X_CHROME_MAC_PROFILE_INVALID');
        const handle = await fs.open(path.join(expected, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let value;
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096)
                throw fail('X_CHROME_MAC_PROFILE_INVALID');
            value = parseUniqueJson(await handle.readFile('utf8'), 8);
        } finally { await handle.close(); }
        if (!value || Object.keys(value).sort().join(',') !== 'appId,profileId,profilePath,rootPath,schemaVersion'
            || value.schemaVersion !== 1 || value.appId !== APP_ID || value.rootPath !== expected || value.profilePath !== profilePath
            || value.profileId !== expectedProfileId)
            throw fail('X_CHROME_MAC_PROFILE_INVALID');
        return { rootPath: expected, profilePath, profileId: value.profileId };
    } catch (error) {
        if (error?.code === 'X_CHROME_MAC_PROFILE_UNSUPPORTED') throw error;
        throw fail('X_CHROME_MAC_PROFILE_INVALID');
    }
}
async function createMacBrowserProfile(parent, browser) {
    requirePosix();
    const selected = Object.hasOwn(BROWSERS, browser) ? BROWSERS[browser] : null;
    if (!selected || typeof parent !== 'string' || !path.isAbsolute(parent)) throw fail('X_CHROME_MAC_PROFILE_INVALID');
    let root, profile, marker, handle, rootStat, profileStat, markerStat;
    let createdRoot = false, createdProfile = false, createdMarker = false;
    async function removeCreated(name, expected, remove) {
        const current = await fs.lstat(name);
        if (!expected || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error('created entry changed');
        await remove(name);
    }
    try {
        const base = await fs.realpath(parent), parentStat = await fs.stat(base);
        if (!parentStat.isDirectory() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o022)) throw fail('X_CHROME_MAC_PROFILE_INVALID');
        root = path.join(base, selected.prefix + randomBytes(16).toString('hex'));
        profile = path.join(root, selected.folder); marker = path.join(root, 'owner.json');
        await fs.mkdir(root, { mode: 0o700 }); createdRoot = true; rootStat = await fs.lstat(root);
        await fs.mkdir(profile, { mode: 0o700 }); createdProfile = true; profileStat = await fs.lstat(profile);
        handle = await fs.open(marker, 'wx', 0o600); createdMarker = true; markerStat = await handle.stat();
        const owner = { schemaVersion: 1, appId: APP_ID, profileId: randomUUID(), rootPath: root, profilePath: profile };
        await handle.writeFile(JSON.stringify(owner)); await handle.sync(); await handle.close(); handle = null;
        return await verifyMacBrowserProfile(root, owner.profileId, browser);
    } catch {
        let cleanupFailed = false;
        try { await handle?.close(); } catch { cleanupFailed = true; }
        // Remove only names created by this invocation; never recurse into an
        // existing or subsequently populated browser profile.
        if (createdMarker) try { await removeCreated(marker, markerStat, fs.unlink); } catch { cleanupFailed = true; }
        if (createdProfile) try { await removeCreated(profile, profileStat, fs.rmdir); } catch { cleanupFailed = true; }
        if (createdRoot) try { await removeCreated(root, rootStat, fs.rmdir); } catch { cleanupFailed = true; }
        throw fail(cleanupFailed ? 'X_CHROME_MAC_PROFILE_CLEANUP_FAILED' : 'X_CHROME_MAC_PROFILE_INVALID');
    }
}
const createMacChromeProfile = parent => createMacBrowserProfile(parent, 'chrome');
const verifyMacChromeProfile = (root, id) => verifyMacBrowserProfile(root, id, 'chrome');
const createMacEdgeProfile = parent => createMacBrowserProfile(parent, 'edge');
const verifyMacEdgeProfile = (root, id) => verifyMacBrowserProfile(root, id, 'edge');
const createMacFirefoxProfile = parent => createMacBrowserProfile(parent, 'firefox');
const verifyMacFirefoxProfile = (root, id) => verifyMacBrowserProfile(root, id, 'firefox');
module.exports = { createMacChromeProfile, verifyMacChromeProfile, createMacEdgeProfile, verifyMacEdgeProfile,
    createMacFirefoxProfile, verifyMacFirefoxProfile };
