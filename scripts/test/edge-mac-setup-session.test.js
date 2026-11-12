'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ confirmOpen = true, confirmNotifications = true, confirmClosed = true, captureError = false, retry = false,
    calibrationVersion = '150.0.1.2', browserVersion = '150.0.1.2', released = true, pendingClose = false } = {}) {
    const calls = [], module = { exports: {} }, subscriptions = { scope: 'https://x.com/', endpoint: 'synthetic',
        keys: { p256dh: 'synthetic', auth: 'synthetic' }, applicationServerKey: 'synthetic' };
    let resolveClose; const child = { exitCode: pendingClose ? null : 0, signalCode: null,
        kill: () => { calls.push('kill'); child.exitCode = 0; resolveClose?.(true); } };
    const broker = { port: 4321, token: 'fixture', engineVersion: browserVersion, chrome: child,
        releaseComplete: pendingClose ? new Promise(resolve => { resolveClose = resolve; }) : Promise.resolve(released), stop: async () => calls.push('stop') };
    const calibration = { browserVersion: calibrationVersion, connectVersion: '2', agent: { synthetic: true }, client: { synthetic: true } };
    const mocks = {
        'node:path': path,
        './edge-mac-calibration-workspace': { calibrateMacEdgeInOwnedWorkspace: async () => { calls.push('calibrate'); return calibration; } },
        './edge-mac-open': { openMacEdgeForSetup: async () => { calls.push('open'); return broker; } },
        './edge-broker-client': { captureFromBroker: async options => { calls.push(['capture', options.includeApplicationServerKey]);
            if (captureError) throw Object.assign(new Error('capture failed'), { code: 'X_CHROME_CAPTURE_UNAVAILABLE' }); return subscriptions; } },
        './edge-mac-export-flow': { exportExperimentalMacEdgeNotifications: async options => { calls.push(['export', options]); return { state: 'saved' }; } },
    };
    const source = fs.readFileSync(path.join(__dirname, '../../src/automation/edge-mac-setup-session.js'), 'utf8');
    const fixtureTimeout = pendingClose ? (callback => { const timer = setTimeout(callback, 0); return timer; }) : setTimeout;
    vm.runInNewContext(source, { module, exports: module.exports, AbortSignal, setTimeout: fixtureTimeout, clearTimeout, Promise,
        require(name) { assert(Object.hasOwn(mocks, name), `unexpected dependency ${name}`); return mocks[name]; } });
    const ui = { confirmOpen: async () => { calls.push('confirm-open'); return confirmOpen; },
        confirmNotifications: async () => { calls.push('confirm-notifications'); return confirmNotifications; },
        retryCapture: async () => { calls.push('retry'); return retry; }, confirmSave: async () => null };
    ui.confirmClosed = async () => { calls.push('confirm-closed'); if (confirmClosed) { child.exitCode = 0; resolveClose?.(true); } return confirmClosed; };
    const args = { rootPath: '/fixture/root', profileId: 'fixture', helperPath: '/fixture/MacStoreLock', expectedSha256: 'a'.repeat(64),
        identityPath: '/fixture/MacEdgeIdentity', identitySha256: 'b'.repeat(64), peerPath: '/fixture/MacEdgeSocketOwner',
        peerSha256: 'c'.repeat(64), ui, experimental: true };
    return { run: module.exports.runExperimentalMacEdgeSetup, args, calls, subscriptions };
}

test('Edge setup calibrates separately, captures and saves only after the owned browser stops', async () => {
    const f = fixture(), result = await f.run(f.args);
    assert.equal(result.state, 'saved');
    assert.deepEqual(f.calls.map(value => Array.isArray(value) ? value[0] : value),
        ['confirm-open', 'calibrate', 'open', 'confirm-notifications', 'capture', 'export', 'stop']);
    assert.equal(f.calls.find(value => Array.isArray(value) && value[0] === 'capture')[1], true);
    const exportOptions = f.calls.find(value => Array.isArray(value) && value[0] === 'export')[1];
    assert.equal(exportOptions.subscription, f.subscriptions); assert.equal(exportOptions.connectVersion, '2');
    assert.equal(exportOptions.experimental, true); assert.equal(exportOptions.confirmSave, f.args.ui.confirmSave);
});
test('an owned browser still closing prompts and waits before accessing its store', async () => {
    const f = fixture({ pendingClose: true }), result = await f.run(f.args);
    assert.equal(result.state, 'saved');
    const labels = f.calls.map(value => Array.isArray(value) ? value[0] : value);
    assert(labels.indexOf('confirm-closed') > labels.indexOf('capture'));
    assert(labels.indexOf('export') > labels.indexOf('confirm-closed'));
});
test('cancelling the close prompt stops only the owned browser and never saves', async () => {
    const f = fixture({ pendingClose: true, confirmClosed: false }), result = await f.run(f.args);
    assert.equal(result.state, 'cancelled');
    const labels = f.calls.map(value => Array.isArray(value) ? value[0] : value);
    assert(labels.includes('confirm-closed') && labels.includes('kill') && labels.includes('stop'));
    assert(!labels.includes('export'));
});
test('cancellation or capture failure closes the browser without exporting', async () => {
    for (const options of [{ confirmOpen: false }, { confirmNotifications: false }, { captureError: true }]) {
        const f = fixture(options), result = await f.run(f.args); assert.equal(result.state, 'cancelled');
        assert(!f.calls.some(value => Array.isArray(value) && value[0] === 'export'));
        if (options.confirmOpen === false) assert.deepEqual(f.calls, ['confirm-open']);
        else assert.equal(f.calls.at(-1), 'stop');
    }
});
test('Edge replacement or an unconfirmed shutdown never saves a file', async () => {
    for (const options of [{ browserVersion: '151.0.1.2' }, { released: false }]) {
        const f = fixture(options);
        await assert.rejects(f.run(f.args), { code: options.released === false ? 'X_EDGE_MAC_SETUP_CLEANUP_FAILED' : 'X_EDGE_MAC_SETUP_BROWSER_CHANGED' });
        assert(!f.calls.some(value => Array.isArray(value) && value[0] === 'export')); assert.equal(f.calls.at(-1), 'stop');
    }
});
test('setup rejects missing gates or helper hashes before opening Edge', async () => {
    const f = fixture();
    for (const changes of [{ experimental: false }, { peerSha256: 'bad' }, { identityPath: 'relative' }])
        await assert.rejects(f.run({ ...f.args, ...changes }), { code: 'X_EDGE_MAC_SETUP_INVALID' });
    assert.deepEqual(f.calls, []);
});
