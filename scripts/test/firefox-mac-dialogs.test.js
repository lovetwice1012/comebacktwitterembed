'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness(responses) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/firefox-mac-dialogs.js'), 'utf8');
    const module = { exports: {} }, calls = [];
    const mocked = name => name === 'node:child_process' ? { execFile(file, args, options, callback) {
        calls.push({ file, args, options }); const value = responses.shift();
        if (value === 'cancel') callback(Object.assign(new Error('cancelled'), { code: 1, stderr: 'cancelled (-128)' }));
        else callback(null, { stdout: `${value}\n`, stderr: '' });
    } } : require(name);
    vm.runInNewContext(source, { module, exports: module.exports, require: mocked, process: { platform: 'darwin' }, Number });
    return { ui: module.exports.createExperimentalMacFirefoxDialogs({ experimental: true }), calls, create: module.exports.createExperimentalMacFirefoxDialogs };
}
test('Firefox dialogs explain setup and require explicit consent for other notifications', async () => {
    const h = await harness(['yes', 'yes', 'yes', '/Users/test/通知.json']);
    assert.equal(await h.ui.confirmOpen(), true); assert.equal(await h.ui.confirmClosed(), true);
    const output = await h.ui.confirmSave({ otherSubscriptionCount: 1 });
    assert.equal(output.directory, '/Users/test'); assert.equal(output.filename, '通知.json'); assert.equal(output.otherSitesConsent, true);
    assert(h.calls[0].args[1].includes('投稿通知')); assert(h.calls[1].args[1].includes('Firefoxを閉じて'));
    assert(h.calls[2].args[1].includes('サーバーに届く')); assert(h.calls[2].args[1].includes('取得可能')); assert(h.calls[2].args[1].includes('破棄'));
    assert(h.calls.every(call => call.file === '/usr/bin/osascript' && call.args[0] === '-e'));
});
test('cancel and invalid inputs stop before saving', async () => {
    const h = await harness(['cancel']); assert.equal(await h.ui.confirmSave({ otherSubscriptionCount: 1 }), null); assert.equal(h.calls.length, 1);
    const invalid = await harness([]); await assert.rejects(invalid.ui.confirmSave({ otherSubscriptionCount: -1 }), { code: 'X_FIREFOX_MAC_DIALOG_FAILED' });
    assert.throws(() => invalid.create(), { code: 'X_FIREFOX_MAC_DIALOG_FAILED' });
});
