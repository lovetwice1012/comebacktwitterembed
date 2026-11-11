'use strict';

// Experimental entry for a future signed distribution. It uses only its own
// Firefox profile and never uploads a file or enables a server feature.
const path = require('node:path');
const { ensureMacSetupDirectory } = require('./chrome-mac-app');
const { getOrCreateMacFirefoxProfile } = require('./chrome-mac-profile-registry');
const { runExperimentalMacFirefoxSetup } = require('./firefox-mac-setup-session');
const fail = () => Object.assign(new Error('X_FIREFOX_MAC_APP_INVALID'), { code: 'X_FIREFOX_MAC_APP_INVALID' });

async function runExperimentalMacFirefoxApp({ applicationSupport, helperPath, expectedSha256, bootstrapPath, bootstrapSha256,
    readerPath, readerSha256, ui, experimental, signal }) {
    if (experimental !== true || [helperPath, bootstrapPath, readerPath].some(name => typeof name !== 'string' || !path.isAbsolute(name))
        || [expectedSha256, bootstrapSha256, readerSha256].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) throw fail();
    const base = await ensureMacSetupDirectory(applicationSupport);
    const profile = await getOrCreateMacFirefoxProfile(base);
    return runExperimentalMacFirefoxSetup({ rootPath: profile.rootPath, profileId: profile.profileId, helperPath, expectedSha256,
        bootstrapPath, bootstrapSha256, readerPath, readerSha256, ui, experimental: true, signal });
}
module.exports = { runExperimentalMacFirefoxApp };
