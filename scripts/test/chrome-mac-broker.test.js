'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');

test('Mac broker retains its profile lease until close, including startup failure', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-broker-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-broker-test-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacChromeProfile(base); let chrome;
    const app = '/Applications/Google Chrome.app', executable = app + '/Contents/MacOS/Google Chrome';
    let accepted = false, calls = 0, captured, signing, failAfterSpawn = false, changed = false;
    const fakeFs = { ...fs,
        async lstat(name) { if ([app, executable, app + '/Contents/Info.plist'].includes(name)) return {
            isDirectory: () => name === app, isFile: () => name !== app, isSymbolicLink: () => false,
            dev: 1, ino: name === executable && changed ? 2 : 1, size: 1, mtimeMs: 1, ctimeMs: 1 }; return fs.lstat(name); },
        async realpath(name) { return [app, executable, app + '/Contents/Info.plist'].includes(name) ? name : fs.realpath(name); } };
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:child_process') return { execFile(file, args, opts, callback) {
            signing = { file, args, opts }; callback(accepted ? null : new Error('signature rejected'), '', ''); },
        spawn() { chrome = new EventEmitter(); chrome.exitCode = null; chrome.kill = () => {}; return chrome; } };
        if (name === './chrome-private-broker') return { startChromeBroker: async options => {
            calls++; captured = options; options.spawnChrome('synthetic', [], {});
            if (failAfterSpawn) throw new Error('synthetic failure');
            if (calls === 3) changed = true;
            return { chrome, stop: async () => {} };
        } };
        if (name.startsWith('./')) return require(path.join(__dirname, '../../src/automation', name));
        return require(name);
    };
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/chrome-mac-broker.js'), 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire,
        process: { platform: 'darwin', pid: process.pid, getuid: () => process.getuid() } });
    const { startMacChromeBroker } = module.exports;
    const params = { rootPath: profile.rootPath, profileId: profile.profileId };
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROWSER_INVALID' }); assert.equal(calls, 0);
    accepted = true; const broker = await startMacChromeBroker(params);
    assert.equal(signing.file, '/usr/bin/codesign'); assert(signing.args.some(arg => arg.includes('EQHXZ8M8AV')));
    assert.equal(captured.chromePath, executable); assert.equal(captured.profilePath, profile.profilePath);
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' }); assert.equal(calls, 1);
    chrome.exitCode = 0; chrome.emit('exit');
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' });
    chrome.emit('close');
    assert.equal(await broker.releaseComplete, true);
    failAfterSpawn = true;
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_CLEANUP_PENDING' });
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' });
    chrome.emit('close');
    const lock = path.join(profile.rootPath, 'broker.lock');
    for (let i = 0; i < 100; i++) { try { await fs.access(lock); await new Promise(resolve => setTimeout(resolve, 5)); } catch { break; } }
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
    failAfterSpawn = false;
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_CLEANUP_PENDING' });
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' });
    chrome.emit('close');
    for (let i = 0; i < 100; i++) { try { await fs.access(lock); await new Promise(resolve => setTimeout(resolve, 5)); } catch { break; } }
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});
