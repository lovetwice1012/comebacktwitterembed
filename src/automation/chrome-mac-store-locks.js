'use strict';

// Holds the setup profile's launch lock and the required LevelDB fcntl locks while
// trusted local snapshot work runs. The caller must stop its browser first.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
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
async function lockFilePaths(profilePath, browser) {
    if (browser === 'firefox') return [path.join(profilePath, '.parentlock')];
    let current = profilePath;
    const parts = browser === 'edge' ? ['Default', 'EdgePushStorageWithConnectTokenAndKey'] : ['Default', 'GCM Store', 'Encryption'];
    for (const part of parts) {
        current = path.join(current, part);
        const info = await fs.lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || await fs.realpath(current) !== current)
            throw fail('X_CHROME_MAC_LOCK_INVALID');
    }
    if (browser === 'edge') return [path.join(current, 'LOCK')];
    const store = path.join(profilePath, 'Default', 'GCM Store');
    return [path.join(store, 'LOCK'), path.join(store, 'Encryption', 'LOCK')];
}
async function withMacStoreLocks({ rootPath, profileId, helperPath, expectedSha256, work, browser = 'chrome', profileLease }) {
    if (typeof work !== 'function' || !['chrome', 'edge', 'brave', 'firefox'].includes(browser)) throw fail('X_CHROME_MAC_LOCK_INVALID');
    const ownsLease = profileLease === undefined; let lease = profileLease, operation, child, exited, closing = false, acquired = false;
    const controller = new AbortController();
    try {
        if (ownsLease) lease = await acquireMacProfileLease({ rootPath, profileId, browser });
        operation = beginMacProfileLease(lease, { rootPath, profileId, browser });
        const profile = operation.profile;
        const helper = await checkedHelper(helperPath, expectedSha256), lockPaths = await lockFilePaths(profile.profilePath, browser);
        let firefoxLockIdentity;
        if (browser === 'firefox') {
            firefoxLockIdentity = await fs.lstat(lockPaths[0]);
            if (!firefoxLockIdentity.isFile() || firefoxLockIdentity.isSymbolicLink()
                || firefoxLockIdentity.uid !== process.getuid() || firefoxLockIdentity.nlink !== 1)
                throw fail('X_CHROME_MAC_LOCK_INVALID');
        }
        async function checkFirefoxLockIdentity() {
            if (!firefoxLockIdentity) return;
            let current;
            try { current = await fs.lstat(lockPaths[0]); } catch { throw fail('X_CHROME_MAC_LOCK_LOST'); }
            if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid() || current.nlink !== 1
                || current.dev !== firefoxLockIdentity.dev || current.ino !== firefoxLockIdentity.ino)
                throw fail('X_CHROME_MAC_LOCK_LOST');
        }
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
        await checkFirefoxLockIdentity();
        // If the helper dies while work is running, signal cancellation and
        // wait for the work to settle before reporting failure.
        const value = await work({ profilePath: profile.profilePath, signal: controller.signal });
        await checkFirefoxLockIdentity();
        if (controller.signal.aborted || child.exitCode !== null || child.signalCode !== null) throw fail('X_CHROME_MAC_LOCK_LOST');
        return value;
    } catch (error) {
        if (controller.signal.aborted && !closing) throw fail('X_CHROME_MAC_LOCK_LOST');
        if (error?.code === 'X_CHROME_MAC_LEASE_BUSY') throw fail('X_CHROME_MAC_LOCK_BUSY');
        // Reader and cancellation failures are not lock failures. Preserve only
        // known fixed codes and discard the original message and stack.
        if (browser === 'chrome' && ['X_CHROME_SNAPSHOT_INVALID', 'X_CHROME_SNAPSHOT_UNSUPPORTED',
            'X_CHROME_SNAPSHOT_NOT_FOUND', 'X_CHROME_SNAPSHOT_AMBIGUOUS', 'X_CHROME_MAC_FLOW_CANCELLED'].includes(error?.code)) throw fail(error.code);
        if (browser === 'firefox' && /^X_FIREFOX_MAC_(?:PREFS|UAID|LOCK|SNAPSHOT)_[A-Z_]+$/.test(error?.code || '')) throw error;
        if (/^X_CHROME_MAC_(?:LOCK|PROFILE|SNAPSHOT)_[A-Z_]+$/.test(error?.code || '')) throw error;
        throw fail('X_CHROME_MAC_LOCK_FAILED');
    } finally {
        closing = true; controller.abort();
        if (child) {
            child.stdin?.end();
            const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
            try { await exited; } finally { clearTimeout(timer); }
        }
        operation?.end();
        if (ownsLease && lease) try { await releaseMacProfileLease(lease); } catch {
            // A failed release must override success; the lock may remain held.
            // eslint-disable-next-line no-unsafe-finally
            throw fail('X_CHROME_MAC_LOCK_CLEANUP_FAILED');
        }
    }
}
module.exports = { withMacStoreLocks };
