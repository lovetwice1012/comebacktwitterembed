'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ manifest, enabled = true, result = { state: 'saved' } } = {}) {
    const source = await fs.readFile(path.join(__dirname, '../firefox-mac-app.cjs'), 'utf8');
    const module = { exports: {} }, calls = [], ui = { showSaved: async () => calls.push('saved'), showError: async code => calls.push(`error:${code}`) };
    const value = manifest === undefined ? JSON.stringify({ packageId: 'x-notification-mac-firefox-setup', version: '0.1.0-mac-firefox-preview.1',
        lockSha256: 'a'.repeat(64), bootstrapSha256: 'b'.repeat(64), readerSha256: 'c'.repeat(64) }) : manifest;
    const bytes = Buffer.from(value);
    const mocked = name => {
        if (name === 'node:fs/promises') return { open: async () => { calls.push('open'); return { stat: async () => ({ isFile: () => true, size: bytes.length }),
            async read(buffer, offset, length, position) { const count = bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length)); return { bytesRead: count }; },
            close: async () => {} }; }, realpath: async value => value };
        if (name === 'node:os') return { homedir: () => '/Users/test' };
        if (name === 'node:path') return path.posix;
        if (name === '../src/automation/firefox-mac-dialogs') return { createExperimentalMacFirefoxDialogs: () => ui };
        if (name === '../src/automation/firefox-mac-app') return { runExperimentalMacFirefoxApp: async options => { calls.push(options); return result; } };
        if (name === '../src/automation/strict-json') return require('../../src/automation/strict-json');
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mocked, __dirname: '/package/Resources',
        process: { env: enabled ? { CBTE_FIREFOX_MAC_EXPERIMENTAL: '1' } : {}, exitCode: 0 }, Buffer, Object });
    return { main: module.exports.main, calls };
}
test('experimental entry uses only bundled paths and reports local save', async () => {
    const h = await harness(); await h.main();
    assert.equal(h.calls[0], 'open'); const call = h.calls[1];
    assert.equal(call.applicationSupport, '/Users/test/Library/Application Support');
    assert.equal(call.helperPath, '/package/MacOS/MacStoreLock'); assert.equal(call.bootstrapPath, '/package/Resources/FirefoxXPCShellReader.js');
    assert.equal(call.readerPath, '/package/Resources/Read-PushSubscription.js'); assert.equal(call.experimental, true);
    assert.equal(h.calls[2], 'saved');
});
test('entry stays disabled without its experimental flag and rejects invalid manifests', async () => {
    const disabled = await harness({ enabled: false }); await assert.rejects(disabled.main(), /X_FIREFOX_MAC_APP_INVALID/); assert.equal(disabled.calls.length, 0);
    const invalid = await harness({ manifest: '{}' }); await invalid.main(); assert.deepEqual(invalid.calls, ['open', 'error:X_FIREFOX_MAC_APP_INVALID']);
    const cancelled = await harness({ result: { state: 'cancelled' } }); await cancelled.main(); assert.equal(cancelled.calls.length, 2);
});
