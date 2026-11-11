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
    const versions = app + '/Contents/Frameworks/Google Chrome Framework.framework/Versions';
    let accepted = false, timedOut = false, calls = 0, captured, signing, failAfterSpawn = false, changed = false, finishGroup;
    let frameworkVersion = '151.0.7922.174', flipDuringSignature = false;
    let groupGone = new Promise(resolve => { finishGroup = resolve; });
    const fakeFs = { ...fs,
        async lstat(name) { if ([app, executable, app + '/Contents/Info.plist', versions + '/Current',
            versions + '/' + frameworkVersion, versions + '/' + frameworkVersion + '/Google Chrome Framework'].includes(name)) return {
            isDirectory: () => name === app || name === versions + '/' + frameworkVersion,
            isFile: () => name !== app && name !== versions + '/Current' && name !== versions + '/' + frameworkVersion,
            isSymbolicLink: () => name === versions + '/Current',
            dev: 1, ino: name === executable && changed ? 2 : 1, size: 1, mtimeMs: 1, ctimeMs: 1 }; return fs.lstat(name); },
        async realpath(name) { if (name === versions + '/Current') return versions + '/' + frameworkVersion;
            return [app, executable, app + '/Contents/Info.plist', versions + '/' + frameworkVersion,
                versions + '/' + frameworkVersion + '/Google Chrome Framework'].includes(name) ? name : fs.realpath(name); },
        async readlink(name) { if (name === versions + '/Current') return frameworkVersion; return fs.readlink(name); } };
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:child_process') return { execFile(file, args, opts, callback) {
            signing = { file, args, opts };
            const error = timedOut ? Object.assign(new Error('private diagnostic'), { killed: true, signal: 'SIGTERM' }) : new Error('signature rejected');
            if (flipDuringSignature) frameworkVersion = '157.0.8103.39';
            callback(accepted ? null : error, '', ''); },
        spawn(file, args, options) { assert.equal(options.detached, true); chrome = new EventEmitter(); chrome.pid = 12345; chrome.exitCode = null; chrome.kill = () => {}; return chrome; } };
        if (name === './chrome-mac-process-group') return { waitForMacProcessGroupExit: () => groupGone };
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
    timedOut = true;
    await assert.rejects(startMacChromeBroker(params), error => error.code === 'X_CHROME_MAC_BROWSER_TIMEOUT' && !error.message.includes('private'));
    assert.equal(calls, 0); timedOut = false;
    accepted = true; flipDuringSignature = true;
    await assert.rejects(module.exports.verifyInstalledChrome(), { code: 'X_CHROME_MAC_BROWSER_INVALID' });
    flipDuringSignature = false; frameworkVersion = '151.0.7922.174';
    const broker = await startMacChromeBroker(params);
    assert.equal(signing.file, '/usr/bin/codesign'); assert(signing.args.some(arg => arg.includes('EQHXZ8M8AV')));
    assert.equal(captured.chromePath, executable); assert.equal(captured.profilePath, profile.profilePath);
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' }); assert.equal(calls, 1);
    chrome.exitCode = 0; chrome.emit('exit');
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' });
    chrome.emit('close');
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' });
    finishGroup(true);
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
    changed = false; groupGone = Promise.resolve(false);
    const uncertain = await startMacChromeBroker(params);
    chrome.emit('close');
    assert.equal(await uncertain.releaseComplete, false);
    await assert.rejects(startMacChromeBroker(params), { code: 'X_CHROME_MAC_BROKER_BUSY' });
});
