'use strict';

// Experimental local-only calibration for an isolated Edge profile. The
// caller creates a protected empty calibration directory and ephemeral TLS
// identity; this module neither opens a user's profile nor saves a transfer.
const { verifyInstalledEdge } = require('./edge-mac-broker');
const { createMacEdgePeerVerifier } = require('./edge-mac-peer');
const { runEdgeCalibration } = require('./edge-calibration-runner');

async function runMacEdgeCalibration({ rootPath, token, pfx, passphrase, certificate,
    identityPath, identitySha256, peerPath, peerSha256, signal }) {
    const edgePath = await verifyInstalledEdge();
    const verifier = createMacEdgePeerVerifier({ identityPath, identitySha256, peerPath, peerSha256 });
    return runEdgeCalibration({ rootPath, token, edgePath, pfx, passphrase, certificate, signal, platform: 'macos',
        captureIdentity: verifier.captureIdentity, authorizePeer: verifier.authorizePeer });
}
module.exports = { runMacEdgeCalibration };
