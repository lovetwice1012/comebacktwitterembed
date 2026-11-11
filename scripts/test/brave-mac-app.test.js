'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { ensureMacSetupDirectory } = require('../../src/automation/chrome-mac-app');
const { getOrCreateMacChromeProfile } = require('../../src/automation/chrome-mac-profile-registry');

test('experimental Brave bootstrap keeps separate owned profiles and fails closed on tampering', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-brave-mac-app-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-brave-mac-app-/); await fs.rm(real, { recursive: true });
    });
    const support = path.join(base, 'Application Support'); await fs.mkdir(support, { mode: 0o700 });
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/brave-mac-app.js'), 'utf8');
    const module = { exports: {} }, sessions = [];
    const mockedRequire = name => {
        if (name === './brave-mac-setup-session') return { runExperimentalMacBraveSetup: async options => {
            sessions.push(options); return { state: 'cancelled' };
        } };
        if (name.startsWith('./')) return require(path.join(__dirname, '../../src/automation', name));
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire });
    const run = module.exports.runExperimentalMacBraveApp;
    const ui = Object.fromEntries(['confirmOpen', 'confirmNotifications', 'retryCapture', 'confirmKeychain', 'confirmSave'].map(name => [name, async () => false]));
    const args = { applicationSupport: support, helperPath: '/tmp/synthetic-helper', expectedSha256: 'a'.repeat(64), ui, experimental: true };
    await assert.rejects(run({ ...args, experimental: false }), { code: 'X_BRAVE_MAC_APP_INVALID' });
    await assert.rejects(run({ ...args, helperPath: 'relative' }), { code: 'X_BRAVE_MAC_APP_INVALID' });
    await assert.rejects(run({ ...args, ui: {} }), { code: 'X_BRAVE_MAC_APP_INVALID' });
    assert.deepEqual(await fs.readdir(support), []); assert.equal(sessions.length, 0);
    const data = await ensureMacSetupDirectory(support), chrome = await getOrCreateMacChromeProfile(data);
    await fs.writeFile(path.join(chrome.profilePath, 'synthetic-sentinel'), 'preserve');
    assert.equal((await run(args)).state, 'cancelled'); assert.equal((await run(args)).state, 'cancelled');
    assert.equal(sessions.length, 2); assert.equal(sessions[0].rootPath, sessions[1].rootPath);
    assert.equal(sessions[0].profileId, sessions[1].profileId); assert.equal(sessions[0].experimental, true);
    assert.notEqual(sessions[0].rootPath, chrome.rootPath); assert.equal(path.basename(sessions[0].rootPath).startsWith('x-notification-brave-'), true);
    assert.equal(await fs.readFile(path.join(chrome.profilePath, 'synthetic-sentinel'), 'utf8'), 'preserve');
    await fs.writeFile(path.join(data, 'brave-setup-profile.json'), JSON.stringify({ rootPath: chrome.rootPath, profileId: chrome.profileId }));
    await assert.rejects(run(args), { code: 'X_CHROME_MAC_PROFILE_INVALID' }); assert.equal(sessions.length, 2);
    assert.equal(await fs.readFile(path.join(chrome.profilePath, 'synthetic-sentinel'), 'utf8'), 'preserve');
});
