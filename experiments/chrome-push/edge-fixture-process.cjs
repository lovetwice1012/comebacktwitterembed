'use strict';
// Supervises only child workers launched by this synthetic fixture.
const { fork } = require('node:child_process');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function startSyntheticWorker(input) {
    if (process.env.NODE_ENV !== 'test' || !/^cbte_automation_test_[0-9a-f]{20}$/.test(input?.schema || '') || input.dbPort !== 33621)
        throw new Error('PROBE_WORKER_INPUT_INVALID');
    const child = fork(path.join(__dirname, 'edge-fixture-worker.cjs'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const events = []; let closed = false, exitCode, signal;
    child.on('message', value => events.push(value));
    child.on('error', () => events.push({ event: 'failure', code: 'PROBE_WORKER_FAILED' }));
    child.on('close', (code, terminationSignal) => { closed = true; exitCode = code; signal = terminationSignal; });
    child.send(input, error => { if (error) events.push({ event: 'failure', code: 'PROBE_IPC_FAILED' }); });
    return {
        async wait(event, timeoutMs = 60000) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const failure = events.find(item => item?.event === 'failure');
                if (failure) throw new Error(/^PROBE_[A-Z_]+$/.test(failure.code || '') ? failure.code : 'PROBE_WORKER_FAILED');
                const found = events.find(item => item?.event === event); if (found) return found;
                if (closed) throw new Error('PROBE_WORKER_EXITED');
                await delay(50);
            }
            throw new Error('PROBE_WORKER_TIMEOUT');
        },
        async terminate() {
            if (closed || child.exitCode !== null || child.signalCode !== null || !child.kill('SIGKILL')) throw new Error('PROBE_WORKER_KILL_FAILED');
            const deadline = Date.now() + 10000;
            while (!closed && Date.now() < deadline) await delay(50);
            if (!closed || exitCode === 0 && !signal) throw new Error('PROBE_WORKER_KILL_FAILED');
        },
        async waitExit() {
            const deadline = Date.now() + 10000;
            while (!closed && Date.now() < deadline) await delay(50);
            if (!closed || exitCode !== 0 || signal) throw new Error('PROBE_WORKER_EXIT_FAILED');
        },
        async cleanup() {
            if (!closed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            const deadline = Date.now() + 10000; while (!closed && Date.now() < deadline) await delay(50);
            if (!closed) throw new Error('PROBE_WORKER_CLEANUP_FAILED');
        },
    };
}
module.exports = { startSyntheticWorker };
