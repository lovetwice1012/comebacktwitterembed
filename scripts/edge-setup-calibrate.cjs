'use strict';

// Local setup helper. It performs only synthetic calibration in the owned
// temporary profile and returns protocol metadata over the parent's stdout.
const path = require('node:path');
const { parseUniqueJson } = require('../src/automation/strict-json');
const { createWindowsEdgePeerVerifier } = require('../src/automation/edge-windows-peer');
const { runEdgeCalibration } = require('../src/automation/edge-calibration-runner');
const invalid = () => Object.assign(new Error('X_EDGE_CALIBRATION_CONFIG_INVALID'), { code: 'X_EDGE_CALIBRATION_CONFIG_INVALID' });
function decode(value, max) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3)) throw invalid();
    const bytes = Buffer.from(value, 'base64url');
    if (!bytes.length || bytes.length > max || bytes.toString('base64url') !== value) { bytes.fill(0); throw invalid(); }
    return bytes;
}
async function main() {
    if (process.platform !== 'win32') throw invalid();
    const chunks = [], secrets = []; let total = 0, combined; const controller = new AbortController();
    const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
        for await (const chunk of process.stdin) { total += chunk.length; if (total > 131072) throw invalid(); chunks.push(chunk); }
        combined = Buffer.concat(chunks); const input = parseUniqueJson(combined.toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).sort().join(',') !== 'certificate,edgePath,passphrase,pfx,rootPath,token') throw invalid();
        const pfx = decode(input.pfx, 65536); secrets.push(pfx);
        const certificate = decode(input.certificate, 8192); secrets.push(certificate);
        const systemRoot = process.env.SystemRoot;
        if (typeof systemRoot !== 'string' || !path.isAbsolute(systemRoot)) throw invalid();
        const peer = createWindowsEdgePeerVerifier({ powershellPath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            helperPath: path.resolve(__dirname, 'EdgePeerVerify.ps1') });
        if (!await peer.verifyExecutable(input.edgePath)) throw invalid();
        const result = await runEdgeCalibration({ rootPath: input.rootPath, token: input.token, edgePath: input.edgePath, pfx,
            passphrase: input.passphrase, certificate, captureIdentity: peer.captureIdentity, authorizePeer: peer.authorizePeer, signal: controller.signal });
        process.stdout.write(JSON.stringify({ ok: true, ...result }));
    } finally {
        process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
        combined?.fill(0); for (const chunk of chunks) chunk.fill(0); for (const item of secrets) item.fill(0);
    }
}
main().catch(error => {
    const code = /^X_EDGE_CALIBRATION_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'X_EDGE_CALIBRATION_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, errorCode: code })); process.exitCode = 1;
});
