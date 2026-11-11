'use strict';

// Experimental local-only calibration for an isolated Edge profile. The
// caller creates a protected empty calibration directory and ephemeral TLS
// identity; this module neither opens a user's profile nor saves a transfer.
const { readVerifiedMacEdgeVersion } = require('./edge-mac-browser-version');
const { createMacEdgePeerVerifier } = require('./edge-mac-peer');
const { runEdgeCalibration } = require('./edge-calibration-runner');
const { withMacEdgeEphemeralCertificate } = require('./edge-mac-ephemeral-certificate');
const { spawn } = require('node:child_process');

async function runMacEdgeCalibration({ rootPath, token, pfx, passphrase, certificate,
    identityPath, identitySha256, peerPath, peerSha256, signal }) {
    const browser = await readVerifiedMacEdgeVersion();
    const verifier = createMacEdgePeerVerifier({ identityPath, identitySha256, peerPath, peerSha256 });
    const childrenClosed = [];
    const spawnTracked = (executable, args, options) => {
        const child = spawn(executable, args, options);
        childrenClosed.push(new Promise(resolve => { child.once('close', resolve); }));
        child.once('error', () => {}); // `close` is still required before cleanup.
        return child;
    };
    let result;
    try {
        result = await runEdgeCalibration({ rootPath, token, edgePath: browser.executable, pfx, passphrase, certificate, signal, platform: 'macos',
            captureIdentity: verifier.captureIdentity, authorizePeer: verifier.authorizePeer, spawnBrowser: spawnTracked });
    } finally {
        let timer;
        try {
            const closed = await Promise.race([Promise.all(childrenClosed).then(() => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); timer.unref(); })]);
            // `close` is necessary but not sufficient proof that descendants
            // escaped neither the process nor its inherited handles.
            // eslint-disable-next-line no-unsafe-finally
            if (!closed) throw Object.assign(new Error('X_EDGE_CALIBRATION_CLEANUP_FAILED'), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
        } finally { clearTimeout(timer); }
    }
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
