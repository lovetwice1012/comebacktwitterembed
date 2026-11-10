'use strict';

// Mac setup only: use the installed, signed Google Chrome and the dedicated
// profile. No existing browser profile is inspected or changed. The wrapper
// does not itself publish or upload anything.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyMacChromeProfile } = require('./chrome-mac-profile');
const { startChromeBroker } = require('./chrome-private-broker');
const execFileAsync = promisify(execFile);
const APP = '/Applications/Google Chrome.app';
const EXECUTABLE = path.join(APP, 'Contents/MacOS/Google Chrome');
const REQUIREMENT = '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"';
const fail = code => Object.assign(new Error(code), { code });

async function verifyInstalledChrome() {
    if (process.platform !== 'darwin') throw fail('X_CHROME_MAC_BROWSER_UNSUPPORTED');
    try {
        const bundle = await fs.lstat(APP), binary = await fs.lstat(EXECUTABLE);
        if (!bundle.isDirectory() || bundle.isSymbolicLink() || !binary.isFile() || binary.isSymbolicLink()
            || await fs.realpath(APP) !== APP || await fs.realpath(EXECUTABLE) !== EXECUTABLE) throw new Error();
        // Verify identity and signature without a shell. A bundle identifier by
        // itself does not prove the signer. Never log codesign output.
        await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', REQUIREMENT, APP],
            { timeout: 30000, maxBuffer: 16384, windowsHide: true });
        return EXECUTABLE;
    } catch { throw fail('X_CHROME_MAC_BROWSER_INVALID'); }
}

async function startMacChromeBroker({ rootPath, profileId }) {
    const profile = await verifyMacChromeProfile(rootPath, profileId);
    const chromePath = await verifyInstalledChrome();
    const lockPath = path.join(profile.rootPath, 'broker.lock');
    let lock, lockStat;
    try {
        // A second setup process must not attach a debugger to the same
        // profile. A crash may leave this lock, which needs safe recovery.
        lock = await fs.open(lockPath, 'wx', 0o600); lockStat = await lock.stat();
        if (!lockStat.isFile() || lockStat.uid !== process.getuid() || (lockStat.mode & 0o777) !== 0o600 || lockStat.nlink !== 1)
            throw fail('X_CHROME_MAC_BROKER_INVALID');
        await lock.writeFile(JSON.stringify({ profileId, pid: process.pid })); await lock.sync();
        const broker = await startChromeBroker({ chromePath, profilePath: profile.profilePath });
        let released = false, settleRelease;
        const releaseComplete = new Promise(resolve => { settleRelease = resolve; });
        const release = async () => {
            if (released) return; released = true;
            let ok = false;
            try {
                const current = await fs.lstat(lockPath);
                if (current.dev === lockStat.dev && current.ino === lockStat.ino) { await fs.unlink(lockPath); ok = true; }
            } catch { /* A stale lock fails closed and can be recovered later. */ }
            finally { await lock.close().catch(() => { ok = false; }); settleRelease(ok); }
        };
        broker.chrome.once('exit', () => { void release(); });
        if (broker.chrome.exitCode !== null) await release();
        return { ...broker, releaseComplete };
    } catch (error) {
        if (lock) {
            try {
                const current = await fs.lstat(lockPath);
                if (lockStat && current.dev === lockStat.dev && current.ino === lockStat.ino) await fs.unlink(lockPath);
            } catch { /* Report only a fixed error. */ }
            await lock.close().catch(() => {});
        }
        if (error?.code === 'EEXIST') throw fail('X_CHROME_MAC_BROKER_BUSY');
        throw fail('X_CHROME_MAC_BROKER_INVALID');
    }
}
module.exports = { startMacChromeBroker, verifyInstalledChrome };
