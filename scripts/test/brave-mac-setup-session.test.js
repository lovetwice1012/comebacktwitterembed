'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ timeout = false, captureError = false, closeResult = true } = {}) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/brave-mac-setup-session.js'), 'utf8');
    const module = { exports: {} }, events = []; let finish, captures = 0;
    const released = new Promise(resolve => { finish = resolve; });
    const chrome = { exitCode: null, signalCode: null, kill(signal) { events.push(`kill:${signal}`); chrome.signalCode = signal; finish(true); } };
    const broker = { port: 12345, token: 'a'.repeat(64), chrome, browserVersion: '157.1.99.55', engineVersion: '157.0.8103.39',
        releaseComplete: released, async stop() { events.push('stop'); } };
    const subscription = { scope: 'https://x.com/', private: 'synthetic-secret' };
    const mockedRequire = name => {
        if (name === './brave-mac-broker') return { startMacBraveBroker: async () => { events.push('open'); return broker; } };
        if (name === './chrome-broker-client') return { captureFromBroker: async () => {
            events.push('capture'); captures++;
            if (captureError) throw new Error('synthetic failure');
            if (captures === 1 && !timeout) throw Object.assign(new Error('not ready'), { code: 'X_CHROME_CAPTURE_NOT_FOUND' });
            if (!timeout) { chrome.exitCode = 0; setImmediate(() => { events.push('released'); finish(closeResult); }); }
            return subscription;
        } };
        if (name === './brave-mac-export-flow') return { exportExperimentalMacBraveNotifications: async options => {
            events.push('export'); assert(events.includes('released')); assert.equal(options.subscription, subscription);
            assert.equal(options.browserVersion, '157.1.99.55'); assert.equal(options.engineVersion, '157.0.8103.39');
            assert.equal(options.experimental, true); assert.equal(options.keychainConfirmed, true); return { state: 'saved', uploaded: false };
        } };
        return require(name);
    };
    const fakeTimer = callback => { queueMicrotask(callback); return { unref() {} }; };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire,
        setTimeout: timeout ? fakeTimer : setTimeout, clearTimeout: timeout ? () => {} : clearTimeout });
    const ui = { confirmOpen: async () => true, confirmNotifications: async () => true,
        retryCapture: async code => { assert.equal(code, 'X_CHROME_CAPTURE_NOT_FOUND'); return true; },
        confirmKeychain: async () => true, confirmSave: async () => null };
    return { run: module.exports.runExperimentalMacBraveSetup, ui, events };
}

test('experimental setup retries, waits for browser close and preserves distinct versions', async () => {
    const h = await harness();
    await assert.rejects(h.run({ ui: h.ui, experimental: false }), { code: 'X_BRAVE_MAC_SETUP_INVALID' });
    assert.deepEqual(h.events, []);
    const result = await h.run({ ui: h.ui, experimental: true });
    assert.equal(result.state, 'saved'); assert.equal(result.uploaded, false);
    assert.deepEqual(h.events, ['open', 'capture', 'capture', 'released', 'export', 'stop']);
});
test('setup cancellation stops only its own browser and never calls export', async () => {
    const first = await harness(); first.ui.confirmOpen = async () => false;
    assert.equal((await first.run({ ui: first.ui, experimental: true })).state, 'cancelled'); assert.deepEqual(first.events, []);
    const second = await harness(); second.ui.confirmNotifications = async () => false;
    assert.equal((await second.run({ ui: second.ui, experimental: true })).state, 'cancelled');
    assert.deepEqual(second.events, ['open', 'kill:SIGTERM', 'stop']);
    const third = await harness(); third.ui.confirmKeychain = async () => false;
    assert.equal((await third.run({ ui: third.ui, experimental: true })).state, 'cancelled');
    assert.deepEqual(third.events, ['open', 'capture', 'capture', 'released', 'stop']);
    const fourth = await harness(); fourth.ui.retryCapture = async () => false;
    assert.equal((await fourth.run({ ui: fourth.ui, experimental: true })).state, 'cancelled');
    assert.deepEqual(fourth.events, ['open', 'capture', 'kill:SIGTERM', 'stop']);
});
test('unexpected capture errors or missing browser close never start export', async () => {
    const failed = await harness({ captureError: true });
    await assert.rejects(failed.run({ ui: failed.ui, experimental: true }), /synthetic failure/);
    assert.deepEqual(failed.events, ['open', 'capture', 'kill:SIGTERM', 'stop']);
    const hung = await harness({ timeout: true });
    await assert.rejects(hung.run({ ui: hung.ui, experimental: true }), { code: 'X_BRAVE_MAC_SETUP_CLEANUP_FAILED' });
    assert.deepEqual(hung.events, ['open', 'capture', 'kill:SIGTERM', 'stop']);
    const unproven = await harness({ closeResult: false });
    await assert.rejects(unproven.run({ ui: unproven.ui, experimental: true }), { code: 'X_BRAVE_MAC_SETUP_CLEANUP_FAILED' });
    assert.deepEqual(unproven.events, ['open', 'capture', 'capture', 'released', 'stop']);
});
