'use strict';
// Hosted disposable calibration fixture. No user profile, account or data.
if (process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1'
    || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || typeof process.send !== 'function') process.exit(1);
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const webpush = require('web-push');
const { safeCalibrationError } = require('./edge-mac-fixture-error.cjs');
const originalServer = http.createServer;
http.createServer = handler => originalServer((request, response) => {
    if (request.url === '/sw.js') {
        response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
        response.end("self.addEventListener('push',e=>e.waitUntil((async()=>{for(const c of await self.clients.matchAll({type:'window',includeUncontrolled:true}))c.postMessage('cbte-fixture-push');await fetch('/push-event');const x=e.data?e.data.text():'';await fetch('/delivered?tag='+encodeURIComponent(x));await self.registration.showNotification('Fixture')})()));self.addEventListener('message',e=>{e.source?.postMessage('cbte-fixture-pong');e.waitUntil(fetch('/delivered?tag='+encodeURIComponent(e.data))) });");
    } else handler(request, response);
});
const pipeId = require.resolve('../../src/automation/edge-cdp-pipe'), original = require(pipeId);
const vapid = webpush.generateVAPIDKeys(); let subscription;
require.cache[pipeId].exports = { ...original, createChromePipe(...args) {
    const pipe = original.createChromePipe(...args); if (!pipe.prepareCalibration) return pipe;
    return { ...pipe, async prepareCalibration() {
        const result = await pipe.prepareCalibration(vapid.publicKey), captured = await pipe.capture();
        if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(captured.scope) || subscription) throw new Error('fixture scope');
        subscription = { ...captured, applicationServerKey: vapid.publicKey }; return result;
    } };
} };
const { runMacEdgeCalibrationWithEphemeralCertificate } = require('../../src/automation/edge-mac-calibration');
process.once('message', async input => {
    try {
        if (!input || typeof input.rootPath !== 'string' || typeof input.token !== 'string'
            || typeof input.identityPath !== 'string' || typeof input.peerPath !== 'string') throw new Error('invalid fixture');
        const hash = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
        let cleanupConfirmed = false;
        const result = await runMacEdgeCalibrationWithEphemeralCertificate({ rootPath: input.rootPath, token: input.token,
            identityPath: input.identityPath, identitySha256: await hash(input.identityPath),
            peerPath: input.peerPath, peerSha256: await hash(input.peerPath), onCleanupConfirmed: () => { cleanupConfirmed = true; } });
        if (!result || !['1', '2'].includes(result.connectVersion) || !subscription || !cleanupConfirmed) throw new Error('fixture calibration');
        process.send({ ok: true, ...result, subscription, vapid, cleanupConfirmed: true }, () => process.disconnect());
    } catch (error) {
        process.send({ ok: false, code: safeCalibrationError(error?.code) }, () => { process.exitCode = 1; process.disconnect(); });
    }
});
