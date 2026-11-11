'use strict';

// Disposable CI child only. No real browser profile, X account, or credentials
// are read, and protocol metadata is not written to logs or disk by this code.
if (process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1'
    || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || typeof process.send !== 'function') process.exit(1);
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { runMacEdgeCalibrationWithEphemeralCertificate } = require('../../src/automation/edge-mac-calibration');

process.once('message', async input => {
    try {
        if (!input || typeof input !== 'object' || typeof input.rootPath !== 'string' || typeof input.token !== 'string'
            || typeof input.identityPath !== 'string' || typeof input.peerPath !== 'string') throw new Error();
        const hash = async name => createHash('sha256').update(await fs.readFile(name)).digest('hex');
        const result = await runMacEdgeCalibrationWithEphemeralCertificate({ rootPath: input.rootPath, token: input.token,
            identityPath: input.identityPath, identitySha256: await hash(input.identityPath),
            peerPath: input.peerPath, peerSha256: await hash(input.peerPath) });
        if (!result || !['1', '2'].includes(result.connectVersion) || !result.agent || !result.client) throw new Error();
        process.send({ ok: true, connectVersion: result.connectVersion }, () => process.disconnect());
    } catch (error) {
        const code = /^X_(?:EDGE_MAC|EDGE_CALIBRATION)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'FIXTURE_FAILED';
        process.send({ ok: false, code }, () => { process.exitCode = 1; process.disconnect(); });
    }
});
