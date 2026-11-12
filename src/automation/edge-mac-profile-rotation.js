'use strict';

// Explicit recovery only. Old profile and index backup are always retained.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseUniqueJson } = require('./strict-json');
const { createMacEdgeProfile, verifyMacEdgeProfile } = require('./chrome-mac-profile');
const { acquireMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
const fail = code => Object.assign(new Error(code), { code });

async function syncPrivateDirectory(directory) {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat(), named = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
            || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino
            || await fs.realpath(directory) !== directory) throw fail('X_EDGE_MAC_ROTATION_INVALID');
        await handle.sync();
    } finally { await handle.close(); }
}

async function rotateMacEdgeProfile({ directory, oldProfile, confirmed }) {
    if (confirmed !== true || process.platform === 'win32' || typeof process.getuid !== 'function'
        || typeof directory !== 'string' || !path.isAbsolute(directory) || !oldProfile
        || path.dirname(oldProfile.rootPath || '') !== directory) throw fail('X_EDGE_MAC_ROTATION_INVALID');
    const index = path.join(directory, 'edge-setup-profile.json'), lockPath = path.join(directory, 'edge-registry.lock');
    let lock, lockStat, lease;
    try {
        const base = await fs.lstat(directory);
        if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== process.getuid() || (base.mode & 0o777) !== 0o700
            || await fs.realpath(directory) !== directory) throw fail('X_EDGE_MAC_ROTATION_INVALID');
        try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
            if (error?.code === 'EEXIST') throw fail('X_CHROME_MAC_REGISTRY_BUSY'); throw error;
        }
        lockStat = await lock.stat();
        if (!lockStat.isFile() || lockStat.uid !== process.getuid() || (lockStat.mode & 0o777) !== 0o600 || lockStat.nlink !== 1)
            throw fail('X_EDGE_MAC_ROTATION_INVALID');
        const indexHandle = await fs.open(index, constants.O_RDONLY | constants.O_NOFOLLOW);
        let previous, identity;
        try {
            identity = await indexHandle.stat();
            if (!identity.isFile() || identity.uid !== process.getuid() || (identity.mode & 0o777) !== 0o600
                || identity.nlink !== 1 || identity.size < 1 || identity.size > 4096) throw fail('X_EDGE_MAC_ROTATION_INVALID');
            previous = await indexHandle.readFile('utf8');
        } finally { await indexHandle.close(); }
        const record = parseUniqueJson(previous, 8);
        if (!record || Object.keys(record).sort().join(',') !== 'profileId,rootPath'
            || record.rootPath !== oldProfile.rootPath || record.profileId !== oldProfile.profileId) throw fail('X_EDGE_MAC_ROTATION_INVALID');
        await verifyMacEdgeProfile(record.rootPath, record.profileId);
        lease = await acquireMacProfileLease({ rootPath: record.rootPath, profileId: record.profileId, browser: 'edge' });
        const backup = path.join(directory, `edge-setup-profile-backup-${randomBytes(16).toString('hex')}.json`);
        const backupHandle = await fs.open(backup, 'wx', 0o600);
        let backupIdentity;
        try { await backupHandle.writeFile(previous); await backupHandle.sync(); backupIdentity = await backupHandle.stat(); }
        finally { await backupHandle.close(); }
        await syncPrivateDirectory(directory);
        const profile = await createMacEdgeProfile(directory);
        // Make the profile's own entries durable before publishing its index.
        await syncPrivateDirectory(profile.profilePath);
        await syncPrivateDirectory(profile.rootPath);
        await syncPrivateDirectory(directory);
        const temporary = path.join(directory, `.edge-setup-profile-rotation-${randomBytes(16).toString('hex')}.tmp`);
        const tempHandle = await fs.open(temporary, 'wx', 0o600);
        const nextRecord = JSON.stringify({ rootPath: profile.rootPath, profileId: profile.profileId }); let tempIdentity;
        try { await tempHandle.writeFile(nextRecord); await tempHandle.sync(); tempIdentity = await tempHandle.stat(); }
        finally { await tempHandle.close(); }
        const current = await fs.lstat(index);
        if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.nlink !== 1
            || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs) throw fail('X_EDGE_MAC_ROTATION_INVALID');
        const checkBackup = await fs.open(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await checkBackup.stat();
            if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1
                || stat.dev !== backupIdentity.dev || stat.ino !== backupIdentity.ino || stat.size !== identity.size
                || await checkBackup.readFile('utf8') !== previous) throw fail('X_EDGE_MAC_ROTATION_INVALID');
            const named = await fs.lstat(backup);
            if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino || named.nlink !== 1)
                throw fail('X_EDGE_MAC_ROTATION_INVALID');
        } finally { await checkBackup.close(); }
        const checkTemp = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await checkTemp.stat();
            if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1
                || stat.dev !== tempIdentity.dev || stat.ino !== tempIdentity.ino || stat.size !== Buffer.byteLength(nextRecord)
                || await checkTemp.readFile('utf8') !== nextRecord) throw fail('X_EDGE_MAC_ROTATION_INVALID');
            const named = await fs.lstat(temporary);
            if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino || named.nlink !== 1)
                throw fail('X_EDGE_MAC_ROTATION_INVALID');
        } finally { await checkTemp.close(); }
        await fs.rename(temporary, index);
        // Durability of the backup and the new index precedes reporting success.
        await syncPrivateDirectory(directory);
        return profile;
    } catch (error) {
        if (/^X_(?:EDGE_MAC_ROTATION|CHROME_MAC_(?:REGISTRY|LEASE|PROFILE))_[A-Z_]+$/.test(error?.code || '')) throw error;
        throw fail('X_EDGE_MAC_ROTATION_FAILED');
    } finally {
        let cleanupFailed = false;
        if (lease) await releaseMacProfileLease(lease).catch(() => { cleanupFailed = true; });
        if (lock) {
            try { const current = await fs.lstat(lockPath);
                if (!lockStat || current.dev !== lockStat.dev || current.ino !== lockStat.ino) throw new Error();
                await fs.unlink(lockPath);
            } catch { cleanupFailed = true; }
            await lock.close().catch(() => { cleanupFailed = true; });
        }
        // eslint-disable-next-line no-unsafe-finally
        if (cleanupFailed) throw fail('X_EDGE_MAC_ROTATION_CLEANUP_FAILED');
    }
}
module.exports = { rotateMacEdgeProfile };
