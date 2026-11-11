'use strict';

// Experimental composition only. The supplied trusted supervisor must not
// report stopped until the entire reader process tree has actually exited.
// The distribution does not call this flow until that guarantee is verified.
const path = require('node:path');
const { verifyInstalledMacFirefox } = require('./firefox-mac-browser');
const { readVerifiedMacFirefoxScript } = require('./firefox-mac-reader-script');
const { withMacFirefoxSnapshot } = require('./firefox-mac-snapshot');
const { withExperimentalMacFirefoxReaderDirectory } = require('./firefox-mac-reader-directory');
const { prepareMacFirefoxReaderResult, consumeMacFirefoxReaderResult, discardMacFirefoxReaderResult } = require('./firefox-mac-reader-result');
const { writeMacFirefoxExport } = require('./firefox-mac-private-export');
const fail = code => Object.assign(new Error(code), { code });

async function exportExperimentalMacFirefoxNotifications({ rootPath, profileId, helperPath, expectedSha256,
    bootstrapPath, bootstrapSha256, readerPath, readerSha256, runReader, confirmSave, experimental, signal }) {
    if (experimental !== true || typeof runReader !== 'function' || typeof confirmSave !== 'function'
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_FIREFOX_MAC_FLOW_INVALID');
    const check = () => { if (signal?.aborted) throw fail('X_FIREFOX_MAC_FLOW_CANCELLED'); };
    check(); const browser = await verifyInstalledMacFirefox(); check();
    let bootstrap, reader;
    try {
        bootstrap = await readVerifiedMacFirefoxScript({ filename: bootstrapPath, kind: 'bootstrap', expectedSha256: bootstrapSha256 });
        reader = await readVerifiedMacFirefoxScript({ filename: readerPath, kind: 'reader', expectedSha256: readerSha256 });
        check();
        const data = await withMacFirefoxSnapshot({ rootPath, profileId, helperPath, expectedSha256, signal,
            experimentalReaderArtifacts: true, work: async snapshot => withExperimentalMacFirefoxReaderDirectory({
                rootPath, profileId, experimental: true, signal: snapshot.signal, work: async cwd => {
                    const capability = await prepareMacFirefoxReaderResult({ rootPath, profileId, snapshotPath: snapshot.snapshotPath,
                        expectedUaid: snapshot.uaid, expectedVersion: browser.version });
                    const token = /^firefox-snapshot-([0-9a-f]{32})$/.exec(path.basename(snapshot.snapshotPath));
                    if (!token) throw fail('X_FIREFOX_MAC_FLOW_INVALID');
                    const releaseSnapshot = snapshot.holdForReader(); let releaseCwd;
                    try { releaseCwd = cwd.holdForReader(); } catch (error) { releaseSnapshot(); throw error; }
                    let stopped = false, consumed = false;
                    try {
                        const outcome = await runReader({ executable: browser.executable, browserVersion: browser.version,
                            snapshotPath: snapshot.snapshotPath, cwd: cwd.directory, uaid: snapshot.uaid,
                            resultPath: path.join(rootPath, `firefox-result-${token[1]}.json`), bootstrapBytes: bootstrap,
                            readerPath, readerSha256, signal: snapshot.signal });
                        if (!outcome || Object.keys(outcome).sort().join(',') !== 'stopped,success'
                            || outcome.stopped !== true || typeof outcome.success !== 'boolean') throw fail('X_FIREFOX_MAC_FLOW_UNCONFIRMED');
                        stopped = true;
                        if (!outcome.success || snapshot.signal.aborted) return { state: 'reader_failed' };
                        const after = await verifyInstalledMacFirefox();
                        if (after.executable !== browser.executable || after.version !== browser.version) throw fail('X_FIREFOX_MAC_FLOW_BROWSER_CHANGED');
                        consumed = true;
                        return { state: 'ready', ...(await consumeMacFirefoxReaderResult(capability)) };
                    } finally {
                        // If termination is uncertain, keep both holds and all
                        // files. Never read or discard a possibly active result.
                        if (stopped) {
                            try { if (!consumed) await discardMacFirefoxReaderResult(capability); }
                            finally { releaseCwd(); releaseSnapshot(); }
                        }
                    }
                },
            }) });
        check();
        if (data?.state !== 'ready') throw fail('X_FIREFOX_MAC_FLOW_READER_FAILED');
        const choice = await confirmSave({ otherSubscriptionCount: data.otherSubscriptionCount,
            otherNotificationsMayReachServer: data.otherSubscriptionCount > 0 });
        check(); if (choice === null) return { state: 'cancelled' };
        if (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.getPrototypeOf(choice) !== Object.prototype
            || Object.keys(choice).sort().join(',') !== 'confirmed,directory,filename,otherSitesConsent'
            || choice.confirmed !== true || typeof choice.otherSitesConsent !== 'boolean'
            || data.otherSubscriptionCount > 0 && !choice.otherSitesConsent) throw fail('X_FIREFOX_MAC_FLOW_CONFIRMATION_REQUIRED');
        const output = await writeMacFirefoxExport({ directory: choice.directory, filename: choice.filename, file: data.file,
            confirmed: true, otherSubscriptionCount: data.otherSubscriptionCount, otherSitesConsent: choice.otherSitesConsent, signal });
        return { state: 'saved', ...output };
    } finally { bootstrap?.fill(0); reader?.fill(0); }
}
module.exports = { exportExperimentalMacFirefoxNotifications };
