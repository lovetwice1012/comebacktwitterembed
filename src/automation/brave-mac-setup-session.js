'use strict';

// Experimental only. No caller may expose this until Mac process-tree and
// Push-receive suppression are verified. UI callbacks never receive secrets.
const { startMacBraveBroker } = require('./brave-mac-broker');
const { captureFromBroker } = require('./chrome-broker-client');
const { exportExperimentalMacBraveNotifications } = require('./brave-mac-export-flow');
const fail = code => Object.assign(new Error(code), { code });

async function waitForClose(broker) {
    let timer;
    try {
        return await Promise.race([broker.releaseComplete,
            new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); timer.unref(); })]);
    } finally { clearTimeout(timer); }
}
async function runExperimentalMacBraveSetup({ rootPath, profileId, helperPath, expectedSha256, ui, experimental }) {
    if (experimental !== true || !ui
        || ['confirmOpen', 'confirmNotifications', 'retryCapture', 'confirmKeychain', 'confirmSave'].some(name => typeof ui[name] !== 'function'))
        throw fail('X_BRAVE_MAC_SETUP_INVALID');
    if (await ui.confirmOpen() !== true) return { state: 'cancelled' };
    let broker;
    try {
        broker = await startMacBraveBroker({ rootPath, profileId });
        let subscription;
        while (!subscription) {
            if (await ui.confirmNotifications() !== true) return { state: 'cancelled' };
            try { subscription = await captureFromBroker({ port: broker.port, token: broker.token }); }
            catch (error) {
                if (!/^X_CHROME_CAPTURE_[A-Z_]+$/.test(error?.code || '')) throw error;
                if (await ui.retryCapture(error.code) !== true) return { state: 'cancelled' };
            }
        }
        // close is necessary but, on its own, not proof that all descendants
        // have exited. The missing native guarantee blocks distribution.
        if (await waitForClose(broker) !== true) throw fail('X_BRAVE_MAC_SETUP_CLEANUP_FAILED');
        if (await ui.confirmKeychain() !== true) return { state: 'cancelled' };
        return await exportExperimentalMacBraveNotifications({ rootPath, profileId, helperPath, expectedSha256, subscription,
            browserVersion: broker.browserVersion, engineVersion: broker.engineVersion, keychainConfirmed: true,
            confirmSave: ui.confirmSave, experimental: true });
    } finally {
        if (broker) {
            try { if (broker.chrome.exitCode === null && broker.chrome.signalCode === null) broker.chrome.kill('SIGTERM'); }
            catch { /* Check the actual close result below. */ }
            try {
                // Cleanup failure must override a successful result.
                // eslint-disable-next-line no-unsafe-finally
                if (await waitForClose(broker) !== true) throw fail('X_BRAVE_MAC_SETUP_CLEANUP_FAILED');
            } finally { await broker.stop(); }
        }
    }
}
module.exports = { runExperimentalMacBraveSetup };
