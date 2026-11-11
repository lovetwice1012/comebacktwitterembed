'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

test('Mac Edge calibration uses a disposable profile and requires a process-start identity', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-calibration-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-calibration-test-/); await fs.rm(real, { recursive: true });
    });
    const token = crypto.randomBytes(16).toString('hex'), rootPath = path.join(base, `edge-calibration-${token}`);
    await fs.mkdir(path.join(rootPath, 'profile'), { recursive: true });
    await fs.writeFile(path.join(rootPath, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }));
    const sourceFile = path.join(__dirname, '../../src/automation/edge-calibration-runner.js');
    const source = await fs.readFile(sourceFile, 'utf8'), module = { exports: {} }; let nextPid = 100, captured, authorizeCalls = 0;
    const expectedClient = { channel: 'abc', protocolVersion: '1.0', clientName: 'Fixture', clientVersion: '1.2.3.4' };
    const expectedAgent = { os: 'SyntheticOS', osVersion: '1.2.3', architecture: 'synthetic64', locale: 'ja-JP' };
    const mockedRequire = name => {
        if (name === 'node:http') return { createServer: () => {
            const server = new EventEmitter(); server.listen = (_opts, done) => queueMicrotask(done);
            server.address = () => ({ address: '127.0.0.1', port: 23456 }); server.close = done => done(); server.closeAllConnections = () => {}; return server;
        } };
        if (name === 'node:crypto') return { ...crypto, X509Certificate: class {
            checkHost() { return true; } checkIP() { return true; } get publicKey() { return { export: () => Buffer.from('fixture-public-key') }; }
        } };
        if (name === './edge-cdp-pipe') return { createChromePipe: browser => ({ ready: async () => '157.0.0.1',
            prepareCalibration: async () => true, closeBrowser: async () => { browser.exitCode = 0; browser.emit('exit', 0); } }) };
        if (name === './edge-calibration-relay') return { createEdgeCalibrationRelay: async ({ authorizePeer, captureAgent }) => {
            assert.equal(captureAgent, true); return { port: 23457,
            metadata: new Promise((resolve, reject) => setImmediate(async () => {
                if (await authorizePeer({ clientPort: 30001, serverPort: 23457 })) resolve({ connectVersion: '2', agent: expectedAgent, client: expectedClient });
                else reject(Object.assign(new Error('peer denied'), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' }));
            })), close: async () => {} }; } };
        if (name.startsWith('./')) return require(path.join(path.dirname(sourceFile), name));
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, Buffer, AbortSignal, AbortController,
        setTimeout, clearTimeout, process });
    const edgePath = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const args = { rootPath, token, edgePath, platform: 'macos', pfx: Buffer.from('fixture'), passphrase: 'fixture', certificate: Buffer.from('fixture'),
        spawnBrowser: () => { const browser = new EventEmitter(); browser.pid = nextPid++; browser.exitCode = null; browser.signalCode = null; return browser; },
        captureIdentity: async () => '1700000000:123456', authorizePeer: async input => { authorizeCalls++; captured = input; return true; } };
    const result = await module.exports.runEdgeCalibration(args);
    assert.equal(result.browserVersion, '157.0.0.1'); assert.equal(result.connectVersion, '2'); assert.equal(result.client, expectedClient); assert.equal(result.agent, expectedAgent); assert.equal(authorizeCalls, 1);
    assert.equal(captured.browserStartTicks, '1700000000:123456'); assert.equal(captured.browserExecutable, edgePath);
    authorizeCalls = 0;
    await assert.rejects(module.exports.runEdgeCalibration({ ...args, captureIdentity: async () => 'pid-only' }), { code: 'X_EDGE_CALIBRATION_PEER_FAILED' });
    assert.equal(authorizeCalls, 0);
    await assert.rejects(module.exports.runEdgeCalibration({ ...args, platform: 'windows' }), { code: 'X_EDGE_CALIBRATION_CONFIG_INVALID' });
});
