'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function harness() {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/firefox-mac-setup-browser.js'), 'utf8');
    const module = { exports: {} }, calls = []; let locked = false, ended = false, child, resolveGroup, changed = false, verified = 0;
    let group = new Promise(resolve => { resolveGroup = resolve; });
    const modules = {
        'node:child_process': { spawn(file, args, options) {
            calls.push({ file, args, options }); child = new EventEmitter(); child.pid = 12345;
            child.kill = signal => { calls.push(signal); return true; }; return child;
        } },
        './firefox-mac-browser': { async verifyInstalledMacFirefox() { verified++; return { executable: '/Applications/Firefox.app/Contents/MacOS/firefox', version: changed && verified % 2 === 0 ? '161.0' : '160.0' }; } },
        './chrome-mac-profile': { async verifyMacFirefoxProfile() { return { rootPath: '/owned', profilePath: '/owned/firefox-profile', profileId: 'fixture' }; } },
        './chrome-mac-profile-lease': {
            async acquireMacProfileLease() { if (locked) throw Object.assign(new Error(), { code: 'X_CHROME_MAC_LEASE_BUSY' }); locked = true; return {}; },
            beginMacProfileLease() { ended = false; return { end() { ended = true; } }; },
            async releaseMacProfileLease() { assert(ended); locked = false; },
        },
        './chrome-mac-process-group': { waitForMacProcessGroupExit: () => group },
    };
    const mockedRequire = name => modules[name] || require(name);
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire,
        process: { platform: 'darwin', env: { HOME: '/owned-home', MOZ_FOO: 'blocked', XRE_PROFILE_PATH: 'blocked', DYLD_INSERT_LIBRARIES: 'blocked' } } });
    return { start: module.exports.startExperimentalMacFirefox, calls, close: () => child.emit('close'), resolveGroup: value => resolveGroup(value),
        changeVersion: () => { changed = true; }, locked: () => locked };
}
test('dedicated Firefox launch keeps its lease until the process group has exited', async () => {
    const h = await harness(), options = { rootPath: '/owned', profileId: 'fixture', experimental: true };
    const session = await h.start(options);
    assert.equal(session.browserVersion, '160.0');
    assert.equal(h.calls[0].file, '/Applications/Firefox.app/Contents/MacOS/firefox');
    assert.deepEqual(Array.from(h.calls[0].args), ['-no-remote', '-profile', '/owned/firefox-profile', 'https://x.com/']);
    assert.equal(h.calls[0].options.detached, true); assert.equal(h.calls[0].options.env.HOME, '/owned-home');
    assert.equal(Object.hasOwn(h.calls[0].options.env, 'MOZ_FOO'), false);
    assert.equal(Object.hasOwn(h.calls[0].options.env, 'XRE_PROFILE_PATH'), false);
    assert.equal(Object.hasOwn(h.calls[0].options.env, 'DYLD_INSERT_LIBRARIES'), false);
    await assert.rejects(h.start(options), { code: 'X_FIREFOX_MAC_LAUNCH_BUSY' });
    h.close(); await assert.rejects(h.start(options), { code: 'X_FIREFOX_MAC_LAUNCH_BUSY' });
    h.resolveGroup(true); assert.equal(await session.releaseComplete, true); assert.equal(h.locked(), false);
});
test('uncertain shutdown preserves the profile lease and no second launch starts', async () => {
    const h = await harness(), options = { rootPath: '/owned', profileId: 'fixture', experimental: true };
    const session = await h.start(options); h.close(); h.resolveGroup(false);
    assert.equal(await session.releaseComplete, false); assert.equal(h.locked(), true);
    await assert.rejects(h.start(options), { code: 'X_FIREFOX_MAC_LAUNCH_BUSY' });
});
test('changed Firefox after launch stops the owned child and retains its lease until close', async () => {
    const h = await harness(), options = { rootPath: '/owned', profileId: 'fixture', experimental: true };
    h.changeVersion(); await assert.rejects(h.start(options), { code: 'X_FIREFOX_MAC_LAUNCH_CLEANUP_PENDING' });
    assert.equal(h.calls[1], 'SIGTERM'); assert.equal(h.locked(), true);
    h.close(); h.resolveGroup(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.locked(), false);
});
test('the experimental gate prevents launch', async () => {
    const h = await harness(); await assert.rejects(h.start({ rootPath: '/owned', profileId: 'fixture' }), { code: 'X_FIREFOX_MAC_LAUNCH_INVALID' });
    assert.equal(h.calls.length, 0);
});
test('owned detached process releases the lease only after real group termination', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/firefox-mac-setup-browser.js'), 'utf8');
    const module = { exports: {} }; let locked = false, ended = false;
    const nativeSpawn = require('node:child_process').spawn;
    const modules = {
        'node:child_process': { spawn(_file, args, options) {
            assert.deepEqual(Array.from(args), ['-no-remote', '-profile', '/owned/firefox-profile', 'https://x.com/']);
            return nativeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], options);
        } },
        './firefox-mac-browser': { async verifyInstalledMacFirefox() { return { executable: '/synthetic/firefox', version: '160.0' }; } },
        './chrome-mac-profile': { async verifyMacFirefoxProfile() { return { profilePath: '/owned/firefox-profile' }; } },
        './chrome-mac-profile-lease': {
            async acquireMacProfileLease() { locked = true; return {}; },
            beginMacProfileLease() { return { end() { ended = true; } }; },
            async releaseMacProfileLease() { assert(ended); locked = false; },
        },
        './chrome-mac-process-group': require('../../src/automation/chrome-mac-process-group'),
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: name => modules[name] || require(name),
        process: { platform: 'darwin', env: { HOME: osSafeHome() } } });
    const session = await module.exports.startExperimentalMacFirefox({ rootPath: '/owned', profileId: 'fixture', experimental: true });
    assert.equal(locked, true); assert.equal(await session.releaseComplete, true); assert.equal(locked, false);
});
function osSafeHome() { return require('node:os').tmpdir(); }
