'use strict';

// Experimental composition only. It does not upload or enable distribution.
// The caller supplies UI callbacks; Firefox remains under the user's control.
const { startExperimentalMacFirefox } = require('./firefox-mac-setup-browser');
const { exportExperimentalMacFirefoxNotifications } = require('./firefox-mac-export-flow');
const { runExperimentalMacFirefoxReader } = require('./firefox-mac-reader-supervisor');
const fail = code => Object.assign(new Error(code), { code });

async function runExperimentalMacFirefoxSetup({ rootPath, profileId, helperPath, expectedSha256,
    bootstrapPath, bootstrapSha256, readerPath, readerSha256, ui, experimental, signal }) {
    if (experimental !== true || !ui || ['confirmOpen', 'confirmClosed', 'confirmSave'].some(name => typeof ui[name] !== 'function')
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_FIREFOX_MAC_SETUP_INVALID');
    if (signal?.aborted || await ui.confirmOpen() !== true || signal?.aborted) return { state: 'cancelled' };
    const browser = await startExperimentalMacFirefox({ rootPath, profileId, experimental: true });
    if (signal?.aborted || await ui.confirmClosed() !== true || signal?.aborted) return { state: 'cancelled' };
    let timer, cancel;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 15000); });
    const aborted = new Promise(resolve => { cancel = () => resolve('aborted'); signal?.addEventListener('abort', cancel, { once: true }); });
    let released;
    try {
        if (signal?.aborted) return { state: 'cancelled' };
        released = await Promise.race([browser.releaseComplete, timeout, aborted]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    if (released === 'aborted' || signal?.aborted) return { state: 'cancelled' };
    if (released === 'timeout') throw fail('X_FIREFOX_MAC_SETUP_BROWSER_OPEN');
    if (released !== true) throw fail('X_FIREFOX_MAC_SETUP_CLEANUP_FAILED');
    return exportExperimentalMacFirefoxNotifications({ rootPath, profileId, helperPath, expectedSha256,
        bootstrapPath, bootstrapSha256, readerPath, readerSha256, experimental: true, signal,
        runReader: input => runExperimentalMacFirefoxReader({ ...input, experimental: true }),
        confirmSave: ui.confirmSave });
}
module.exports = { runExperimentalMacFirefoxSetup };
