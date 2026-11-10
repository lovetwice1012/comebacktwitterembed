'use strict';

// Experimental Mac Edge setup. The caller must determine receive suppression
// from a verified stopped-profile snapshot; it must not guess from UI input.
// The Mac Edge store and protocol still require native validation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyMacEdgeProfile } = require('./chrome-mac-profile');
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

async function startMacEdgeBroker({ rootPath, profileId, suppressReceive }) {
    if (typeof suppressReceive !== 'boolean') throw fail('X_EDGE_MAC_BROKER_INVALID');
    const profile = await verifyMacEdgeProfile(rootPath, profileId), browserPath = await verifyInstalledEdge();
    const lockPath = path.join(profile.rootPath, 'broker.lock');
    let lock, lockStat;
    try {
        lock = await fs.open(lockPath, 'wx', 0o600); lockStat = await lock.stat();
        if (!lockStat.isFile() || lockStat.uid !== process.getuid() || (lockStat.mode & 0o777) !== 0o600 || lockStat.nlink !== 1)
            throw fail('X_EDGE_MAC_BROKER_INVALID');
        await lock.writeFile(JSON.stringify({ profileId, pid: process.pid })); await lock.sync();
        const broker = await startChromeBroker({ chromePath: browserPath, profilePath: profile.profilePath,
            browserMode: 'edge', includeApplicationServerKey: true, suppressReceive });
        let released = false, settleRelease;
        const releaseComplete = new Promise(resolve => { settleRelease = resolve; });
        const release = async () => {
            if (released) return; released = true; let ok = false;
            try { const current = await fs.lstat(lockPath); if (current.dev === lockStat.dev && current.ino === lockStat.ino) { await fs.unlink(lockPath); ok = true; } }
            catch { /* A stale lock fails closed. */ }
            finally { await lock.close().catch(() => { ok = false; }); settleRelease(ok); }
        };
        broker.chrome.once('exit', () => { void release(); });
        if (broker.chrome.exitCode !== null) await release();
        return { ...broker, releaseComplete };
    } catch (error) {
        if (lock) {
            try { const current = await fs.lstat(lockPath); if (lockStat && current.dev === lockStat.dev && current.ino === lockStat.ino) await fs.unlink(lockPath); }
            catch { /* Report only a fixed error. */ }
            await lock.close().catch(() => {});
        }
        if (error?.code === 'EEXIST') throw fail('X_EDGE_MAC_BROKER_BUSY');
        throw fail('X_EDGE_MAC_BROKER_INVALID');
    }
}
module.exports = { startMacEdgeBroker, verifyInstalledEdge };
