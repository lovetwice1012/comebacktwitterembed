'use strict';

// Local Mac calibration verifier. Only fixed, hash-checked native helpers are
// executed; no shell, browser data, network payload or credentials are read.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const fail = () => Object.assign(new Error('X_EDGE_CALIBRATION_PEER_FAILED'), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' });
const EDGE_PATH = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const MAX_U64 = (1n << 64n) - 1n;
function identityParts(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}:[0-9]{6}$/.test(value)) throw fail();
    const [seconds, microseconds] = value.split(':');
    if (BigInt(seconds) > MAX_U64) throw fail();
    return [seconds, String(Number(microseconds))];
}
async function checkedHelper(filename, name, expectedHash) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.basename(filename) !== name
        || typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) throw fail();
    const resolved = path.resolve(filename); if (await fs.realpath(resolved) !== resolved) throw fail();
    const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || ![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022) || !(stat.mode & 0o111)
            || stat.nlink !== 1 || stat.size < 1 || stat.size > 4 * 1024 * 1024) throw fail();
        const contents = await handle.readFile();
        if (contents.length !== stat.size || createHash('sha256').update(contents).digest('hex') !== expectedHash) throw fail();
        return resolved;
    } finally { await handle.close(); }
}
function createMacEdgePeerVerifier({ identityPath, identitySha256, peerPath, peerSha256, timeoutMs = 10000, spawnProcess = spawn }) {
    if (typeof spawnProcess !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
        throw fail();
    async function invoke(filename, name, expectedHash, args) {
        let executable;
        try { executable = await checkedHelper(filename, name, expectedHash); } catch { throw fail(); }
        return new Promise((resolve, reject) => {
            let child, done = false, data = Buffer.alloc(0), timer;
            function finish(error, value) {
                if (done) return; done = true; clearTimeout(timer); data.fill(0);
                if (error) reject(fail()); else resolve(value);
            }
            function stop() { try { child?.kill(); } catch { /* Already stopped. */ } }
            try {
                child = spawnProcess(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
                if (!child || !child.stdout || typeof child.kill !== 'function' || typeof child.once !== 'function') throw new Error();
                timer = setTimeout(() => { stop(); finish(true); }, timeoutMs);
                child.stdout.on('data', chunk => {
                    if (!Buffer.isBuffer(chunk) || data.length + chunk.length > 128) { stop(); finish(true); return; }
                    data = Buffer.concat([data, chunk]);
                });
                child.stdout.once('error', () => { stop(); finish(true); });
                child.once('error', () => finish(true));
                child.once('close', code => { if (code !== 0) finish(true); else finish(false, data.toString('ascii')); });
            } catch { stop(); finish(true); }
        });
    }
    async function captureIdentity(pid, executable) {
        if (!Number.isSafeInteger(pid) || pid <= 4 || pid > 2147483647 || executable !== EDGE_PATH) throw fail();
        const text = await invoke(identityPath, 'MacEdgeIdentity', identitySha256, [String(pid)]);
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw fail();
        const result = text.slice(0, -1); identityParts(result); return result;
    }
    async function authorizePeer({ clientPort, serverPort, browserPid, browserStartTicks, browserExecutable }) {
        if (!Number.isInteger(clientPort) || clientPort < 1024 || clientPort > 65535 || !Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535
            || clientPort === serverPort || !Number.isSafeInteger(browserPid) || browserPid <= 4 || browserPid > 2147483647 || browserExecutable !== EDGE_PATH) return false;
        try {
            const [seconds, microseconds] = identityParts(browserStartTicks);
            return await invoke(peerPath, 'MacEdgeSocketOwner', peerSha256,
                [String(browserPid), seconds, microseconds, String(clientPort), String(serverPort)]) === '1';
        } catch { return false; }
    }
    return Object.freeze({ captureIdentity, authorizePeer });
}
module.exports = { createMacEdgePeerVerifier };
