'use strict';

// Executes the signed package's fixed PowerShell verifier without a shell.
// It returns only a process start time or a boolean, never socket payloads.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseUniqueJson } = require('./strict-json');
const fail = () => Object.assign(new Error('X_EDGE_CALIBRATION_PEER_FAILED'), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' });
function createWindowsEdgePeerVerifier({ powershellPath, helperPath, timeoutMs = 10000, spawnProcess = spawn }) {
    if (typeof powershellPath !== 'string' || !path.isAbsolute(powershellPath) || path.basename(powershellPath).toLowerCase() !== 'powershell.exe'
        || typeof helperPath !== 'string' || !path.isAbsolute(helperPath) || path.basename(helperPath) !== 'EdgePeerVerify.ps1'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || typeof spawnProcess !== 'function') throw fail();
    async function invoke(args) {
        return new Promise((resolve, reject) => {
            let child, done = false, data = Buffer.alloc(0), timer;
            function finish(error, value) {
                if (done) return; done = true; clearTimeout(timer); data.fill(0);
                if (error) reject(fail()); else resolve(value);
            }
            try {
                child = spawnProcess(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, ...args],
                    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
                if (!child || !child.stdout || typeof child.kill !== 'function' || typeof child.once !== 'function') throw new Error();
                timer = setTimeout(() => { try { child.kill(); } catch {} finish(true); }, timeoutMs);
                child.stdout.on('data', chunk => {
                    if (!Buffer.isBuffer(chunk) || data.length + chunk.length > 1024) { try { child.kill(); } catch {} finish(true); return; }
                    data = Buffer.concat([data, chunk]);
                });
                child.stdout.once('error', () => { try { child.kill(); } catch {} finish(true); });
                child.once('error', () => finish(true));
                child.once('close', code => {
                    if (code !== 0) { finish(true); return; }
                    try { finish(false, parseUniqueJson(data.toString('utf8'))); } catch { finish(true); }
                });
            } catch { if (child) try { child.kill(); } catch {} finish(true); }
        });
    }
    async function captureIdentity(pid, executable) {
        if (!Number.isSafeInteger(pid) || pid <= 4 || typeof executable !== 'string' || !path.isAbsolute(executable)) throw fail();
        const result = await invoke(['-Mode', 'Identity', '-BrowserPid', String(pid), '-BrowserExecutable', executable]);
        if (!result || Object.keys(result).sort().join(',') !== 'ok,startTicks' || result.ok !== true || typeof result.startTicks !== 'string' || !/^\d{18}$/.test(result.startTicks)) throw fail();
        return result.startTicks;
    }
    async function verifyExecutable(executable) {
        if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'msedge.exe') return false;
        try {
            const result = await invoke(['-Mode', 'Verify', '-BrowserExecutable', executable]);
            return Boolean(result && Object.keys(result).join(',') === 'ok' && result.ok === true);
        } catch { return false; }
    }
    async function authorizePeer({ clientPort, serverPort, browserPid, browserStartTicks, browserExecutable }) {
        if (!Number.isInteger(clientPort) || clientPort < 1024 || clientPort > 65535 || !Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535
            || !Number.isSafeInteger(browserPid) || browserPid <= 4 || typeof browserStartTicks !== 'string' || !/^\d{18}$/.test(browserStartTicks)
            || typeof browserExecutable !== 'string' || !path.isAbsolute(browserExecutable)) return false;
        try {
            const result = await invoke(['-Mode', 'Peer', '-BrowserPid', String(browserPid), '-BrowserExecutable', browserExecutable,
                '-BrowserStartTicks', browserStartTicks, '-ClientPort', String(clientPort), '-ServerPort', String(serverPort)]);
            return Boolean(result && Object.keys(result).join(',') === 'ok' && result.ok === true);
        } catch { return false; }
    }
    return Object.freeze({ verifyExecutable, captureIdentity, authorizePeer });
}
module.exports = { createWindowsEdgePeerVerifier };
