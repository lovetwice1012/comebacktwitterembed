'use strict';

// Holds the setup profile's launch lock and the two LevelDB fcntl locks while
// trusted local snapshot work runs. The caller must stop its browser first.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { verifyMacChromeProfile } = require('./chrome-mac-profile');
const fail = code => Object.assign(new Error(code), { code });

async function checkedHelper(filename, expectedHash) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || !/^[0-9a-f]{64}$/.test(expectedHash)) throw fail('X_CHROME_MAC_LOCK_INVALID');
    const resolved = path.resolve(filename);
    if (await fs.realpath(resolved) !== resolved) throw fail('X_CHROME_MAC_LOCK_INVALID');
    const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || ![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022) || !(stat.mode & 0o111)
            || stat.size < 1 || stat.size > 4 * 1024 * 1024 || stat.nlink !== 1) throw fail('X_CHROME_MAC_LOCK_INVALID');
        const bytes = await handle.readFile();
        if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw fail('X_CHROME_MAC_LOCK_INVALID');
    } finally { await handle.close(); }
    return resolved;
}
async function lockFilePaths(profilePath) {
    let current = profilePath;
    for (const part of ['Default', 'GCM Store', 'Encryption']) {
        current = path.join(current, part);
        const info = await fs.lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || await fs.realpath(current) !== current)
            throw fail('X_CHROME_MAC_LOCK_INVALID');
    }
    const store = path.join(profilePath, 'Default', 'GCM Store');
    return [path.join(store, 'LOCK'), path.join(store, 'Encryption', 'LOCK')];
}
async function withMacStoreLocks({ rootPath, profileId, helperPath, expectedSha256, work }) {
    if (typeof work !== 'function') throw fail('X_CHROME_MAC_LOCK_INVALID');
    const profile = await verifyMacChromeProfile(rootPath, profileId);
    let launchLock, launchStat, child, exited, closing = false, acquired = false;
    const controller = new AbortController(), launchPath = path.join(profile.rootPath, 'broker.lock');
    try {
        try { launchLock = await fs.open(launchPath, 'wx', 0o600); } catch (error) {
            if (error?.code === 'EEXIST') throw fail('X_CHROME_MAC_LOCK_BUSY'); throw error;
        }
        launchStat = await launchLock.stat();
        if (!launchStat.isFile() || launchStat.uid !== process.getuid() || (launchStat.mode & 0o777) !== 0o600 || launchStat.nlink !== 1)
            throw fail('X_CHROME_MAC_LOCK_INVALID');
        const helper = await checkedHelper(helperPath, expectedSha256), lockPaths = await lockFilePaths(profile.profilePath);
        child = spawn(helper, lockPaths, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        child.stdin.on('error', () => {}); // A helper that exits early closes this pipe.
        exited = new Promise(resolve => {
            child.once('error', () => { if (acquired && !closing) controller.abort(); resolve(); });
            child.once('exit', () => { if (acquired && !closing) controller.abort(); resolve(); });
        });
        const status = await Promise.race([
            new Promise((resolve, reject) => {
                child.stdout.once('data', data => resolve(Buffer.isBuffer(data) ? data.toString('ascii') : 'E'));
                child.stdout.once('error', () => reject(fail('X_CHROME_MAC_LOCK_FAILED')));
            }),
            exited.then(() => 'E'),
            new Promise(resolve => { const timer = setTimeout(() => resolve('E'), 5000); timer.unref(); }),
        ]);
        if (status === 'B') throw fail('X_CHROME_MAC_LOCK_BUSY');
        if (status !== 'R' || controller.signal.aborted || child.exitCode !== null || child.signalCode !== null) throw fail('X_CHROME_MAC_LOCK_FAILED');
        acquired = true;
        // If the helper dies while work is running, signal cancellation and
        // wait for the work to settle before reporting failure.
        const value = await work({ profilePath: profile.profilePath, signal: controller.signal });
        if (controller.signal.aborted || child.exitCode !== null || child.signalCode !== null) throw fail('X_CHROME_MAC_LOCK_LOST');
        return value;
    } catch (error) {
        if (controller.signal.aborted && !closing) throw fail('X_CHROME_MAC_LOCK_LOST');
        if (/^X_CHROME_MAC_(?:LOCK|PROFILE|SNAPSHOT)_[A-Z_]+$/.test(error?.code || '')) throw error;
        throw fail('X_CHROME_MAC_LOCK_FAILED');
    } finally {
        closing = true; controller.abort();
        if (child) {
            child.stdin?.end();
            const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
            try { await exited; } finally { clearTimeout(timer); }
        }
        if (launchLock) {
            try {
                const current = await fs.lstat(launchPath);
                if (!launchStat || current.dev !== launchStat.dev || current.ino !== launchStat.ino) throw new Error();
                await fs.unlink(launchPath);
            } catch { throw fail('X_CHROME_MAC_LOCK_CLEANUP_FAILED'); }
            finally { await launchLock.close(); }
        }
    }
}
module.exports = { withMacStoreLocks };
