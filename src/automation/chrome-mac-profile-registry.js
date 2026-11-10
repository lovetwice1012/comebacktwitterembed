'use strict';

// Persists only the identity of a tool-created profile in a private directory.
// It never searches the user's ordinary browser profiles or removes data.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseUniqueJson } = require('./strict-json');
const { createMacChromeProfile, verifyMacChromeProfile } = require('./chrome-mac-profile');
const fail = code => Object.assign(new Error(code), { code });

async function getOrCreateMacChromeProfile(directory) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || typeof directory !== 'string' || !path.isAbsolute(directory))
        throw fail('X_CHROME_MAC_REGISTRY_INVALID');
    let lock, lockStat, temporary, tempStat;
    const base = path.resolve(directory), index = path.join(base, 'setup-profile.json'), lockPath = path.join(base, 'registry.lock');
    async function unlinkOwned(filename, expected) {
        const stat = await fs.lstat(filename);
        if (!expected || stat.dev !== expected.dev || stat.ino !== expected.ino) throw fail('X_CHROME_MAC_REGISTRY_CLEANUP_FAILED');
        await fs.unlink(filename);
    }
    try {
        const info = await fs.lstat(base);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700
            || await fs.realpath(base) !== base) throw fail('X_CHROME_MAC_REGISTRY_INVALID');
        try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
            if (error?.code === 'EEXIST') throw fail('X_CHROME_MAC_REGISTRY_BUSY'); throw error;
        }
        lockStat = await lock.stat();
        if (!lockStat.isFile() || lockStat.uid !== process.getuid() || (lockStat.mode & 0o777) !== 0o600 || lockStat.nlink !== 1)
            throw fail('X_CHROME_MAC_REGISTRY_INVALID');
        let record, indexRead = false;
        try {
            const handle = await fs.open(index, constants.O_RDONLY | constants.O_NOFOLLOW);
            indexRead = true;
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096)
                    throw fail('X_CHROME_MAC_REGISTRY_INVALID');
                record = parseUniqueJson(await handle.readFile('utf8'), 8);
            } finally { await handle.close(); }
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (indexRead) {
            if (!record || typeof record !== 'object' || Array.isArray(record)
                || Object.keys(record).sort().join(',') !== 'profileId,rootPath' || typeof record.rootPath !== 'string'
                || path.dirname(record.rootPath) !== base) throw fail('X_CHROME_MAC_REGISTRY_INVALID');
            return await verifyMacChromeProfile(record.rootPath, record.profileId);
        }
        // A missing index with an existing tool-created root can be the result
        // of an interrupted write. Never silently replace or delete it.
        if ((await fs.readdir(base)).some(name => /^x-notification-setup-[0-9a-f]{32}$/.test(name)))
            throw fail('X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED');
        const profile = await createMacChromeProfile(base);
        temporary = path.join(base, `.setup-profile-${randomBytes(16).toString('hex')}.tmp`);
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
            tempStat = await handle.stat();
            if (!tempStat.isFile() || tempStat.uid !== process.getuid() || (tempStat.mode & 0o777) !== 0o600 || tempStat.nlink !== 1)
                throw fail('X_CHROME_MAC_REGISTRY_INVALID');
            await handle.writeFile(JSON.stringify({ rootPath: profile.rootPath, profileId: profile.profileId })); await handle.sync();
        } finally { await handle.close(); }
        await fs.link(temporary, index);
        return profile;
    } catch (error) {
        if (/^X_CHROME_MAC_(?:REGISTRY|PROFILE)_[A-Z_]+$/.test(error?.code || '')) throw error;
        throw fail('X_CHROME_MAC_REGISTRY_INVALID');
    } finally {
        let cleanupFailed = false;
        if (temporary && tempStat) {
            try { await unlinkOwned(temporary, tempStat); } catch { cleanupFailed = true; }
        }
        if (lock) {
            try { await unlinkOwned(lockPath, lockStat); } catch { cleanupFailed = true; }
            finally { await lock.close().catch(() => { cleanupFailed = true; }); }
        }
        if (cleanupFailed) throw fail('X_CHROME_MAC_REGISTRY_CLEANUP_FAILED');
    }
}
module.exports = { getOrCreateMacChromeProfile };
