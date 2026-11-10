'use strict';

// The setup tool sends its protected one-time broker capability over stdin.
// This client can request only X subscription capture and browser close.
const { captureFromBroker } = require('../src/automation/chrome-broker-client');
const { parseUniqueJson } = require('../src/automation/strict-json');
async function main() {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 4096) throw new Error('X_CHROME_CAPTURE_INVALID');
        chunks.push(chunk);
    }
    const input = parseUniqueJson(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'port,token')
        throw new Error('X_CHROME_CAPTURE_INVALID');
    const subscription = await captureFromBroker(input);
    process.stdout.write(JSON.stringify({ ok: true, subscription }));
}
main().catch(error => {
    const code = /^X_CHROME_CAPTURE_[A-Z_]+$/.test(String(error?.code || error?.message || ''))
        ? String(error.code || error.message) : 'X_CHROME_CAPTURE_INVALID';
    process.stdout.write(JSON.stringify({ ok: false, errorCode: code }));
    process.exitCode = 1;
});
