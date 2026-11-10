'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness() {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/chrome-mac-setup-session.js'), 'utf8');
    const module = { exports: {} }, events = []; let finish, captureCount = 0;
    const released = new Promise(resolve => { finish = resolve; });
    const chrome = { exitCode: null, signalCode: null, kill(signal) { events.push(`kill:${signal}`); chrome.signalCode = signal; finish(true); } };
    const broker = { port: 12345, token: 'a'.repeat(64), chrome, engineVersion: '140.0.7339.42', releaseComplete: released,
        async stop() { events.push('stop'); } };
    const subscription = { scope: 'https://x.com/' };
    const mockedRequire = name => {
        if (name === './chrome-mac-broker') return { startMacChromeBroker: async () => { events.push('open'); return broker; } };
        if (name === './chrome-broker-client') return { captureFromBroker: async () => {
            events.push('capture'); if (++captureCount === 1) throw Object.assign(new Error('not ready'), { code: 'X_CHROME_CAPTURE_NOT_FOUND' });
            chrome.exitCode = 0; setImmediate(() => { events.push('released'); finish(true); }); return subscription;
        } };
        if (name === './chrome-mac-export-flow') return { exportMacChromeNotifications: async options => {
            events.push('export'); assert(events.includes('released')); assert.equal(options.subscription, subscription);
            assert.equal(options.keychainConfirmed, true); return { state: 'saved', uploaded: false };
        } };
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, setTimeout, clearTimeout });
    const ui = { confirmOpen: async () => true, confirmNotifications: async () => true,
        retryCapture: async () => true, confirmKeychain: async () => true, confirmSave: async () => null };
    return { run: module.exports.runMacChromeSetup, ui, events };
}
test('setup retries capture, waits for browser cleanup and then exports locally', async () => {
    const h = await harness(); const result = await h.run({ ui: h.ui });
    assert.equal(result.state, 'saved'); assert.equal(result.uploaded, false);
    assert.deepEqual(h.events, ['open', 'capture', 'capture', 'released', 'export', 'stop']);
});
test('cancelling before or after browser launch stops only the created session', async () => {
    const first = await harness(); first.ui.confirmOpen = async () => false;
    assert.equal((await first.run({ ui: first.ui })).state, 'cancelled'); assert.deepEqual(first.events, []);
    const second = await harness(); second.ui.confirmNotifications = async () => false;
    assert.equal((await second.run({ ui: second.ui })).state, 'cancelled');
    assert.deepEqual(second.events, ['open', 'kill:SIGTERM', 'stop']);
    const third = await harness(); third.ui.retryCapture = async () => false;
    assert.equal((await third.run({ ui: third.ui })).state, 'cancelled');
    assert.deepEqual(third.events, ['open', 'capture', 'kill:SIGTERM', 'stop']);
    const fourth = await harness(); fourth.ui.confirmKeychain = async () => false;
    assert.equal((await fourth.run({ ui: fourth.ui })).state, 'cancelled');
    assert.deepEqual(fourth.events, ['open', 'capture', 'capture', 'released', 'stop']);
});
