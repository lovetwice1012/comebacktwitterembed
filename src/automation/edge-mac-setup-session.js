'use strict';

// Local setup only: the user saves the file and uploads it separately.
const path = require('node:path');
const { calibrateMacEdgeInOwnedWorkspace } = require('./edge-mac-calibration-workspace');
const { openMacEdgeForSetup } = require('./edge-mac-open');
const { captureFromBroker } = require('./edge-broker-client');
const { exportExperimentalMacEdgeNotifications } = require('./edge-mac-export-flow');
const fail = code => Object.assign(new Error(code), { code });

async function waitForClose(broker) {
    let timer;
    try { const result = await Promise.race([broker.releaseComplete,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); timer.unref(); })]);
        return result === true ? 'confirmed' : result === false ? 'uncertain' : 'waiting'; }
    finally { clearTimeout(timer); }
}
async function runExperimentalMacEdgeSetup({ rootPath, profileId, helperPath, expectedSha256,
    identityPath, identitySha256, peerPath, peerSha256, ui, experimental, signal }) {
    if (experimental !== true || !ui || ['confirmOpen', 'confirmNotifications', 'confirmClosed', 'retryCapture', 'confirmSave'].some(name => typeof ui[name] !== 'function')
        || [helperPath, identityPath, peerPath].some(name => typeof name !== 'string' || !path.isAbsolute(name))
        || [expectedSha256, identitySha256, peerSha256].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_EDGE_MAC_SETUP_INVALID');
    if (signal?.aborted || await ui.confirmOpen() !== true || signal?.aborted) return { state: 'cancelled' };
    const calibration = await calibrateMacEdgeInOwnedWorkspace({ rootPath, profileId, identityPath, identitySha256, peerPath, peerSha256, signal });
    if (signal?.aborted) return { state: 'cancelled' };
    let broker;
    try {
        broker = await openMacEdgeForSetup({ rootPath, profileId, helperPath, expectedSha256 });
        if (broker.engineVersion !== calibration.browserVersion) throw fail('X_EDGE_MAC_SETUP_BROWSER_CHANGED');
        let subscription;
        while (!subscription) {
            if (signal?.aborted || await ui.confirmNotifications() !== true || signal?.aborted) return { state: 'cancelled' };
            try { subscription = await captureFromBroker({ port: broker.port, token: broker.token, includeApplicationServerKey: true }); }
            catch (error) {
                if (!/^X_CHROME_CAPTURE_[A-Z_]+$/.test(error?.code || '')) throw error;
                if (signal?.aborted || await ui.retryCapture() !== true || signal?.aborted) return { state: 'cancelled' };
            }
        }
        // The broker asks its owned browser to close after capture. A child
        // process may take longer; ask the user to finish closing that same
        // setup browser before accessing its notification store.
        for (;;) {
            const status = await waitForClose(broker);
            if (status === 'confirmed') break;
            if (status === 'uncertain') throw fail('X_EDGE_MAC_SETUP_CLEANUP_FAILED');
            if (signal?.aborted || await ui.confirmClosed() !== true || signal?.aborted) return { state: 'cancelled' };
        }
        if (signal?.aborted) return { state: 'cancelled' };
        return await exportExperimentalMacEdgeNotifications({ rootPath, profileId, helperPath, expectedSha256, subscription,
            browserVersion: calibration.browserVersion, connectVersion: calibration.connectVersion, agent: calibration.agent,
            client: calibration.client, confirmSave: ui.confirmSave, experimental: true, signal });
    } finally {
        if (broker) {
            try { if (broker.chrome.exitCode === null && broker.chrome.signalCode === null) broker.chrome.kill('SIGTERM'); }
            catch { /* An uncertain shutdown leaves the profile locked. */ }
            try {
                // eslint-disable-next-line no-unsafe-finally
                if (await waitForClose(broker) !== 'confirmed') throw fail('X_EDGE_MAC_SETUP_CLEANUP_FAILED');
            } finally { await broker.stop(); }
        }
    }
}
module.exports = { runExperimentalMacEdgeSetup };
