'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createMacChromeProfile, createMacEdgeProfile } = require('../../src/automation/chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('../../src/automation/chrome-mac-profile-lease');

test('Mac Edge broker checks signer and dedicated profile and preserves explicit suppression mode', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-edge-broker-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-edge-broker-test-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacEdgeProfile(base), chromeProfile = await createMacChromeProfile(base);
    const app = '/Applications/Microsoft Edge.app', executable = app + '/Contents/MacOS/Microsoft Edge';
    const children = []; let accepted = false, captured, signing, failAfterSpawn = false;
    const fakeFs = { ...fs,
        async lstat(name) { if (name === app) return { isDirectory: () => true, isSymbolicLink: () => false };
            if (name === executable) return { isFile: () => true, isSymbolicLink: () => false }; return fs.lstat(name); },
        async realpath(name) { return name === app || name === executable ? name : fs.realpath(name); } };
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:child_process') return { execFile(file, args, opts, callback) {
            signing = { file, args, opts }; callback(accepted ? null : new Error('signature rejected'), '', ''); },
            spawn() { const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; children.push(child); return child; } };
        if (name === './chrome-mac-profile') return require('../../src/automation/chrome-mac-profile');
        if (name === './chrome-mac-profile-lease') return require('../../src/automation/chrome-mac-profile-lease');
        if (name === './edge-private-broker') return { startChromeBroker: async options => {
            captured = options;
            if (failAfterSpawn) { options.spawnChrome('fixture', [], {}); throw new Error('synthetic start failure'); }
            const chrome = new EventEmitter(); chrome.exitCode = null; children.push(chrome); return { chrome };
        } };
        return require(name);
    };
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/edge-mac-broker.js'), 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire,
        process: { platform: 'darwin', pid: process.pid, getuid: () => process.getuid() } });
    const { startMacEdgeBroker } = module.exports, args = { rootPath: profile.rootPath, profileId: profile.profileId };
    await assert.rejects(startMacEdgeBroker(args), { code: 'X_EDGE_MAC_BROKER_INVALID' });
    await assert.rejects(startMacEdgeBroker({ ...args, suppressReceive: false }), { code: 'X_EDGE_MAC_BROWSER_INVALID' });
    accepted = true;
    await assert.rejects(startMacEdgeBroker({ rootPath: chromeProfile.rootPath, profileId: chromeProfile.profileId, suppressReceive: false }), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    for (const suppressReceive of [false, true]) {
        const broker = await startMacEdgeBroker({ ...args, suppressReceive });
        assert.equal(signing.file, '/usr/bin/codesign'); assert(signing.args.some(arg => arg.includes('UBF8T346G9') && arg.includes('com.microsoft.edgemac')));
        assert.equal(captured.chromePath, executable); assert.equal(captured.profilePath, profile.profilePath);
        assert.equal(captured.browserMode, 'edge'); assert.equal(captured.includeApplicationServerKey, true); assert.equal(captured.suppressReceive, suppressReceive);
        await assert.rejects(startMacEdgeBroker({ ...args, suppressReceive }), { code: 'X_EDGE_MAC_BROKER_BUSY' });
        const child = children.at(-1); child.exitCode = 0; child.emit('exit'); assert.equal(await broker.releaseComplete, true);
    }
    const leaseArgs = { ...args, browser: 'edge' }, lease = await acquireMacProfileLease(leaseArgs);
    const inspection = beginMacProfileLease(lease, leaseArgs); inspection.end();
    const handedOff = await startMacEdgeBroker({ ...args, suppressReceive: true, profileLease: lease });
    await assert.rejects(acquireMacProfileLease(leaseArgs), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    const handedOffChild = children.at(-1); handedOffChild.exitCode = 0; handedOffChild.emit('exit');
    assert.equal(await handedOff.releaseComplete, true);
    const replacement = await acquireMacProfileLease(leaseArgs); await releaseMacProfileLease(replacement);
    failAfterSpawn = true;
    await assert.rejects(startMacEdgeBroker({ ...args, suppressReceive: true }), { code: 'X_EDGE_MAC_BROKER_CLEANUP_PENDING' });
    await assert.rejects(startMacEdgeBroker({ ...args, suppressReceive: true }), { code: 'X_EDGE_MAC_BROKER_BUSY' });
    const failed = children.at(-1); failed.signalCode = 'SIGTERM'; failed.emit('exit');
    const lock = path.join(profile.rootPath, 'broker.lock');
    for (let i = 0; i < 100; i++) { try { await fs.access(lock); await new Promise(resolve => setTimeout(resolve, 5)); } catch { break; } }
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});
