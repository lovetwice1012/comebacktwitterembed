'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

function harness({ delayPage = false, relayCloseError = false, platform = 'macos' } = {}) {
    const token = 'a'.repeat(32), root = `/fixture/edge-calibration-${token}`, module = { exports: {} };
    let pageReady, relayReady, pageClosed = 0, relayClosed = 0, startedRelay;
    const pageEntered = new Promise(resolve => { pageReady = resolve; });
    const relayEntered = new Promise(resolve => { startedRelay = resolve; });
    let finishPage, finishRelay;
    const pageGate = new Promise(resolve => { finishPage = resolve; });
    const relayGate = new Promise(resolve => { finishRelay = resolve; });
    const directory = { isDirectory: () => true, isSymbolicLink: () => false };
    const marker = { isFile: () => true, isSymbolicLink: () => false, size: 100 };
    const fakeFs = { async lstat(name) { return name.endsWith('/owner.json') ? marker : directory; }, async realpath(name) { return name; },
        async readdir() { return []; }, async readFile() { return JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }); } };
    const server = new EventEmitter(); server.maxConnections = 0;
    server.listen = (_options, callback) => { pageReady(); if (delayPage) void pageGate.then(callback); else queueMicrotask(callback); };
    server.address = () => ({ address: '127.0.0.1', port: 23456 });
    server.close = callback => { pageClosed++; callback(); }; server.closeAllConnections = () => {};
    let pid = 100;
    const mocks = {
        'node:fs/promises': fakeFs, 'node:path': path.posix, 'node:http': { createServer: () => server },
        'node:child_process': { spawn: () => { throw new Error('use fixture spawn'); } },
        'node:crypto': { ...crypto, X509Certificate: class { checkHost() { return true; } checkIP() { return true; }
            get publicKey() { return { export: () => Buffer.from('public') }; } } },
        './strict-json': require('../../src/automation/strict-json'),
        './edge-cdp-pipe': { createChromePipe: child => ({ ready: async () => '150.0.1.2', prepareCalibration: async () => true,
            closeBrowser: async () => { child.exitCode = 0; child.emit('exit', 0); } }) },
        './edge-calibration-relay': { createEdgeCalibrationRelay: async () => { startedRelay(); await relayGate; return {
            port: 23457, metadata: new Promise(() => {}), async close() { relayClosed++; if (relayCloseError) throw new Error('synthetic close failed'); },
        }; } },
    };
    const source = fs.readFileSync(path.join(__dirname, '../../src/automation/edge-calibration-runner.js'), 'utf8');
    vm.runInNewContext(source, { module, exports: module.exports, Buffer, AbortSignal, AbortController, Promise,
        setTimeout, clearTimeout, process: { platform: 'darwin' },
        require(name) { assert(Object.hasOwn(mocks, name), `unexpected dependency ${name}`); return mocks[name]; } });
    const controller = new AbortController(), args = { rootPath: root, token,
        edgePath: platform === 'macos' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/fixture/msedge.exe',
        platform, pfx: Buffer.from('pfx'), passphrase: 'fixture', certificate: Buffer.from('cert'), signal: controller.signal, timeoutMs: 1000,
        spawnBrowser: () => { const child = new EventEmitter(); child.pid = pid++; child.exitCode = null; child.signalCode = null; return child; },
        captureIdentity: async () => '1700000000:123456', authorizePeer: async () => true };
    return { run: () => module.exports.runEdgeCalibration(args), controller, pageEntered, relayEntered, finishPage, finishRelay,
        counts: () => ({ pageClosed, relayClosed }) };
}

for (const platform of ['macos', 'windows']) test(`${platform}: abort while page listener starts closes it after late readiness`, async () => {
    const h = harness({ delayPage: true, platform }), pending = h.run(); await h.pageEntered; h.controller.abort();
    let finished = false; void pending.then(() => { finished = true; }, () => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(finished, false);
    h.finishPage(); await assert.rejects(pending, { code: 'X_EDGE_CALIBRATION_STOPPED' });
    assert.equal(h.counts().pageClosed, 1);
});
for (const platform of ['macos', 'windows']) test(`${platform}: abort while relay starts closes it before reporting cleanup complete`, async () => {
    const h = harness({ platform }), pending = h.run(); await h.relayEntered; h.controller.abort();
    let finished = false; void pending.then(() => { finished = true; }, () => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(finished, false);
    h.finishRelay(); await assert.rejects(pending, { code: 'X_EDGE_CALIBRATION_STOPPED' });
    assert.deepEqual(h.counts(), { pageClosed: 1, relayClosed: 1 });
});
for (const platform of ['macos', 'windows']) test(`${platform}: unresolved relay fails cleanup then closes if it appears later`, { timeout: 5000 }, async () => {
    const h = harness({ platform }), pending = h.run(); await h.relayEntered; h.controller.abort();
    await assert.rejects(pending, { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
    assert.equal(h.counts().pageClosed, 1); assert.equal(h.counts().relayClosed, 0);
    h.finishRelay(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(h.counts().relayClosed, 1);
});
for (const platform of ['macos', 'windows']) test(`${platform}: unresolved page listener fails cleanup then closes when ready`, { timeout: 5000 }, async () => {
    const h = harness({ delayPage: true, platform }), pending = h.run(); await h.pageEntered; h.controller.abort();
    await assert.rejects(pending, { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
    assert.equal(h.counts().pageClosed, 0);
    h.finishPage(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(h.counts().pageClosed, 1);
});
test('a relay close failure cannot be reported as confirmed cleanup', async () => {
    const h = harness({ relayCloseError: true }), pending = h.run(); await h.relayEntered; h.controller.abort(); h.finishRelay();
    await assert.rejects(pending, { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
    assert.deepEqual(h.counts(), { pageClosed: 1, relayClosed: 1 });
});
