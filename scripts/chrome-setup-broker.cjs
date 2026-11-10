'use strict';
const { startChromeBroker } = require('../src/automation/chrome-private-broker');
const { parseUniqueJson } = require('../src/automation/strict-json');
async function main() {
    let length = 0; const chunks = [];
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 8192) throw new Error(); chunks.push(chunk); }
    const input = parseUniqueJson(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'chromePath,profilePath') throw new Error();
    const broker = await startChromeBroker({ chromePath: input.chromePath, profilePath: input.profilePath });
    process.stdout.write(JSON.stringify({ ok: true, port: broker.port, token: broker.token, pid: broker.pid, browserPid: broker.browserPid, engineVersion: broker.engineVersion }) + '\n');
}
main().catch(() => { process.stdout.write('{"ok":false,"errorCode":"X_CHROME_BROKER_FAILED"}\n'); process.exitCode = 1; });
