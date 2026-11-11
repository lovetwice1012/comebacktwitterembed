'use strict';

// Experimental only: sandbox-exec is deprecated and this process-group
// check is not proof against every possible escape. The distribution must not
// enable this supervisor until its security and lifecycle limits are reviewed.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { encodeMacFirefoxReaderInput } = require('./firefox-mac-reader-protocol');
const { parseUniqueJson } = require('./strict-json');
const fail = () => Object.assign(new Error('X_FIREFOX_MAC_SUPERVISOR_INVALID'), { code: 'X_FIREFOX_MAC_SUPERVISOR_INVALID' });
const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';
const SANDBOX = '/usr/bin/sandbox-exec';
const POLICY = '(version 1)(allow default)(deny process-fork)(deny network*)';

async function candidateReady(filename, resultNonce) {
    let handle, bytes;
    try {
        handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1
            || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 32768) return false;
        bytes = Buffer.alloc(before.size + 1); let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        const after = await handle.stat(), current = await fs.lstat(filename);
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.isSymbolicLink() || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
            || current.uid !== before.uid || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) return false;
        const value = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)), 32);
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.proof !== resultNonce) return null;
        if (value.ok === true && Object.keys(value).sort().join(',') === 'export,ok,otherSubscriptionCount,proof') return 'success';
        if (value.ok === false && Object.keys(value).sort().join(',') === 'errorCode,ok,proof') return 'failure';
        return null;
    } catch { return false; }
    finally { bytes?.fill(0); await handle?.close().catch(() => {}); }
}

async function runExperimentalMacFirefoxReader({ executable, browserVersion, snapshotPath, cwd, uaid,
    resultPath, bootstrapBytes, readerPath, readerSha256, resultNonce, signal, experimental }) {
    if (experimental !== true || process.platform !== 'darwin' || executable !== FIREFOX || !(signal instanceof AbortSignal)
        || !Buffer.isBuffer(bootstrapBytes) || bootstrapBytes.length < 1 || bootstrapBytes.length > 65536) throw fail();
    if (signal.aborted) return { stopped: true, success: false };
    let input, source;
    try {
        const token = typeof snapshotPath === 'string' && /^firefox-snapshot-([0-9a-f]{32})$/.exec(path.basename(snapshotPath));
        if (!token || !path.isAbsolute(snapshotPath) || path.resolve(snapshotPath) !== snapshotPath
            || typeof cwd !== 'string' || path.dirname(cwd) !== path.dirname(snapshotPath)
            || !/^firefox-reader-cwd-[0-9a-f]{32}$/.test(path.basename(cwd))
            || resultPath !== path.join(path.dirname(snapshotPath), `firefox-result-${token[1]}.json`)) throw fail();
        const [snapshot, directory, sandbox] = await Promise.all([fs.lstat(snapshotPath), fs.lstat(cwd), fs.lstat(SANDBOX)]);
        if (!snapshot.isDirectory() || snapshot.isSymbolicLink() || snapshot.uid !== process.getuid() || (snapshot.mode & 0o777) !== 0o700
            || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o500
            || !sandbox.isFile() || sandbox.isSymbolicLink() || sandbox.uid !== 0 || sandbox.mode & 0o022
            || await fs.realpath(snapshotPath) !== snapshotPath || await fs.realpath(cwd) !== cwd || (await fs.readdir(cwd)).length) throw fail();
        source = new TextDecoder('utf-8', { fatal: true }).decode(bootstrapBytes);
        if (source.includes('\0')) throw fail();
        try { await fs.lstat(resultPath); throw fail(); } catch (error) { if (error?.code !== 'ENOENT') throw fail(); }
        input = encodeMacFirefoxReaderInput({ snapshotPath, resultPath, readerPath, readerSha256, uaid, browserVersion, resultNonce });
    } catch { input?.fill(0); throw fail(); }

    if (signal.aborted) { input.fill(0); return { stopped: true, success: false }; }
    let child, timer, pollTimer, killTimer, ready = null, inputFailed = false, aborted = false, ended = false;
    let exitCode = null, exitSignal = null, stoppedForResult = false, polling = Promise.resolve();
    const stop = () => { try { child?.kill('SIGTERM'); } catch { /* Unconfirmed termination remains held by the caller. */ } };
    try {
        child = spawn(SANDBOX, ['-p', POLICY, FIREFOX, '-xpcshell', '-e', source], { cwd, detached: true,
            env: { HOME: snapshotPath, TMPDIR: snapshotPath, PATH: '/usr/bin:/bin', MOZ_HEADLESS: '1',
                MOZ_DISABLE_NONLOCAL_CONNECTIONS: '1', CBTE_GECKO_INPUT: 'stdin-v1' }, stdio: ['pipe', 'ignore', 'ignore'] });
        const exited = new Promise(resolve => {
            child.once('error', () => {
                inputFailed = true;
                if (!child.pid) { ended = true; resolve(); } else stop();
            });
            child.once('exit', (code, terminationSignal) => { exitCode = code; exitSignal = terminationSignal; ended = true; resolve(); });
        });
        child.stdin.once('error', () => { inputFailed = true; stop(); });
        child.stdin.end(input, () => { input.fill(0); });
        const abort = () => { aborted = true; stop(); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        pollTimer = setInterval(() => {
            polling = polling.then(async () => {
                if (!ended && !ready && !aborted) {
                    const candidate = await candidateReady(resultPath, resultNonce);
                    if (candidate) { ready = candidate; stoppedForResult = true; stop(); }
                }
            }).catch(() => {});
        }, 100);
        try {
            const timed = new Promise(resolve => { timer = setTimeout(() => resolve(false), 45000); });
            if (!await Promise.race([exited.then(() => true), timed])) {
                stop();
                const grace = new Promise(resolve => { killTimer = setTimeout(() => resolve(false), 3000); });
                if (!await Promise.race([exited.then(() => true), grace])) {
                    try { child.kill('SIGKILL'); } catch { /* Do not touch unrelated processes. */ }
                    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
                }
            }
        } finally { signal.removeEventListener('abort', abort); }
        clearInterval(pollTimer); await polling;
        if (ended && !ready && !aborted && !inputFailed) ready = await candidateReady(resultPath, resultNonce);
        let groupGone = false;
        if (ended && child.pid) {
            try { process.kill(-child.pid, 0); }
            catch (error) { if (error.code === 'ESRCH') groupGone = true; }
        } else if (ended && !child.pid) groupGone = true;
        return { stopped: ended && groupGone, success: ended && groupGone && ready === 'success' && !aborted && !inputFailed
            && (exitCode === 0 || stoppedForResult && exitSignal === 'SIGTERM') };
    } finally {
        clearTimeout(timer); clearTimeout(killTimer); clearInterval(pollTimer); input.fill(0); child?.stdin?.destroy();
    }
}
module.exports = { runExperimentalMacFirefoxReader };
