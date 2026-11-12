'use strict';

// Experimental orchestration only. The caller must stop the verified Brave
// setup process before calling and must not expose this path to users yet.
const { ClassicLevel } = require('classic-level');
const { parseUniqueJson } = require('./strict-json');
const { readChromeSnapshot } = require('./chrome-snapshot-io');
const { withMacBraveKeychainPassword } = require('./chrome-mac-keychain');
const { withMacBraveSnapshot } = require('./chrome-mac-snapshot');
const { writeExperimentalMacBraveExport } = require('./brave-mac-private-export');
const fail = code => Object.assign(new Error(code), { code });

async function exportExperimentalMacBraveNotifications({ rootPath, profileId, helperPath, expectedSha256, subscription,
    browserVersion, engineVersion, keychainConfirmed, confirmSave, experimental, signal = undefined }) {
    if (experimental !== true || keychainConfirmed !== true || typeof confirmSave !== 'function'
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_BRAVE_MAC_FLOW_INVALID');
    function check() { if (signal?.aborted) throw fail('X_BRAVE_MAC_FLOW_CANCELLED'); }
    check();
    const data = await withMacBraveKeychainPassword({ confirmed: true, signal, work: password =>
        withMacBraveSnapshot({ rootPath, profileId, helperPath, expectedSha256, work: async snapshot => {
            check(); if (snapshot.signal.aborted) throw fail('X_BRAVE_MAC_FLOW_CANCELLED');
            const result = await readChromeSnapshot({ ...snapshot, subscription, browserVersion, engineVersion,
                platform: 'macos', macPassword: password, experimentalBraveMac: true,
                parseJson: text => parseUniqueJson(text, 64),
                dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' }) });
            check(); if (snapshot.signal.aborted) throw fail('X_BRAVE_MAC_FLOW_CANCELLED');
            return result;
        } }) });
    check();
    if (!data || !Number.isInteger(data.otherSubscriptionCount) || data.otherSubscriptionCount < 0 || data.otherSubscriptionCount > 63)
        throw fail('X_BRAVE_MAC_FLOW_INVALID');
    // The snapshot and borrowed Keychain buffer are gone before this dialog.
    const choice = await confirmSave({ otherSubscriptionCount: data.otherSubscriptionCount,
        otherNotificationsMayReachServer: data.otherSubscriptionCount > 0 });
    check();
    if (choice === null) return { state: 'cancelled' };
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.getPrototypeOf(choice) !== Object.prototype
        || Object.keys(choice).sort().join(',') !== 'confirmed,directory,filename,otherSitesConsent'
        || choice.confirmed !== true || typeof choice.otherSitesConsent !== 'boolean'
        || data.otherSubscriptionCount > 0 && !choice.otherSitesConsent) throw fail('X_BRAVE_MAC_FLOW_CONFIRMATION_REQUIRED');
    const output = await writeExperimentalMacBraveExport({ directory: choice.directory, filename: choice.filename, file: data.file,
        confirmed: true, otherSubscriptionCount: data.otherSubscriptionCount, otherSitesConsent: choice.otherSitesConsent,
        experimental: true, signal });
    return { state: 'saved', ...output };
}
module.exports = { exportExperimentalMacBraveNotifications };
