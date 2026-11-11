'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('group check fences a running detached process and accepts its exit', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
    assert.equal(await waitForMacProcessGroupExit(0), false);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const closed = once(child, 'close');
    try {
        await once(child, 'spawn');
        assert.equal(await waitForMacProcessGroupExit(child.pid, { timeoutMs: 0 }), false);
        child.kill('SIGTERM'); await closed;
        assert.equal(await waitForMacProcessGroupExit(child.pid, { timeoutMs: 3000, intervalMs: 20 }), true);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
});
