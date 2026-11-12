'use strict';
const { startChromeBroker } = require('../src/automation/edge-private-broker');
const { parseUniqueJson } = require('../src/automation/strict-json');
async function main() {
    let length = 0; const chunks = []; let combined;
    try {
        for await (const chunk of process.stdin) { length += chunk.length; if (length > 8192) throw new Error(); chunks.push(chunk); }
        combined = Buffer.concat(chunks); const input = parseUniqueJson(combined.toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'edgePath,profilePath,suppressReceive'
            || typeof input.suppressReceive !== 'boolean') throw new Error();
        const broker = await startChromeBroker({ chromePath: input.edgePath, profilePath: input.profilePath, browserMode: 'edge', includeApplicationServerKey: true,
            suppressReceive: input.suppressReceive });
        process.stdout.write(JSON.stringify({ ok: true, port: broker.port, token: broker.token, pid: broker.pid, browserPid: broker.browserPid, engineVersion: broker.engineVersion }) + '\n');
    } finally { combined?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
main().catch(() => { process.stdout.write('{"ok":false,"errorCode":"X_EDGE_BROKER_FAILED"}\n'); process.exitCode = 1; });
