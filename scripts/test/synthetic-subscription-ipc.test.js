'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { waitForSyntheticChild } = require('../../experiments/chrome-push/synthetic-subscription-ipc.cjs');

function fakeChild() {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    return child;
}

test('waits for close after exit before checking the IPC result', async () => {
    const child = fakeChild();
    const result = waitForSyntheticChild(child, 'brave');
    child.emit('exit', 0);
    child.emit('message', { browser: 'brave' });
    child.emit('close', 0);
    assert.deepEqual(await result, { browser: 'brave' });
});

test('includes a safe diagnostic received after exit', async () => {
    const child = fakeChild();
    const result = waitForSyntheticChild(child, 'chrome');
    child.emit('exit', 1);
    child.stderr.write('private data FIXTURE_PROFILE_FAILED private data');
    child.emit('close', 1);
    await assert.rejects(result, { message: 'FIXTURE_PROFILE_FAILED' });
});

test('rejects an incorrect browser without exposing diagnostic contents', async () => {
    const child = fakeChild();
    const result = waitForSyntheticChild(child, 'chrome');
    child.emit('message', { browser: 'brave' });
    child.stderr.write('private data');
    child.emit('close', 0);
    await assert.rejects(result, { message: 'FIXTURE_CHILD_FAILED' });
});

test('times out and stops the child', async () => {
    const child = fakeChild();
    await assert.rejects(waitForSyntheticChild(child, 'chrome', 5), { message: 'FIXTURE_CHILD_TIMEOUT' });
    assert.equal(child.killed, true);
});
