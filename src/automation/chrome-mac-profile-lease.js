'use strict';

// Process-local capability for the exclusive lock on a dedicated setup
// profile. The lock remains held across separate snapshot and launch steps.
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyMacChromeProfile, verifyMacEdgeProfile, verifyMacBraveProfile, verifyMacFirefoxProfile } = require('./chrome-mac-profile');
const fail = code => Object.assign(new Error(code), { code });
const leases = new WeakMap();

async function acquireMacProfileLease({ rootPath, profileId, browser }) {
    const verifiers = { chrome: verifyMacChromeProfile, edge: verifyMacEdgeProfile, brave: verifyMacBraveProfile, firefox: verifyMacFirefoxProfile };
    if (!Object.hasOwn(verifiers, browser)) throw fail('X_CHROME_MAC_LEASE_INVALID');
    const verify = verifiers[browser];
    const profile = await verify(rootPath, profileId);
    const filename = path.join(profile.rootPath, 'broker.lock'); let handle, identity;
    try {
        try { handle = await fs.open(filename, 'wx', 0o600); } catch (error) {
            if (error?.code === 'EEXIST') throw fail('X_CHROME_MAC_LEASE_BUSY'); throw error;
        }
        identity = await handle.stat();
        if (!identity.isFile() || identity.uid !== process.getuid() || (identity.mode & 0o777) !== 0o600 || identity.nlink !== 1)
            throw fail('X_CHROME_MAC_LEASE_INVALID');
        await handle.writeFile(JSON.stringify({ profileId, pid: process.pid })); await handle.sync();
        const lease = Object.freeze({}); leases.set(lease, { profile, browser, filename, handle, identity, busy: false, closed: false });
        return lease;
    } catch (error) {
        let cleanupFailed = false;
        if (handle) {
            try { const info = await fs.lstat(filename); if (!identity || info.dev !== identity.dev || info.ino !== identity.ino) throw new Error(); await fs.unlink(filename); }
            catch { cleanupFailed = true; }
            await handle.close().catch(() => { cleanupFailed = true; });
        }
        if (cleanupFailed) throw fail('X_CHROME_MAC_LEASE_CLEANUP_FAILED');
        if (/^X_CHROME_MAC_(?:LEASE|PROFILE)_[A-Z_]+$/.test(error?.code || '')) throw error;
        throw fail('X_CHROME_MAC_LEASE_INVALID');
    }
}
function beginMacProfileLease(lease, { rootPath, profileId, browser }) {
    const state = lease && leases.get(lease);
    if (!state || state.closed || state.browser !== browser || state.profile.rootPath !== rootPath || state.profile.profileId !== profileId)
        throw fail('X_CHROME_MAC_LEASE_INVALID');
    if (state.busy) throw fail('X_CHROME_MAC_LEASE_BUSY');
    state.busy = true; let ended = false;
    return Object.freeze({ profile: state.profile, end() { if (!ended) { ended = true; state.busy = false; } } });
}
async function releaseMacProfileLease(lease) {
    const state = lease && leases.get(lease);
    if (!state) throw fail('X_CHROME_MAC_LEASE_INVALID');
    if (state.closed) return;
    if (state.busy) throw fail('X_CHROME_MAC_LEASE_BUSY');
    state.closed = true; let failed = false;
    try { const info = await fs.lstat(state.filename); if (info.dev !== state.identity.dev || info.ino !== state.identity.ino) throw new Error(); await fs.unlink(state.filename); }
    catch { failed = true; }
    await state.handle.close().catch(() => { failed = true; });
    if (failed) throw fail('X_CHROME_MAC_LEASE_CLEANUP_FAILED');
}
module.exports = { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease };
