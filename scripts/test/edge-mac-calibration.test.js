'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('Mac calibration verifies Edge before wiring peer checks into the isolated runner', async () => {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/edge-mac-calibration.js'), 'utf8');
    const module = { exports: {} }, calls = []; let allowed = true, changeAfter = false, versions = 0, engineVersion = '157.0.0.1', childMode = 'none', shortTimeout = false, missingMetadata = false, groupGone = true, runnerFailsAfterCleanup = false;
    const captureIdentity = () => {}, authorizePeer = () => {};
    const mockedRequire = name => {
        if (name === './edge-mac-browser-version') return { readVerifiedMacEdgeVersion: async () => {
            calls.push('signature'); if (!allowed) throw Object.assign(new Error('denied'), { code: 'X_EDGE_MAC_BROWSER_INVALID' });
            versions++; return { executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                browserVersion: changeAfter && versions % 2 === 0 ? '158.0.0.1' : '157.0.0.1' };
        } };
        if (name === './edge-mac-peer') return { createMacEdgePeerVerifier: options => { calls.push(options); return { captureIdentity, authorizePeer }; } };
        if (name === './edge-mac-ephemeral-certificate') return { withMacEdgeEphemeralCertificate: async work => {
            calls.push('certificate'); return work({ pfx: Buffer.from('pfx'), passphrase: 'fixture', certificate: Buffer.from('cert') });
        } };
        if (name === 'node:child_process') return { spawn: (_file, _args, options) => { assert.equal(options.detached, true); const child = new EventEmitter(); child.pid = 12345; return child; } };
        if (name === './chrome-mac-process-group') return { waitForMacProcessGroupExit: async () => { calls.push('group-check'); return groupGone; } };
        if (name === './edge-calibration-runner') return { runEdgeCalibration: async options => {
            calls.push(options);
            if (childMode !== 'none') {
                const child = options.spawnBrowser('/synthetic', [], {});
                child.emit('exit', 0);
                if (childMode === 'close') setImmediate(() => { calls.push('child-close'); child.emit('close', 0); });
                await options.afterBrowserClose(child);
            }
            if (runnerFailsAfterCleanup) throw Object.assign(new Error('fixture error'), { code: 'X_EDGE_CALIBRATION_FAILED' });
            return { browserVersion: engineVersion, connectVersion: missingMetadata ? undefined : '2', agent: {}, client: {} };
        } };
        return require(name);
    };
    const timer = (callback, ms) => setTimeout(callback, shortTimeout ? 0 : ms);
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, setTimeout: timer, clearTimeout });
    const input = { rootPath: '/fixture', token: 'a'.repeat(32), pfx: Buffer.from('pfx'), passphrase: 'fixture', certificate: Buffer.from('cert'),
        identityPath: '/tmp/MacEdgeIdentity', identitySha256: '1'.repeat(64), peerPath: '/tmp/MacEdgeSocketOwner', peerSha256: '2'.repeat(64) };
    assert.equal((await module.exports.runMacEdgeCalibration(input)).browserVersion, '157.0.0.1');
    assert.equal(calls[0], 'signature'); assert.equal(calls[1].identityPath, input.identityPath);
    assert.equal(calls[2].platform, 'macos'); assert.equal(calls[2].captureIdentity, captureIdentity); assert.equal(calls[2].authorizePeer, authorizePeer);
    assert.equal(calls[2].edgePath, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    assert.equal(calls[3], 'signature');
    calls.length = 0;
    assert.equal((await module.exports.runMacEdgeCalibrationWithEphemeralCertificate(input)).browserVersion, '157.0.0.1');
    assert.equal(calls[0], 'certificate'); assert.equal(calls[1], 'signature'); assert.equal(calls[3].platform, 'macos'); assert.equal(calls[4], 'signature');
    calls.length = 0; changeAfter = true;
    await assert.rejects(module.exports.runMacEdgeCalibration(input), { code: 'X_EDGE_CALIBRATION_BROWSER_CHANGED' });
    changeAfter = false; engineVersion = '158.0.0.1';
    await assert.rejects(module.exports.runMacEdgeCalibration(input), { code: 'X_EDGE_CALIBRATION_BROWSER_CHANGED' });
    engineVersion = '157.0.0.1';
    missingMetadata = true;
    await assert.rejects(module.exports.runMacEdgeCalibration(input), { code: 'X_EDGE_CALIBRATION_PROTOCOL_INVALID' });
    missingMetadata = false;
    calls.length = 0; childMode = 'close';
    let cleanupCount = 0;
    assert.equal((await module.exports.runMacEdgeCalibration({ ...input, onCleanupConfirmed: () => { cleanupCount++; } })).browserVersion, '157.0.0.1');
    assert.equal(cleanupCount, 1);
    assert(calls.indexOf('child-close') < calls.lastIndexOf('signature'));
    assert(calls.indexOf('child-close') < calls.indexOf('group-check'));
    calls.length = 0; groupGone = false;
    await assert.rejects(module.exports.runMacEdgeCalibration({ ...input, onCleanupConfirmed: () => { cleanupCount++; } }), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
    assert.equal(cleanupCount, 1, 'an unconfirmed process group must not authorize workspace cleanup');
    assert.equal(calls.filter(item => item === 'signature').length, 1); groupGone = true;
    calls.length = 0; childMode = 'hang'; shortTimeout = true;
    await assert.rejects(module.exports.runMacEdgeCalibration(input), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
    assert.equal(calls.filter(item => item === 'signature').length, 1);
    childMode = 'none'; shortTimeout = false;
    runnerFailsAfterCleanup = true;
    await assert.rejects(module.exports.runMacEdgeCalibration({ ...input, onCleanupConfirmed: () => { cleanupCount++; } }), { code: 'X_EDGE_CALIBRATION_FAILED' });
    assert.equal(cleanupCount, 2, 'confirmed cleanup remains usable after a failed calibration'); runnerFailsAfterCleanup = false;
    calls.length = 0; allowed = false;
    await assert.rejects(module.exports.runMacEdgeCalibration({ ...input, onCleanupConfirmed: () => { cleanupCount++; } }), { code: 'X_EDGE_MAC_BROWSER_INVALID' });
    assert.equal(cleanupCount, 3, 'preflight failure starts no browser and permits workspace cleanup');
    assert.deepEqual(calls, ['signature']);
});
