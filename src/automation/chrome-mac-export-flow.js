'use strict';

// Local orchestration only. The caller supplies a subscription captured from
// its dedicated browser, obtains explicit Keychain consent, and presents the
// final confirmation/save dialog. This module does not upload or send data.
const { ClassicLevel } = require('classic-level');
const { parseUniqueJson } = require('./strict-json');
const { readChromeSnapshot } = require('./chrome-snapshot-io');
const { withMacChromeKeychainPassword } = require('./chrome-mac-keychain');
const { withMacChromeSnapshot } = require('./chrome-mac-snapshot');
const { writeMacChromeExport } = require('./chrome-mac-private-export');
const fail = code => Object.assign(new Error(code), { code });

async function exportMacChromeNotifications({ rootPath, profileId, helperPath, expectedSha256, subscription,
    browserVersion, keychainConfirmed, confirmSave, signal }) {
    if (keychainConfirmed !== true || typeof confirmSave !== 'function'
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_CHROME_MAC_FLOW_INVALID');
    function check() { if (signal?.aborted) throw fail('X_CHROME_MAC_FLOW_CANCELLED'); }
    check();
    const data = await withMacChromeKeychainPassword({ confirmed: true, signal, work: password =>
        withMacChromeSnapshot({ rootPath, profileId, helperPath, expectedSha256, work: async snapshot => {
            check();
            if (snapshot.signal.aborted) throw fail('X_CHROME_MAC_FLOW_CANCELLED');
            const result = await readChromeSnapshot({ ...snapshot, subscription, browserVersion, platform: 'macos', macPassword: password,
                parseJson: text => parseUniqueJson(text, 64),
                dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' }) });
            check(); if (snapshot.signal.aborted) throw fail('X_CHROME_MAC_FLOW_CANCELLED');
            return result;
        } }) });
    check();
    if (!data || !Number.isInteger(data.otherSubscriptionCount) || data.otherSubscriptionCount < 0 || data.otherSubscriptionCount > 63)
        throw fail('X_CHROME_MAC_FLOW_INVALID');
    // At this point the snapshot and Keychain buffer have been cleaned up.
    // The UI must explain that other-site payloads can reach the server and
    // request separate consent before any output is created.
    const choice = await confirmSave({ otherSubscriptionCount: data.otherSubscriptionCount,
        otherNotificationsMayReachServer: data.otherSubscriptionCount > 0 });
    check();
    if (choice === null) return { state: 'cancelled' };
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.getPrototypeOf(choice) !== Object.prototype
        || Object.keys(choice).sort().join(',') !== 'confirmed,directory,filename,otherSitesConsent'
        || choice.confirmed !== true || typeof choice.otherSitesConsent !== 'boolean'
        || data.otherSubscriptionCount > 0 && !choice.otherSitesConsent) throw fail('X_CHROME_MAC_FLOW_CONFIRMATION_REQUIRED');
    const output = await writeMacChromeExport({ directory: choice.directory, filename: choice.filename, file: data.file, confirmed: true, signal });
    return { state: 'saved', ...output };
}
module.exports = { exportMacChromeNotifications };
