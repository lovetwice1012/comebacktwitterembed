'use strict';

// Local-only helper. Standard input and output belong to the setup process;
// this program opens neither a network connection nor an upload destination.
const { ClassicLevel } = require('classic-level');
const { readEdgeSnapshot, inspectEdgeSnapshot } = require('../src/automation/edge-wns-snapshot-io');
const { parseUniqueJson } = require('../src/automation/strict-json');
const invalid = () => Object.assign(new Error('X_EDGE_READER_INPUT_INVALID'), { code: 'X_EDGE_READER_INPUT_INVALID' });
function exact(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names.slice().sort().join(',')) throw invalid();
}
function decode(value, length) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(length * 4 / 3)) throw invalid();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== length || bytes.toString('base64url') !== value) { bytes.fill(0); throw invalid(); }
    return bytes;
}
async function main() {
    const chunks = [], decoded = []; let size = 0, combined;
    try {
        for await (const chunk of process.stdin) {
            size += chunk.length; if (size > 32768) throw invalid(); chunks.push(chunk);
        }
        combined = Buffer.concat(chunks); const input = parseUniqueJson(combined.toString('utf8'));
        if (input?.mode === 'inspect') {
            exact(input, ['snapshotPath', 'token', 'mode']);
            const result = await inspectEdgeSnapshot({ snapshotPath: input.snapshotPath, token: input.token,
                dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }) });
            process.stdout.write(JSON.stringify({ ok: true, ...result })); return;
        }
        exact(input, ['snapshotPath', 'token', 'expected', 'browserVersion', 'agent', 'client']);
        exact(input.expected, ['endpoint', 'publicKey', 'auth', 'applicationServerKey']);
        const take = (value, length) => { const result = decode(value, length); decoded.push(result); return result; };
        const expected = { endpoint: input.expected.endpoint, publicKey: take(input.expected.publicKey, 65),
            auth: take(input.expected.auth, 16), applicationServerKey: take(input.expected.applicationServerKey, 65) };
        const result = await readEdgeSnapshot({ snapshotPath: input.snapshotPath, token: input.token, expected,
            browserVersion: input.browserVersion, agent: input.agent, client: input.client,
            dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }) });
        process.stdout.write(JSON.stringify({ ok: true, ...result }));
    } finally { for (const chunk of chunks) chunk.fill(0); combined?.fill(0); for (const item of decoded) item.fill(0); }
}
main().catch(error => {
    // Do not return paths, subscription material or exception details.
    const code = ['X_EDGE_READER_INPUT_INVALID', 'X_EDGE_WNS_SNAPSHOT_INVALID'].includes(error?.code)
        ? error.code : 'X_EDGE_READER_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, errorCode: code })); process.exitCode = 1;
});
