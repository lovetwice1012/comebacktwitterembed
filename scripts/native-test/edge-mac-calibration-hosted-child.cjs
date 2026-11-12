'use strict';

// Disposable CI child only. No real browser profile, X account, or credentials
// are read, and protocol metadata is not written to logs or disk by this code.
if (process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1'
    || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || typeof process.send !== 'function') process.exit(1);
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const webpush = require('web-push');
const { safeCalibrationError } = require('./edge-mac-fixture-error.cjs');
const { createHostedVersionDiagnostic } = require('./edge-mac-version-diagnostic.cjs');
// Capture only the local synthetic subscription over the existing private
// DevTools pipe. This wrapper is loaded only in this isolated CI process.
const pipeId = require.resolve('../../src/automation/edge-cdp-pipe'), original = require(pipeId);
const vapid = webpush.generateVAPIDKeys(); let subscription;
require.cache[pipeId].exports = { ...original, createChromePipe(...args) {
    const pipe = original.createChromePipe(...args);
    if (!pipe.prepareCalibration) return pipe;
    return { ...pipe, async prepareCalibration(_applicationServerKey) {
        // Only this disposable subscription uses a test-owned VAPID key.
        const result = await pipe.prepareCalibration(vapid.publicKey);
        const captured = await pipe.capture();
        if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(captured.scope) || subscription) throw new Error('FIXTURE_SCOPE_INVALID');
        subscription = { ...captured, applicationServerKey: vapid.publicKey }; return result;
    } };
} };
const versionDiagnostic = createHostedVersionDiagnostic();
const versionId = require.resolve('../../src/automation/edge-mac-browser-version');
const originalVersion = require(versionId);
require.cache[versionId].exports = { ...originalVersion, readVerifiedMacEdgeVersion: versionDiagnostic.verify };
const { runMacEdgeCalibrationWithEphemeralCertificate } = require('../../src/automation/edge-mac-calibration');

process.once('message', async input => {
    try {
        if (!input || typeof input !== 'object' || typeof input.rootPath !== 'string' || typeof input.token !== 'string'
            || typeof input.identityPath !== 'string' || typeof input.peerPath !== 'string') throw new Error();
        const hash = async name => createHash('sha256').update(await fs.readFile(name)).digest('hex');
        const result = await runMacEdgeCalibrationWithEphemeralCertificate({ rootPath: input.rootPath, token: input.token,
            identityPath: input.identityPath, identitySha256: await hash(input.identityPath),
            peerPath: input.peerPath, peerSha256: await hash(input.peerPath) });
        if (!result || !['1', '2'].includes(result.connectVersion) || !result.agent || !result.client || !subscription) throw new Error();
        process.send({ ok: true, connectVersion: result.connectVersion, browserVersion: result.browserVersion,
            agent: result.agent, client: result.client, subscription, vapid }, () => process.disconnect());
    } catch (error) {
        const code = safeCalibrationError(error?.code);
        process.send({ ok: false, code, versionDiagnostic: versionDiagnostic.snapshot() }, () => { process.exitCode = 1; process.disconnect(); });
    }
});
