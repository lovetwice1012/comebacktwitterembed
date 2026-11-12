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
    identityPath, identitySha256, peerPath, peerSha256, signal }) {
    const browser = await readVerifiedMacEdgeVersion();
    const verifier = createMacEdgePeerVerifier({ identityPath, identitySha256, peerPath, peerSha256 });
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
    let result;
    try {
        result = await runEdgeCalibration({ rootPath, token, edgePath: browser.executable, pfx, passphrase, certificate, signal, platform: 'macos',
            captureIdentity: verifier.captureIdentity, authorizePeer: verifier.authorizePeer, spawnBrowser: spawnTracked, afterBrowserClose: waitForShutdown });
    } finally {
        let timer;
        try {
            const closed = await Promise.race([Promise.all([...children.keys()].map(waitForShutdown)).then(() => true, () => false),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), 20000); timer.unref(); })]);
            // Group termination does not prove that no descendant escaped it.
            // eslint-disable-next-line no-unsafe-finally
            if (!closed) throw Object.assign(new Error('X_EDGE_CALIBRATION_CLEANUP_FAILED'), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
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
    return withMacEdgeEphemeralCertificate(material => runMacEdgeCalibration({ ...options, ...material }));
}
module.exports = { runMacEdgeCalibration, runMacEdgeCalibrationWithEphemeralCertificate };
