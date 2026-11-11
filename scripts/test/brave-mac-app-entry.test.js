'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ enabled = true, manifest, result = { state: 'saved' }, error } = {}) {
    const source = await fs.readFile(path.join(__dirname, '../brave-mac-app.cjs'), 'utf8');
    const module = { exports: {} }, calls = [];
    const ui = { showSaved: async () => calls.push('saved'), showError: async code => calls.push(`error:${code}`) };
    const valid = JSON.stringify({ packageId: 'x-notification-mac-brave-setup', version: '0.1.0-mac-brave-preview.1', lockSha256: 'a'.repeat(64) });
    const content = manifest === undefined ? valid : manifest;
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return { open: async filename => {
            calls.push(`manifest:${filename}`); return { stat: async () => ({ isFile: () => true, size: Buffer.byteLength(content) }),
                readFile: async () => content, close: async () => {} };
        }, realpath: async value => value };
        if (name === 'node:path') return path.posix;
        if (name === 'node:os') return { homedir: () => '/Users/test' };
        if (name === '../src/automation/chrome-mac-dialogs') return { createMacBraveDialogs: () => { calls.push('dialogs'); return ui; } };
        if (name === '../src/automation/brave-mac-app') return { runExperimentalMacBraveApp: async options => {
            calls.push(options); if (error) throw Object.assign(new Error('private'), { code: error }); return result;
        } };
        if (name === '../src/automation/strict-json') return require('../../src/automation/strict-json');
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, __dirname: '/package', Buffer, Object,
        process: { env: enabled ? { CBTE_EXPERIMENTAL_BRAVE_MAC_LOCAL: '1' } : {}, exitCode: 0 } });
    return { main: module.exports.main, calls };
}
test('experimental Brave entry is disabled unless explicitly selected', async () => {
    const h = await harness({ enabled: false });
    await assert.rejects(h.main(), /X_BRAVE_MAC_APP_UNAVAILABLE/); assert.deepEqual(h.calls, []);
});
test('Brave entry checks fixed package metadata and provides local helper paths', async () => {
    const h = await harness(); await h.main();
    assert.equal(h.calls[0], 'dialogs'); assert.equal(h.calls[1], 'manifest:/package/MacSetup-manifest.json');
    assert.equal(h.calls[2].applicationSupport, '/Users/test/Library/Application Support');
    assert.equal(h.calls[2].helperPath, '/package/MacStoreLock'); assert.equal(h.calls[2].expectedSha256, 'a'.repeat(64));
    assert.equal(h.calls[2].experimental, true); assert.equal(h.calls[3], 'saved');
});
test('invalid manifests, cancellation and failures never claim a saved file', async () => {
    for (const manifest of ['{}', '{"packageId":"x","packageId":"y"}', JSON.stringify({ packageId: 'x-notification-mac-chrome-setup', version: '0.1.0-mac-brave-preview.1', lockSha256: 'a'.repeat(64) })]) {
        const h = await harness({ manifest }); await h.main();
        assert.equal(h.calls.at(-1), 'error:X_BRAVE_MAC_APP_INVALID'); assert.equal(h.calls.some(value => typeof value === 'object'), false);
    }
    const cancelled = await harness({ result: { state: 'cancelled' } }); await cancelled.main();
    assert.equal(cancelled.calls.includes('saved'), false);
    const failed = await harness({ error: 'X_BRAVE_MAC_BROKER_BUSY' }); await failed.main();
    assert.equal(failed.calls.at(-1), 'error:X_BRAVE_MAC_BROKER_BUSY'); assert(!JSON.stringify(failed.calls).includes('private'));
});
