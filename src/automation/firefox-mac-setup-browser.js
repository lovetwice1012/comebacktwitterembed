'use strict';

// Experimental dedicated-profile launch only. This is not yet connected to
// the distributed app and does not inspect, export or upload notification data.
const { spawn } = require('node:child_process');
const { verifyInstalledMacFirefox } = require('./firefox-mac-browser');
const { verifyMacFirefoxProfile } = require('./chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
const { waitForMacProcessGroupExit } = require('./chrome-mac-process-group');
const fail = code => Object.assign(new Error(code), { code });

async function startExperimentalMacFirefox({ rootPath, profileId, experimental }) {
    if (experimental !== true || process.platform !== 'darwin') throw fail('X_FIREFOX_MAC_LAUNCH_INVALID');
    const profile = await verifyMacFirefoxProfile(rootPath, profileId);
    const browser = await verifyInstalledMacFirefox();
    let lease, operation, child, releaseStarted = false, closeObserved = false, resolveRelease;
    const releaseComplete = new Promise(resolve => { resolveRelease = resolve; });
    async function release() {
        if (releaseStarted) return;
        releaseStarted = true; let released = false;
        try {
            if (!closeObserved || !child?.pid || !await waitForMacProcessGroupExit(child.pid)) return;
            operation.end(); await releaseMacProfileLease(lease); released = true;
        } catch { /* Preserve the lease when shutdown or ownership is uncertain. */ }
        finally { resolveRelease(released); }
    }
    try {
        lease = await acquireMacProfileLease({ rootPath, profileId, browser: 'firefox' });
        operation = beginMacProfileLease(lease, { rootPath, profileId, browser: 'firefox' });
        await verifyMacFirefoxProfile(rootPath, profileId);
        /** @type {NodeJS.ProcessEnv} */
        const env = {};
        for (const [name, value] of Object.entries(process.env)) {
            if (!/^(?:MOZ_|XRE_|XUL_|NSPR_|SELECTABLE_PROFILE_RESET_|DYLD_)/i.test(name) && typeof value === 'string') env[name] = value;
        }
        child = spawn(browser.executable, ['-no-remote', '-profile', profile.profilePath, 'https://x.com/'],
            { detached: true, stdio: 'ignore', env });
        child.once('error', () => { /* close and the process-group check decide whether release is safe. */ });
        child.once('close', () => { closeObserved = true; void release(); });
        if (!Number.isInteger(child.pid) || child.pid <= 1) throw fail('X_FIREFOX_MAC_LAUNCH_FAILED');
        const after = await verifyInstalledMacFirefox();
        if (closeObserved || after.executable !== browser.executable || after.version !== browser.version) throw fail('X_FIREFOX_MAC_LAUNCH_FAILED');
        return Object.freeze({ browserVersion: browser.version, releaseComplete });
    } catch (error) {
        if (child?.pid) {
            if (!closeObserved) try { child.kill('SIGTERM'); } catch { /* Retain the lease until close is observed. */ }
            if (closeObserved) void release();
            throw fail('X_FIREFOX_MAC_LAUNCH_CLEANUP_PENDING');
        }
        operation?.end();
        if (lease) await releaseMacProfileLease(lease);
        if (error?.code === 'X_CHROME_MAC_LEASE_BUSY') throw fail('X_FIREFOX_MAC_LAUNCH_BUSY');
        throw fail('X_FIREFOX_MAC_LAUNCH_FAILED');
    }
}
module.exports = { startExperimentalMacFirefox };
