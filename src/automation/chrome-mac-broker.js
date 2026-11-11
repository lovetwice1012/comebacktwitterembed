'use strict';

// Mac setup only: use the installed, signed Google Chrome and the dedicated
// profile. No existing browser profile is inspected or changed. The wrapper
// does not itself publish or upload anything.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyMacChromeProfile } = require('./chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
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
    let lease, operation, broker, launchedClosed = false;
    /** @type {import('node:child_process').ChildProcess | null} */
    let launched = null;
    const spawnOwned = (file, args, options) => {
        launched = spawn(file, args, options);
        launched.once('close', () => { launchedClosed = true; });
        return launched;
    };
    try {
        lease = await acquireMacProfileLease({ rootPath, profileId, browser: 'chrome' });
        operation = beginMacProfileLease(lease, { rootPath, profileId, browser: 'chrome' });
        await verifyMacChromeProfile(rootPath, profileId);
        broker = await startChromeBroker({ chromePath, profilePath: profile.profilePath,
            spawnChrome: /** @type {typeof import('node:child_process').spawn} */ (/** @type {unknown} */ (spawnOwned)) });
        if (await verifyInstalledChrome() !== chromePath) throw fail('X_CHROME_MAC_BROKER_INVALID');
        let released = false, settleRelease;
        const releaseComplete = new Promise(resolve => { settleRelease = resolve; });
        const release = async () => {
            if (released) return; released = true; operation.end();
            let ok = false;
            try { await releaseMacProfileLease(lease); ok = true; }
            catch { /* Preserve a stale lock when ownership cannot be proven. */ }
            finally { settleRelease(ok); }
        };
        broker.chrome.once('close', () => { void release(); });
        if (launchedClosed) await release();
        return { ...broker, releaseComplete };
    } catch (error) {
        if (broker) {
            try { broker.chrome.kill(); } catch { /* Already stopped. */ }
            await broker.stop().catch(() => {});
        }
        const active = /** @type {import('node:child_process').ChildProcess | null} */ (launched);
        if (operation && active && !launchedClosed) {
            let finished = false;
            const releaseAfterClose = async () => {
                if (finished) return; finished = true; operation.end();
                await releaseMacProfileLease(lease).catch(() => {});
            };
            active.once('close', () => { void releaseAfterClose(); });
            if (launchedClosed) void releaseAfterClose();
            throw fail('X_CHROME_MAC_BROKER_CLEANUP_PENDING');
        }
        operation?.end();
        if (lease) await releaseMacProfileLease(lease).catch(() => {});
        if (error?.code === 'X_CHROME_MAC_LEASE_BUSY') throw fail('X_CHROME_MAC_BROKER_BUSY');
        throw fail('X_CHROME_MAC_BROKER_INVALID');
    }
}
module.exports = { startMacChromeBroker, verifyInstalledChrome };
