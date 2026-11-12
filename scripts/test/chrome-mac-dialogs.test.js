'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness(responses, browser = 'chrome') {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/chrome-mac-dialogs.js'), 'utf8');
    const module = { exports: {} }, calls = [];
    const mockedRequire = name => name === 'node:child_process' ? { execFile(file, args, options, callback) {
        calls.push({ file, args, options }); const next = responses.shift();
        if (next === 'cancel') { const error = Object.assign(new Error('cancelled'), { code: 1, stderr: 'execution error: User canceled. (-128)' }); callback(error); }
        else callback(null, { stdout: next + '\n', stderr: '' });
    } } : require(name);
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, process: { platform: 'darwin' }, Number });
    return { ui: browser === 'brave' ? module.exports.createMacBraveDialogs() : module.exports.createMacChromeDialogs(), calls };
}
test('Brave dialogs name the chosen browser and preserve mixed-notification consent', async () => {
    const h = await harness(['yes', 'yes', 'yes', 'yes', '/Users/test/通知.json', 'yes'], 'brave');
    assert.equal(await h.ui.confirmOpen(), true); assert.equal(await h.ui.confirmNotifications(), true); assert.equal(await h.ui.confirmKeychain(), true);
    const selected = await h.ui.confirmSave({ otherSubscriptionCount: 1 });
    assert.equal(selected.directory, '/Users/test'); assert.equal(selected.filename, '通知.json'); assert.equal(selected.otherSitesConsent, true);
    await h.ui.showError('X_BRAVE_MAC_BROWSER_INVALID');
    assert(h.calls[0].args[1].includes('Braveを開く')); assert(h.calls[0].args[1].includes('Googleのプッシュ通知サービス'));
    assert(h.calls[0].args[1].includes('\nreturn "yes"')); assert(h.calls[1].args[1].includes('投稿通知'));
    assert(h.calls[2].args[1].includes('普段のBrave')); assert(h.calls[3].args[1].includes('サーバーに届く'));
    assert(h.calls[3].args[1].includes('破棄')); assert(h.calls.at(-1).args[1].includes('Braveを確認'));
    assert(h.calls.every(call => !call.args[1].includes('Chrome')));
    const cancelled = await harness(['cancel'], 'brave'); assert.equal(await cancelled.ui.confirmSave({ otherSubscriptionCount: 1 }), null);
    assert.equal(cancelled.calls.length, 1);
    const disabled = await harness(['no'], 'brave');
    assert.equal(await disabled.ui.confirmNotifications({ pushChannelStatus: 'disabled' }), false);
    assert(disabled.calls[0].args[1].includes('プッシュメッセージングにGoogleサービスを使用'));
    assert(disabled.calls[0].args[1].includes('ツールをもう一度開いて'));
    const unknown = await harness(['yes'], 'brave');
    assert.equal(await unknown.ui.confirmNotifications({ pushChannelStatus: 'unknown' }), true);
    assert(unknown.calls[0].args[1].includes('オンか確認'));
});
test('dialogs guide setup, disclose other-site data and return only the chosen local path', async () => {
    const h = await harness(['yes', 'yes', 'yes', 'yes', '/Users/test/通知.json']);
    assert.equal(await h.ui.confirmOpen(), true); assert.equal(await h.ui.confirmNotifications(), true); assert.equal(await h.ui.confirmKeychain(), true);
    const result = await h.ui.confirmSave({ otherSubscriptionCount: 1 });
    assert.equal(result.directory, '/Users/test'); assert.equal(result.filename, '通知.json'); assert.equal(result.otherSitesConsent, true);
    assert(h.calls.every(call => call.file === '/usr/bin/osascript' && call.args[0] === '-e'));
    assert(h.calls[0].args[1].includes('アップロード')); assert(h.calls[1].args[1].includes('投稿通知'));
    assert(h.calls[2].args[1].includes('普段のChrome')); assert(h.calls[3].args[1].includes('サーバーに届く'));
    assert(h.calls[3].args[1].includes('破棄'));
});
test('cancelled prompts stop the flow before file selection', async () => {
    const h = await harness(['cancel']); assert.equal(await h.ui.confirmOpen(), false);
    const other = await harness(['cancel']); assert.equal(await other.ui.confirmSave({ otherSubscriptionCount: 1 }), null);
    assert.equal(other.calls.length, 1);
    const noOther = await harness(['/Users/test/通知.json']); const result = await noOther.ui.confirmSave({ otherSubscriptionCount: 0 });
    assert.equal(result.otherSitesConsent, false); assert.equal(noOther.calls.length, 1);
});
