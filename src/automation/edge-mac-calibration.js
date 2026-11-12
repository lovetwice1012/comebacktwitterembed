'use strict';

// Experimental local-only calibration for an isolated Edge profile. The
// caller creates a protected empty calibration directory and ephemeral TLS
// identity; this module neither opens a user's profile nor saves a transfer.
const { readVerifiedMacEdgeVersion } = require('./edge-mac-browser-version');
const { createMacEdgePeerVerifier } = require('./edge-mac-peer');
const { runEdgeCalibration } = require('./edge-calibration-runner');
const { withMacEdgeEphemeralCertificate } = require('./edge-mac-ephemeral-certificate');
const { spawn } = require('node:child_process');
const { waitForMacProcessGroupExit } = require('./chrome-mac-process-group');

async function runMacEdgeCalibration({ rootPath, token, pfx, passphrase, certificate,
    identityPath, identitySha256, peerPath, peerSha256, signal, onCleanupConfirmed }) {
    if (onCleanupConfirmed !== undefined && typeof onCleanupConfirmed !== 'function')
        throw Object.assign(new Error('X_EDGE_CALIBRATION_CONFIG_INVALID'), { code: 'X_EDGE_CALIBRATION_CONFIG_INVALID' });
    let browser, verifier;
    try {
        browser = await readVerifiedMacEdgeVersion();
        verifier = createMacEdgePeerVerifier({ identityPath, identitySha256, peerPath, peerSha256 });
    } catch (error) {
        // No browser, relay, or listener has been started during preflight.
        if (onCleanupConfirmed) onCleanupConfirmed();
        throw error;
    }
    const children = new Map();
    const spawnTracked = (executable, args, options) => {
        const child = spawn(executable, args, { ...options, detached: true });
        children.set(child, { closed: new Promise(resolve => { child.once('close', resolve); }), checked: null });
        child.once('error', () => {}); // `close` is still required before cleanup.
        return child;
    };
    const waitForShutdown = child => {
        const entry = children.get(child);
        if (!entry) throw Object.assign(new Error('X_EDGE_CALIBRATION_CLEANUP_FAILED'), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
        if (!entry.checked) entry.checked = (async () => {
            let timer;
            try {
                const closed = await Promise.race([entry.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
                if (!closed || child.pid && !await waitForMacProcessGroupExit(child.pid))
                    throw Object.assign(new Error('X_EDGE_CALIBRATION_CLEANUP_FAILED'), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
            } finally { clearTimeout(timer); }
        })();
        return entry.checked;
    };
    let result, runnerCleanupConfirmed = false;
    try {
        try {
            result = await runEdgeCalibration({ rootPath, token, edgePath: browser.executable, pfx, passphrase, certificate, signal, platform: 'macos',
                captureIdentity: verifier.captureIdentity, authorizePeer: verifier.authorizePeer, spawnBrowser: spawnTracked, afterBrowserClose: waitForShutdown });
            runnerCleanupConfirmed = true;
        } catch (error) {
            // The runner reports CLEANUP_FAILED if its browser, relay, or
            // listener could not be closed. Other failures are reported only
            // after its cleanup block has completed.
            if (error?.code !== 'X_EDGE_CALIBRATION_CLEANUP_FAILED') runnerCleanupConfirmed = true;
            throw error;
        }
    } finally {
        let timer;
        try {
            const closed = await Promise.race([Promise.all([...children.keys()].map(waitForShutdown)).then(() => true, () => false),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), 20000); timer.unref(); })]);
            // Group termination does not prove that no descendant escaped it.
            // eslint-disable-next-line no-unsafe-finally
            if (!closed) throw Object.assign(new Error('X_EDGE_CALIBRATION_CLEANUP_FAILED'), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
            if (runnerCleanupConfirmed && onCleanupConfirmed) onCleanupConfirmed();
        } finally { clearTimeout(timer); }
    }
    if (!result || !['1', '2'].includes(result.connectVersion) || !result.agent || !result.client)
        throw Object.assign(new Error('X_EDGE_CALIBRATION_PROTOCOL_INVALID'), { code: 'X_EDGE_CALIBRATION_PROTOCOL_INVALID' });
    const after = await readVerifiedMacEdgeVersion();
    if (result.browserVersion !== browser.browserVersion || after.browserVersion !== browser.browserVersion
        || after.executable !== browser.executable)
        throw Object.assign(new Error('X_EDGE_CALIBRATION_BROWSER_CHANGED'), { code: 'X_EDGE_CALIBRATION_BROWSER_CHANGED' });
    return result;
}
async function runMacEdgeCalibrationWithEphemeralCertificate(options) {
    let started = false;
    try {
        return await withMacEdgeEphemeralCertificate(material => { started = true; return runMacEdgeCalibration({ ...options, ...material }); });
    } catch (error) {
        // If identity generation failed before invoking the runner, it could
        // not have started a browser or listener in the workspace.
        if (!started && typeof options?.onCleanupConfirmed === 'function') options.onCleanupConfirmed();
        throw error;
    }
}
module.exports = { runMacEdgeCalibration, runMacEdgeCalibrationWithEphemeralCertificate };
