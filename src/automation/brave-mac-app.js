'use strict';

// Experimental local bootstrap only. Do not package or expose it until
// macOS process-tree, receive suppression and server intake are verified.
const path = require('node:path');
const { ensureMacSetupDirectory } = require('./chrome-mac-app');
const { getOrCreateMacBraveProfile } = require('./chrome-mac-profile-registry');
const { runExperimentalMacBraveSetup } = require('./brave-mac-setup-session');
const fail = () => Object.assign(new Error('X_BRAVE_MAC_APP_INVALID'), { code: 'X_BRAVE_MAC_APP_INVALID' });

async function runExperimentalMacBraveApp({ applicationSupport, helperPath, expectedSha256, ui, experimental }) {
    if (experimental !== true || typeof helperPath !== 'string' || !path.isAbsolute(helperPath)
        || typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256) || !ui
        || ['confirmOpen', 'confirmNotifications', 'retryCapture', 'confirmKeychain', 'confirmSave'].some(name => typeof ui[name] !== 'function')) throw fail();
    const base = await ensureMacSetupDirectory(applicationSupport), profile = await getOrCreateMacBraveProfile(base);
    return runExperimentalMacBraveSetup({ rootPath: profile.rootPath, profileId: profile.profileId,
        helperPath, expectedSha256, ui, experimental: true });
}
module.exports = { runExperimentalMacBraveApp };
