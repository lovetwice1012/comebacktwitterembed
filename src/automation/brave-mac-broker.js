'use strict';

// Experimental only: opens the signed installed Brave in the tool-owned
// profile. Mac Brave push format and receive suppression are not yet verified;
// this entry point must not be exposed in the distributed app.
const { spawn } = require('node:child_process');
const { verifyMacBraveProfile } = require('./chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
const { verifyInstalledMacBrave } = require('./brave-mac-browser');
const { startChromeBroker } = require('./chrome-private-broker');
const fail = code => Object.assign(new Error(code), { code });

async function startMacBraveBroker({ rootPath, profileId }) {
    const profile = await verifyMacBraveProfile(rootPath, profileId);
    const browser = await verifyInstalledMacBrave();
    let lease, operation, broker, launchedClosed = false;
    /** @type {import('node:child_process').ChildProcess | null} */
    let launched = null;
    const spawnOwned = (file, args, options) => {
        launched = spawn(file, args, options);
        launched.once('close', () => { launchedClosed = true; });
        return launched;
    };
    try {
        lease = await acquireMacProfileLease({ rootPath, profileId, browser: 'brave' });
        operation = beginMacProfileLease(lease, { rootPath, profileId, browser: 'brave' });
        await verifyMacBraveProfile(rootPath, profileId);
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
            if (released) return; released = true; operation.end(); let ok = false;
            try { await releaseMacProfileLease(lease); ok = true; }
            catch { /* Preserve a stale lock when ownership cannot be proven. */ }
            finally { settleRelease(ok); }
        };
        broker.chrome.once('close', () => { void release(); });
        if (launchedClosed) await release();
        return { ...broker, browserVersion: browser.browserVersion, releaseComplete };
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
            throw fail('X_BRAVE_MAC_BROKER_CLEANUP_PENDING');
        }
        operation?.end();
        if (lease) await releaseMacProfileLease(lease).catch(() => {});
        if (error?.code === 'X_CHROME_MAC_LEASE_BUSY') throw fail('X_BRAVE_MAC_BROKER_BUSY');
        throw fail('X_BRAVE_MAC_BROKER_INVALID');
    }
}
module.exports = { startMacBraveBroker };
