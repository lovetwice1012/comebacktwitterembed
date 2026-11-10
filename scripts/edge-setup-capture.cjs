'use strict';
const { captureFromBroker } = require('../src/automation/edge-broker-client');
const { parseUniqueJson } = require('../src/automation/strict-json');
async function main() {
    const chunks = []; let size = 0, combined;
    try {
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 4096) throw new Error(); chunks.push(chunk); }
        combined = Buffer.concat(chunks); const input = parseUniqueJson(combined.toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'port,token') throw new Error();
        const subscription = await captureFromBroker({ ...input, includeApplicationServerKey: true });
        process.stdout.write(JSON.stringify({ ok: true, subscription }));
    } finally { combined?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
main().catch(error => {
    const code = /^X_CHROME_CAPTURE_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'X_EDGE_CAPTURE_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, errorCode: code })); process.exitCode = 1;
});
