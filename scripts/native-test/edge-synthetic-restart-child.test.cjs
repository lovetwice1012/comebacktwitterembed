'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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

test('synthetic restart child passes fixture DB password to the loopback pool', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-test-db-probe-'));
    const preload = path.join(dir, 'preload.cjs');
    try {
        // Intercept the DB driver before a connection can be made. Only a
        // boolean leaves the child; credentials and connection data stay local.
        fs.writeFileSync(preload, `const Module = require('node:module');
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'mysql') return { createPool(options) {
    process.send({ expectedPool: options.host === '127.0.0.1' && options.port === 33621 &&
      options.password === process.env.CBTE_EXPECTED_TEST_DB_PASSWORD && /^cbte_automation_test_[0-9a-f]{20}$/.test(options.database) });
    throw new Error('stubbed');
  } };
  return original.call(this, name, ...args);
};\n`);
        for (const password of ['', 'synthetic-password']) {
            const env = { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
                AUTOMATION_TEST_DB_PASSWORD: password, CBTE_EXPECTED_TEST_DB_PASSWORD: password };
            const child = fork(script, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            let observed = false;
            const result = new Promise((resolve, reject) => {
                child.on('message', message => { if (message.expectedPool === true) observed = true; });
                child.once('error', reject); child.once('exit', code => resolve(code));
            });
            child.send({ schema: 'cbte_automation_test_0123456789abcdefabcd', subscriptionId: '33333333-3333-4333-8333-333333333333',
                ownerUserId: '123456789', privateKey: '-----BEGIN PRIVATE KEY-----synthetic' });
            assert.notEqual(await result, 0); assert.equal(observed, true);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
