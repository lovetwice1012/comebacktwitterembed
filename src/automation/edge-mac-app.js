'use strict';

// An unpublished candidate only. It never uploads a file or changes a gate.
const path = require('node:path');
const { ensureMacSetupDirectory } = require('./chrome-mac-app');
const { getOrCreateMacEdgeProfile } = require('./chrome-mac-profile-registry');
const { rotateMacEdgeProfile } = require('./edge-mac-profile-rotation');
const { runExperimentalMacEdgeSetup } = require('./edge-mac-setup-session');
const fail = () => Object.assign(new Error('X_EDGE_MAC_APP_INVALID'), { code: 'X_EDGE_MAC_APP_INVALID' });

async function runExperimentalMacEdgeApp({ applicationSupport, helperPath, expectedSha256, identityPath, identitySha256,
    peerPath, peerSha256, ui, experimental, signal }) {
    if (experimental !== true || [helperPath, identityPath, peerPath].some(name => typeof name !== 'string' || !path.isAbsolute(name))
        || [expectedSha256, identitySha256, peerSha256].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail();
    if (signal?.aborted) return { state: 'cancelled' };
    const base = await ensureMacSetupDirectory(applicationSupport); let profile = await getOrCreateMacEdgeProfile(base);
    if (signal?.aborted) return { state: 'cancelled' };
    const run = () => runExperimentalMacEdgeSetup({ rootPath: profile.rootPath, profileId: profile.profileId, helperPath, expectedSha256,
        identityPath, identitySha256, peerPath, peerSha256, ui, experimental: true, signal });
    try { return await run(); }
    catch (error) {
        if (error?.code !== 'X_EDGE_MAC_PROFILE_INSPECTION_REQUIRED' || typeof ui?.confirmNewProfile !== 'function') throw error;
        if (signal?.aborted || await ui.confirmNewProfile() !== true || signal?.aborted) return { state: 'cancelled' };
        profile = await rotateMacEdgeProfile({ directory: base, oldProfile: profile, confirmed: true });
        if (signal?.aborted) return { state: 'cancelled' };
        return run();
    }
}
module.exports = { runExperimentalMacEdgeApp };
