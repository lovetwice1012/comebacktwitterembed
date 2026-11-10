'use strict';

// Experimental Mac Edge setup. The caller must determine receive suppression
// from a verified stopped-profile snapshot; it must not guess from UI input.
// The Mac Edge store and protocol still require native validation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyMacEdgeProfile } = require('./chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
const { startChromeBroker } = require('./edge-private-broker');
const execFileAsync = promisify(execFile);
const APP = '/Applications/Microsoft Edge.app';
const EXECUTABLE = path.join(APP, 'Contents/MacOS/Microsoft Edge');
const REQUIREMENT = '=anchor apple generic and identifier "com.microsoft.edgemac" and certificate leaf[subject.OU] = "UBF8T346G9"';
const fail = code => Object.assign(new Error(code), { code });

async function verifyInstalledEdge() {
    if (process.platform !== 'darwin') throw fail('X_EDGE_MAC_BROWSER_UNSUPPORTED');
    try {
        const bundle = await fs.lstat(APP), binary = await fs.lstat(EXECUTABLE);
        if (!bundle.isDirectory() || bundle.isSymbolicLink() || !binary.isFile() || binary.isSymbolicLink()
            || await fs.realpath(APP) !== APP || await fs.realpath(EXECUTABLE) !== EXECUTABLE) throw new Error();
        await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', REQUIREMENT, APP],
            { timeout: 30000, maxBuffer: 16384, windowsHide: true });
        return EXECUTABLE;
    } catch { throw fail('X_EDGE_MAC_BROWSER_INVALID'); }
}

async function startMacEdgeBroker({ rootPath, profileId, suppressReceive, profileLease }) {
    if (typeof suppressReceive !== 'boolean') throw fail('X_EDGE_MAC_BROKER_INVALID');
    const profile = await verifyMacEdgeProfile(rootPath, profileId), browserPath = await verifyInstalledEdge();
    const ownsLease = profileLease === undefined; let lease = profileLease, operation, launchedClosed = false;
    /** @type {import('node:child_process').ChildProcess | null} */
    let launched = null;
    const spawnOwned = (file, args, options) => {
        launched = spawn(file, args, options); launched.once('close', () => { launchedClosed = true; }); return launched;
    };
    try {
        if (ownsLease) lease = await acquireMacProfileLease({ rootPath, profileId, browser: 'edge' });
        operation = beginMacProfileLease(lease, { rootPath, profileId, browser: 'edge' });
        await verifyMacEdgeProfile(rootPath, profileId);
        const broker = await startChromeBroker({ chromePath: browserPath, profilePath: profile.profilePath,
            browserMode: 'edge', includeApplicationServerKey: true, suppressReceive,
            spawnChrome: /** @type {typeof import('node:child_process').spawn} */ (/** @type {unknown} */ (spawnOwned)) });
        let released = false, settleRelease;
        const releaseComplete = new Promise(resolve => { settleRelease = resolve; });
        const release = async () => {
            if (released) return; released = true; let ok = false;
            operation.end();
            try { await releaseMacProfileLease(lease); ok = true; }
            catch { /* A stale lock fails closed. */ }
            finally { settleRelease(ok); }
        };
        broker.chrome.once('exit', () => { void release(); });
        if (broker.chrome.exitCode !== null) await release();
        return { ...broker, releaseComplete };
    } catch (error) {
        // A failed handshake can request termination before the OS has
        // reported that the child actually exited. Keep the profile locked
        // until then, rather than letting another setup start in that gap.
        const active = /** @type {import('node:child_process').ChildProcess | null} */ (launched);
        if (operation && active && !launchedClosed && active.exitCode === null && active.signalCode === null) {
            let finished = false;
            const releaseAfterExit = async () => {
                if (finished) return; finished = true; operation.end();
                await releaseMacProfileLease(lease).catch(() => {});
            };
            active.once('exit', () => { void releaseAfterExit(); });
            active.once('close', () => { void releaseAfterExit(); });
            if (launchedClosed || active.exitCode !== null || active.signalCode !== null) void releaseAfterExit();
            throw fail('X_EDGE_MAC_BROKER_CLEANUP_PENDING');
        }
        operation?.end();
        if (lease && (ownsLease || operation)) await releaseMacProfileLease(lease).catch(() => {});
        if (error?.code === 'X_CHROME_MAC_LEASE_BUSY') throw fail('X_EDGE_MAC_BROKER_BUSY');
        throw fail('X_EDGE_MAC_BROKER_INVALID');
    }
}
module.exports = { startMacEdgeBroker, verifyInstalledEdge };
