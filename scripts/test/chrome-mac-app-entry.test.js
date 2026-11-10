'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ manifest, result = { state: 'saved' }, error } = {}) {
    const source = await fs.readFile(path.join(__dirname, '../chrome-mac-app.cjs'), 'utf8');
    const module = { exports: {} }, calls = [], ui = { showSaved: async () => calls.push('saved'), showError: async code => calls.push(`error:${code}`) };
    const valid = JSON.stringify({ packageId: 'x-notification-mac-chrome-setup', version: '0.1.0-mac-preview.1', lockSha256: 'a'.repeat(64) });
    const fileText = manifest === undefined ? valid : manifest;
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return { open: async () => ({ stat: async () => ({ isFile: () => true, size: Buffer.byteLength(fileText) }),
            readFile: async () => fileText, close: async () => {} }), realpath: async value => value };
        if (name === 'node:os') return { homedir: () => '/Users/test' };
        if (name === '../src/automation/chrome-mac-dialogs') return { createMacChromeDialogs: () => ui };
        if (name === '../src/automation/chrome-mac-app') return { runMacChromeApp: async options => {
            calls.push(options); if (error) throw Object.assign(new Error('private'), { code: error }); return result;
        } };
        if (name === '../src/automation/strict-json') return require('../../src/automation/strict-json');
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, __dirname: '/package', process: { exitCode: 0 }, Buffer, Object });
    return { main: module.exports.main, calls };
}
test('app entry uses local bundled helper and reports a saved file', async () => {
    const h = await harness(); await h.main();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[0].applicationSupport, '/Users/test/Library/Application Support');
    assert.equal(h.calls[0].helperPath, '/package/MacStoreLock'); assert.equal(h.calls[0].expectedSha256, 'a'.repeat(64));
    assert.equal(h.calls[1], 'saved');
});
test('invalid package, cancellation and setup errors never claim a saved file', async () => {
    const invalid = await harness({ manifest: '{}' }); await invalid.main(); assert.deepEqual(invalid.calls, ['error:X_CHROME_MAC_APP_INVALID']);
    const cancelled = await harness({ result: { state: 'cancelled' } }); await cancelled.main(); assert.equal(cancelled.calls.length, 1);
    const failure = await harness({ error: 'X_CHROME_MAC_BROKER_BUSY' }); await failure.main();
    assert.equal(failure.calls[1], 'error:X_CHROME_MAC_BROKER_BUSY'); assert(!JSON.stringify(failure.calls).includes('private'));
});
