'use strict';

// Experimental only: opens the signed installed Brave in the tool-owned
// profile. Mac Brave push format and receive suppression are not yet verified;
// this entry point must not be exposed in the distributed app.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { parseUniqueJson } = require('./strict-json');
const { verifyMacBraveProfile } = require('./chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
const { verifyInstalledMacBrave } = require('./brave-mac-browser');
const { startChromeBroker } = require('./chrome-private-broker');
const { waitForMacProcessGroupExit } = require('./chrome-mac-process-group');
const fail = code => Object.assign(new Error(code), { code });

async function readOwnedPushSetting(profilePath) {
    try {
        const directory = path.join(profilePath, 'Default'), info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)
            || await fs.realpath(directory) !== directory) throw fail('X_BRAVE_MAC_BROKER_INVALID');
        const handle = await fs.open(path.join(directory, 'Preferences'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4 * 1024 * 1024)
                throw fail('X_BRAVE_MAC_BROKER_INVALID');
            const prefs = parseUniqueJson(await handle.readFile('utf8'), 64);
            const enabled = prefs?.brave?.gcm?.channel_status;
            return enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'unknown';
        } finally { await handle.close(); }
    } catch (error) {
        if (error?.code === 'ENOENT') return 'unknown';
        throw fail('X_BRAVE_MAC_BROKER_INVALID');
    }
}

async function startMacBraveBroker({ rootPath, profileId }) {
    const profile = await verifyMacBraveProfile(rootPath, profileId);
    const browser = await verifyInstalledMacBrave();
    let lease, operation, broker, launchedClosed = false;
    /** @type {import('node:child_process').ChildProcess | null} */
    let launched = null;
    const spawnOwned = (file, args, options) => {
        launched = spawn(file, args, { ...options, detached: true });
        launched.once('close', () => { launchedClosed = true; });
        return launched;
    };
    try {
        lease = await acquireMacProfileLease({ rootPath, profileId, browser: 'brave' });
        operation = beginMacProfileLease(lease, { rootPath, profileId, browser: 'brave' });
        await verifyMacBraveProfile(rootPath, profileId);
        // Read only this tool-owned profile under its lease. Existing settings
        // are never rewritten; the user can fix an older disabled profile.
        const pushChannelStatus = await readOwnedPushSetting(profile.profilePath);
        broker = await startChromeBroker({ chromePath: browser.executable, profilePath: profile.profilePath,
            spawnChrome: /** @type {typeof import('node:child_process').spawn} */ (/** @type {unknown} */ (spawnOwned)) });
        // A browser update between inspection and launch must not silently
        // attach the old version metadata to a newly installed executable.
        const afterLaunch = await verifyInstalledMacBrave();
        if (afterLaunch.executable !== browser.executable || afterLaunch.browserVersion !== browser.browserVersion)
            throw fail('X_BRAVE_MAC_BROKER_INVALID');
        let released = false, settleRelease;
        const releaseComplete = new Promise(resolve => { settleRelease = resolve; });
        const release = async () => {
            if (released) return; released = true; let ok = false;
            try {
                if (!broker.chrome.pid || !await waitForMacProcessGroupExit(broker.chrome.pid)) return;
                operation.end(); await releaseMacProfileLease(lease); ok = true;
            }
            catch { /* Preserve a stale lock when ownership cannot be proven. */ }
            finally { settleRelease(ok); }
        };
        broker.chrome.once('close', () => { void release(); });
        if (launchedClosed) await release();
        return { ...broker, browserVersion: browser.browserVersion, pushChannelStatus, releaseComplete };
    } catch (error) {
        if (broker) {
            try { broker.chrome.kill(); } catch { /* Already stopped. */ }
            await broker.stop().catch(() => {});
        }
        const active = /** @type {import('node:child_process').ChildProcess | null} */ (launched);
        if (operation && active) {
            let finished = false;
            const releaseAfterClose = async () => {
                if (finished) return; finished = true;
                try {
                    if (!active.pid || !await waitForMacProcessGroupExit(active.pid)) return;
                    operation.end();
                    await releaseMacProfileLease(lease);
                } catch { /* Preserve the lock if group shutdown is uncertain. */ }
            };
            if (!launchedClosed) active.once('close', () => { void releaseAfterClose(); });
            else await releaseAfterClose();
            throw fail('X_BRAVE_MAC_BROKER_CLEANUP_PENDING');
        }
        operation?.end();
        if (lease) await releaseMacProfileLease(lease).catch(() => {});
        if (error?.code === 'X_CHROME_MAC_LEASE_BUSY') throw fail('X_BRAVE_MAC_BROKER_BUSY');
        throw fail('X_BRAVE_MAC_BROKER_INVALID');
    }
}
module.exports = { startMacBraveBroker };
