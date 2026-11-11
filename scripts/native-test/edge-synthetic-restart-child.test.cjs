'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const path = require('node:path');
const script = path.join(__dirname, '../../experiments/chrome-push/edge-synthetic-restart-child.cjs');

test('synthetic restart child refuses direct invocation without parent IPC', () => {
    const child = spawnSync(process.execPath, [script], { env: { ...process.env, NODE_ENV: 'test' },
        windowsHide: true, stdio: 'ignore', timeout: 10000 });
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0);
});

test('synthetic restart child refuses a non-fixture database before connecting', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
    const child = fork(script, [], { env: { ...process.env, NODE_ENV: 'test' }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const result = new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', code => resolve(code));
    });
    child.send({ schema: 'production', subscriptionId: '33333333-3333-4333-8333-333333333333',
        ownerUserId: '123456789', privateKey: '-----BEGIN PRIVATE KEY-----synthetic' });
    assert.notEqual(await result, 0);
});
