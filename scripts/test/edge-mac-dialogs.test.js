'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(responses) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/automation/edge-mac-dialogs.js'), 'utf8');
    const module = { exports: {} }, calls = [];
    const mocked = name => name === 'node:child_process' ? { execFile(file, args, options, callback) {
        calls.push({ file, args, options }); const value = responses.shift();
        if (value === 'cancel') callback(Object.assign(new Error('cancelled'), { code: 1, stderr: 'cancelled (-128)' }));
        else callback(null, { stdout: `${value}\n`, stderr: '' });
    } } : require(name);
    vm.runInNewContext(source, { module, exports: module.exports, require: mocked, process: { platform: 'darwin' }, Number });
    return { ui: module.exports.createExperimentalMacEdgeDialogs({ experimental: true }), calls,
        create: module.exports.createExperimentalMacEdgeDialogs };
}
test('known and unclassified notifications require informed consent before choosing a file', async () => {
    for (const [counts, phrase] of [[{ otherSubscriptionCount: 1, unclassifiedRecordCount: 0, otherNotificationsPossible: true }, '含まれています'],
        [{ otherSubscriptionCount: 0, unclassifiedRecordCount: 1, otherNotificationsPossible: true }, '含まれる可能性']]) {
        const h = harness(['yes', '/Users/test/通知.json']);
        const result = await h.ui.confirmSave(counts);
        assert.equal(result.directory, '/Users/test'); assert.equal(result.filename, '通知.json'); assert.equal(result.otherSitesConsent, true);
        assert(h.calls[0].args[1].includes(phrase));
        for (const term of ['サーバーに届く', '取得可能', '破棄']) assert(h.calls[0].args[1].includes(term));
        assert(h.calls.every(call => call.file === '/usr/bin/osascript' && call.args[0] === '-e'));
    }
});
test('refusal and invalid classification cannot reach the save dialog', async () => {
    const denied = harness(['cancel']);
    assert.equal(await denied.ui.confirmSave({ otherSubscriptionCount: 1, unclassifiedRecordCount: 0, otherNotificationsPossible: true }), null);
    assert.equal(denied.calls.length, 1);
    const invalid = harness([]);
    await assert.rejects(invalid.ui.confirmSave({ otherSubscriptionCount: 0, unclassifiedRecordCount: 1, otherNotificationsPossible: false }),
        { code: 'X_EDGE_MAC_DIALOG_FAILED' });
    assert.equal(invalid.calls.length, 0); assert.throws(() => invalid.create(), { code: 'X_EDGE_MAC_DIALOG_FAILED' });
});
test('the user is told that capture closes the setup browser and can confirm a delayed close', async () => {
    const h = harness(['yes', 'yes']);
    assert.equal(await h.ui.confirmNotifications(), true); assert.equal(await h.ui.confirmClosed(), true);
    assert(h.calls[0].args[1].includes('設定用Edgeを閉じて'));
    assert(h.calls[1].args[1].includes('設定用Edgeを閉じて'));
});
test('manual recovery has an explicit cancel option and explains retained information', async () => {
    const h = harness(['cancel', 'yes']);
    assert.equal(await h.ui.confirmNewProfile(), false);
    await h.ui.showError('X_EDGE_MAC_ROTATION_FAILED');
    assert(h.calls[0].args[1].includes('以前の設定用Edgeの情報と登録済みの受信情報は残ります'));
    assert(h.calls[0].args[1].includes('default button "やめる"'));
    assert(h.calls[1].args[1].includes('サポートにご相談ください'));
});
