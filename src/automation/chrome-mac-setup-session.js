'use strict';

// One setup session. UI callbacks are supplied by the local app; no callback
// receives credentials or notification payloads. No upload occurs here.
const { startMacChromeBroker } = require('./chrome-mac-broker');
const { captureFromBroker } = require('./chrome-broker-client');
const { exportMacChromeNotifications } = require('./chrome-mac-export-flow');
const fail = code => Object.assign(new Error(code), { code });

async function runMacChromeSetup({ rootPath, profileId, helperPath, expectedSha256, ui }) {
    if (!ui || ['confirmOpen', 'confirmNotifications', 'retryCapture', 'confirmKeychain', 'confirmSave'].some(name => typeof ui[name] !== 'function'))
        throw fail('X_CHROME_MAC_SETUP_INVALID');
    if (await ui.confirmOpen() !== true) return { state: 'cancelled' };
    let broker;
    try {
        broker = await startMacChromeBroker({ rootPath, profileId });
        let subscription;
        while (!subscription) {
            if (await ui.confirmNotifications() !== true) return { state: 'cancelled' };
            try { subscription = await captureFromBroker({ port: broker.port, token: broker.token }); }
            catch (error) {
                if (!/^X_CHROME_CAPTURE_[A-Z_]+$/.test(error?.code || '')) throw error;
                if (await ui.retryCapture(error.code) !== true) return { state: 'cancelled' };
            }
        }
        // Capture closes the dedicated browser. Wait for the broker to release
        // its profile lock before opening either notification store.
        if (await broker.releaseComplete !== true) throw fail('X_CHROME_MAC_SETUP_CLEANUP_FAILED');
        if (await ui.confirmKeychain() !== true) return { state: 'cancelled' };
        return await exportMacChromeNotifications({ rootPath, profileId, helperPath, expectedSha256, subscription,
            browserVersion: broker.engineVersion, keychainConfirmed: true, confirmSave: ui.confirmSave });
    } finally {
        if (broker) {
            // Only the specific child started by this session may be stopped.
            if (broker.chrome.exitCode === null && broker.chrome.signalCode === null) broker.chrome.kill('SIGTERM');
            let timer;
            try {
                const stopped = await Promise.race([broker.releaseComplete,
                    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); timer.unref(); })]);
                if (!stopped) throw fail('X_CHROME_MAC_SETUP_CLEANUP_FAILED');
            } finally { clearTimeout(timer); await broker.stop(); }
        }
    }
}
module.exports = { runMacChromeSetup };
