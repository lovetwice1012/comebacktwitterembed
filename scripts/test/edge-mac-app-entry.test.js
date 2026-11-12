'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(manifest) {
    const calls = [], module = { exports: {} }, processValue = { exitCode: 0 };
    const body = Buffer.from(manifest ?? JSON.stringify({ packageId: 'x-notification-mac-edge-setup', version: '0.1.0-mac-edge-preview.1',
        lockSha256: 'a'.repeat(64), identitySha256: 'b'.repeat(64), peerSha256: 'c'.repeat(64) }));
    const ui = { showSaved: async () => calls.push('saved'), showError: async code => calls.push(`error:${code}`) };
    const mocks = {
        'node:fs/promises': { open: async () => ({ stat: async () => ({ isFile: () => true, size: body.length }),
            async read(buffer, offset, length, position) { return { bytesRead: body.copy(buffer, offset, position, Math.min(body.length, position + length)) }; },
            close: async () => {} }), realpath: async value => value },
        'node:os': { homedir: () => '/Users/fixture' }, 'node:path': path.posix,
        '../src/automation/edge-mac-dialogs': { createExperimentalMacEdgeDialogs: () => ui },
        '../src/automation/edge-mac-app': { runExperimentalMacEdgeApp: async options => { calls.push(options); return { state: 'saved' }; } },
        '../src/automation/strict-json': require('../../src/automation/strict-json'),
    };
    const source = fs.readFileSync(path.join(__dirname, '../edge-mac-app-core.cjs'), 'utf8');
    vm.runInNewContext(source, { module, exports: module.exports, __dirname: '/package/Resources', process: processValue, Buffer, Object,
        require(name) { return Object.hasOwn(mocks, name) ? mocks[name] : require(name); } });
    return { main: module.exports.main, calls, processValue };
}
test('Edge candidate entry supplies only bundled helper identities to the local setup', async () => {
    const h = harness(); await h.main();
    const options = h.calls[0];
    assert.equal(options.applicationSupport, '/Users/fixture/Library/Application Support');
    assert.equal(options.helperPath, '/package/MacOS/MacStoreLock'); assert.equal(options.expectedSha256, 'a'.repeat(64));
    assert.equal(options.identityPath, '/package/MacOS/MacEdgeIdentity'); assert.equal(options.identitySha256, 'b'.repeat(64));
    assert.equal(options.peerPath, '/package/MacOS/MacEdgeSocketOwner'); assert.equal(options.peerSha256, 'c'.repeat(64));
    assert.equal(options.experimental, true); assert.equal(h.calls[1], 'saved');
});
test('invalid and mismatched Edge manifests never start the local setup', async () => {
    for (const value of ['{}', '{"packageId":"x","packageId":"y"}', JSON.stringify({
        packageId: 'x-notification-mac-firefox-setup', version: '0.1.0-mac-edge-preview.1', lockSha256: 'a'.repeat(64),
        identitySha256: 'b'.repeat(64), peerSha256: 'c'.repeat(64) })]) {
        const h = harness(value); await h.main(); assert.deepEqual(h.calls, ['error:X_EDGE_MAC_APP_INVALID']); assert.equal(h.processValue.exitCode, 1);
    }
});
