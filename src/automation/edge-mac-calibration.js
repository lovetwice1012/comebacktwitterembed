'use strict';

// Experimental local-only calibration for an isolated Edge profile. The
// caller creates a protected empty calibration directory and ephemeral TLS
// identity; this module neither opens a user's profile nor saves a transfer.
const { readVerifiedMacEdgeVersion } = require('./edge-mac-browser-version');
const { createMacEdgePeerVerifier } = require('./edge-mac-peer');
const { runEdgeCalibration } = require('./edge-calibration-runner');
const { withMacEdgeEphemeralCertificate } = require('./edge-mac-ephemeral-certificate');

async function runMacEdgeCalibration({ rootPath, token, pfx, passphrase, certificate,
    identityPath, identitySha256, peerPath, peerSha256, signal }) {
    const browser = await readVerifiedMacEdgeVersion();
    const verifier = createMacEdgePeerVerifier({ identityPath, identitySha256, peerPath, peerSha256 });
    const result = await runEdgeCalibration({ rootPath, token, edgePath: browser.executable, pfx, passphrase, certificate, signal, platform: 'macos',
        captureIdentity: verifier.captureIdentity, authorizePeer: verifier.authorizePeer });
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
