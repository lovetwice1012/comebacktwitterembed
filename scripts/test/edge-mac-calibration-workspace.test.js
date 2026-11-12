'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ failCalibration = false, confirmedFailure = false, replaceRoot = false } = {}) {
    const module = { exports: {} }, entries = new Map(), removed = [], token = 'a'.repeat(32), root = `/fixture/edge-calibration-${token}`;
    const info = (name, directory, ino) => ({ isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false,
        uid: 42, mode: directory ? 0o700 : 0o600, nlink: 1, size: 100, dev: 1, ino });
    let rootChecks = 0, markerText = '';
    const fakeFs = {
        async mkdir(name) { entries.set(name, name === root ? 10 : 11); },
        async lstat(name) { if (name !== root || !entries.has(name)) throw new Error('unexpected path');
            return info(name, true, replaceRoot && ++rootChecks > 1 ? 99 : 10); },
        async realpath(name) { return name; },
        async open(name, flags) {
            assert.equal(name, `${root}/owner.json`);
            if (flags === 'wx') return { async writeFile(text) { markerText = text; }, async sync() {}, async close() {} };
            return { async stat() { return info(name, false, 12); }, async readFile() { return markerText; }, async close() {} };
        },
        async rm(name, options) { assert.equal(options.recursive, true); removed.push(name); },
    };
    const mocks = { 'node:fs/promises': fakeFs, 'node:fs': { constants: { O_RDONLY: 0, O_NOFOLLOW: 1 } }, 'node:path': path.posix,
        'node:crypto': { randomBytes: () => Buffer.from(token, 'hex') },
        './strict-json': require('../../src/automation/strict-json'),
        './chrome-mac-profile': { verifyMacEdgeProfile: async () => ({ rootPath: '/fixture' }) },
        './edge-mac-calibration': { runMacEdgeCalibrationWithEphemeralCertificate: async options => {
            assert.equal(options.rootPath, root); assert.equal(options.token, token);
            if (failCalibration) throw Object.assign(new Error('cleanup uncertain'), { code: 'X_EDGE_CALIBRATION_CLEANUP_FAILED' });
            options.onCleanupConfirmed();
            if (confirmedFailure) throw Object.assign(new Error('calibration failed'), { code: 'X_EDGE_CALIBRATION_FAILED' });
            return { connectVersion: '2' };
        } } };
    const source = fs.readFileSync(path.join(__dirname, '../../src/automation/edge-mac-calibration-workspace.js'), 'utf8');
    vm.runInNewContext(source, { module, exports: module.exports, AbortSignal, process: { getuid: () => 42 }, Object,
        require(name) { assert(Object.hasOwn(mocks, name), `unexpected dependency ${name}`); return mocks[name]; } });
    return { run: module.exports.calibrateMacEdgeInOwnedWorkspace, removed, root };
}
test('successful calibration removes only its own fresh synthetic workspace', async () => {
    const h = harness(), result = await h.run({ rootPath: '/fixture', profileId: 'fixture' });
    assert.equal(result.connectVersion, '2'); assert.deepEqual(h.removed, [h.root]);
});
test('uncertain browser cleanup or workspace replacement never removes the directory', async () => {
    const failed = harness({ failCalibration: true });
    await assert.rejects(failed.run({ rootPath: '/fixture', profileId: 'fixture' }), { code: 'X_EDGE_MAC_CALIBRATION_CLEANUP_PENDING' });
    assert.deepEqual(failed.removed, []);
    const replaced = harness({ replaceRoot: true });
    await assert.rejects(replaced.run({ rootPath: '/fixture', profileId: 'fixture' }), { code: 'X_EDGE_MAC_CALIBRATION_CLEANUP_FAILED' });
    assert.deepEqual(replaced.removed, []);
});
test('failed calibration removes its workspace only after cleanup is confirmed', async () => {
    const h = harness({ confirmedFailure: true });
    await assert.rejects(h.run({ rootPath: '/fixture', profileId: 'fixture' }), { code: 'X_EDGE_CALIBRATION_FAILED' });
    assert.deepEqual(h.removed, [h.root]);
});
