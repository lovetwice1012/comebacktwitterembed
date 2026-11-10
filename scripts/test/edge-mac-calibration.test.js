'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

test('Mac calibration verifies Edge before wiring peer checks into the isolated runner', async () => {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/edge-mac-calibration.js'), 'utf8');
    const module = { exports: {} }, calls = []; let allowed = true;
    const captureIdentity = () => {}, authorizePeer = () => {};
    const mockedRequire = name => {
        if (name === './edge-mac-broker') return { verifyInstalledEdge: async () => {
            calls.push('signature'); if (!allowed) throw Object.assign(new Error('denied'), { code: 'X_EDGE_MAC_BROWSER_INVALID' });
            return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
        } };
        if (name === './edge-mac-peer') return { createMacEdgePeerVerifier: options => { calls.push(options); return { captureIdentity, authorizePeer }; } };
        if (name === './edge-mac-ephemeral-certificate') return { withMacEdgeEphemeralCertificate: async work => {
            calls.push('certificate'); return work({ pfx: Buffer.from('pfx'), passphrase: 'fixture', certificate: Buffer.from('cert') });
        } };
        if (name === './edge-calibration-runner') return { runEdgeCalibration: async options => { calls.push(options); return { browserVersion: '157.0.0.1' }; } };
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire });
    const input = { rootPath: '/fixture', token: 'a'.repeat(32), pfx: Buffer.from('pfx'), passphrase: 'fixture', certificate: Buffer.from('cert'),
        identityPath: '/tmp/MacEdgeIdentity', identitySha256: '1'.repeat(64), peerPath: '/tmp/MacEdgeSocketOwner', peerSha256: '2'.repeat(64) };
    assert.equal((await module.exports.runMacEdgeCalibration(input)).browserVersion, '157.0.0.1');
    assert.equal(calls[0], 'signature'); assert.equal(calls[1].identityPath, input.identityPath);
    assert.equal(calls[2].platform, 'macos'); assert.equal(calls[2].captureIdentity, captureIdentity); assert.equal(calls[2].authorizePeer, authorizePeer);
    assert.equal(calls[2].edgePath, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    calls.length = 0;
    assert.equal((await module.exports.runMacEdgeCalibrationWithEphemeralCertificate(input)).browserVersion, '157.0.0.1');
    assert.equal(calls[0], 'certificate'); assert.equal(calls[1], 'signature'); assert.equal(calls[3].platform, 'macos');
    calls.length = 0; allowed = false;
    await assert.rejects(module.exports.runMacEdgeCalibration(input), { code: 'X_EDGE_MAC_BROWSER_INVALID' });
    assert.deepEqual(calls, ['signature']);
});
