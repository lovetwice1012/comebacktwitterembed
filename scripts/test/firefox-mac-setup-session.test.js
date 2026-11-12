'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ quickTimeout = false } = {}) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/firefox-mac-setup-session.js'), 'utf8');
    const module = { exports: {} }, events = []; let release;
    const releaseComplete = new Promise(resolve => { release = resolve; });
    const modules = {
        './firefox-mac-setup-browser': { async startExperimentalMacFirefox(options) {
            assert.equal(options.experimental, true); events.push('open'); return { releaseComplete };
        } },
        './firefox-mac-export-flow': { async exportExperimentalMacFirefoxNotifications(options) {
            events.push('export'); assert.equal(options.experimental, true);
            assert.equal((await options.runReader({})).success, true);
            assert.equal(await options.confirmSave({}), 'confirmed'); return { state: 'saved', uploaded: false };
        } },
        './firefox-mac-reader-supervisor': { async runExperimentalMacFirefoxReader(options) {
            assert.equal(options.experimental, true); events.push('reader'); return { stopped: true, success: true };
        } },
    };
    const schedule = quickTimeout ? (callback, _delay) => setTimeout(callback, 10) : setTimeout;
    vm.runInNewContext(source, { module, exports: module.exports, require: name => modules[name] || require(name),
        setTimeout: schedule, clearTimeout, AbortSignal });
    const ui = { async confirmOpen() { events.push('confirm-open'); return true; },
        async confirmClosed() { events.push('confirm-closed'); return true; }, async confirmSave() { events.push('confirm-save'); return 'confirmed'; } };
    return { run: module.exports.runExperimentalMacFirefoxSetup, ui, events, release };
}
test('setup waits for confirmed browser shutdown before reading and saving', async () => {
    const h = await harness(), result = h.run({ ui: h.ui, experimental: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.events, ['confirm-open', 'open', 'confirm-closed']);
    h.release(true); assert.equal((await result).state, 'saved');
    assert.deepEqual(h.events, ['confirm-open', 'open', 'confirm-closed', 'export', 'reader', 'confirm-save']);
});
test('cancel before or after browser launch never reads notification data', async () => {
    const first = await harness(); first.ui.confirmOpen = async () => false;
    assert.equal((await first.run({ ui: first.ui, experimental: true })).state, 'cancelled'); assert.deepEqual(first.events, []);
    const second = await harness(); second.ui.confirmClosed = async () => false;
    assert.equal((await second.run({ ui: second.ui, experimental: true })).state, 'cancelled'); assert.deepEqual(second.events, ['confirm-open', 'open']);
});
test('open or uncertain browser never reaches the reader', async () => {
    const timeout = await harness({ quickTimeout: true });
    await assert.rejects(timeout.run({ ui: timeout.ui, experimental: true }), { code: 'X_FIREFOX_MAC_SETUP_BROWSER_OPEN' });
    assert(!timeout.events.includes('export'));
    const uncertain = await harness(); uncertain.release(false);
    await assert.rejects(uncertain.run({ ui: uncertain.ui, experimental: true }), { code: 'X_FIREFOX_MAC_SETUP_CLEANUP_FAILED' });
    assert(!uncertain.events.includes('export'));
});
test('abort while waiting never reaches the reader', async () => {
    const h = await harness(), controller = new AbortController();
    const result = h.run({ ui: h.ui, experimental: true, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.equal((await result).state, 'cancelled'); assert(!h.events.includes('export'));
});
test('experimental gate rejects before opening', async () => {
    const h = await harness(); await assert.rejects(h.run({ ui: h.ui }), { code: 'X_FIREFOX_MAC_SETUP_INVALID' });
    assert.deepEqual(h.events, []);
});
