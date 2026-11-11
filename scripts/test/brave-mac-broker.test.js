'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createMacBraveProfile, createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');

test('Mac Brave broker uses a signed app and retains its dedicated lease until child close', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-brave-mac-broker-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-brave-mac-broker-/); await fs.rm(real, { recursive: true });
    });
    const brave = await createMacBraveProfile(base), chrome = await createMacChromeProfile(base);
    let signed = false, failAfterSpawn = false, changeAfterSpawn = false, baselineSpawnCount = 0, stopCalled = false, spawnCount = 0, child, captured;
    const mockedRequire = name => {
        if (name === 'node:child_process') return { spawn() {
            spawnCount++; child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.kill = () => { child.killed = true; }; return child;
        } };
        if (name === './brave-mac-browser') return { verifyInstalledMacBrave: async () => {
            if (!signed) throw Object.assign(new Error('signature'), { code: 'X_BRAVE_MAC_BROWSER_INVALID' });
            return { executable: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
                browserVersion: changeAfterSpawn && spawnCount > baselineSpawnCount ? '158.1.99.55' : '157.1.99.55' };
        } };
        if (name === './chrome-private-broker') return { startChromeBroker: async options => {
            captured = options; const launched = options.spawnChrome('synthetic-only', [], {});
            if (failAfterSpawn) throw new Error('synthetic startup failure');
            return { chrome: launched, engineVersion: '157.0.8103.39', stop: async () => { stopCalled = true; } };
        } };
        if (name.startsWith('./')) return require(path.join(__dirname, '../../src/automation', name));
        return require(name);
    };
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/brave-mac-broker.js'), 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire });
    const start = module.exports.startMacBraveBroker, args = { rootPath: brave.rootPath, profileId: brave.profileId };
    await assert.rejects(start(args), { code: 'X_BRAVE_MAC_BROWSER_INVALID' }); assert.equal(spawnCount, 0);
    signed = true;
    await assert.rejects(start({ rootPath: chrome.rootPath, profileId: chrome.profileId }), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    const broker = await start(args); assert.equal(spawnCount, 1);
    assert.equal(broker.browserVersion, '157.1.99.55'); assert.equal(broker.engineVersion, '157.0.8103.39');
    assert.equal(captured.chromePath, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    assert.equal(captured.profilePath, brave.profilePath);
    await assert.rejects(start(args), { code: 'X_BRAVE_MAC_BROKER_BUSY' });
    child.exitCode = 0; child.emit('exit', 0);
    await assert.rejects(start(args), { code: 'X_BRAVE_MAC_BROKER_BUSY' });
    child.emit('close', 0); assert.equal(await broker.releaseComplete, true);
    failAfterSpawn = true;
    await assert.rejects(start(args), { code: 'X_BRAVE_MAC_BROKER_CLEANUP_PENDING' });
    await assert.rejects(start(args), { code: 'X_BRAVE_MAC_BROKER_BUSY' });
    child.exitCode = 1; child.emit('close', 1);
    const lock = path.join(brave.rootPath, 'broker.lock');
    for (let i = 0; i < 100; i++) { try { await fs.access(lock); await new Promise(resolve => setTimeout(resolve, 5)); } catch { break; } }
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
    failAfterSpawn = false; changeAfterSpawn = true; baselineSpawnCount = spawnCount;
    await assert.rejects(start(args), { code: 'X_BRAVE_MAC_BROKER_CLEANUP_PENDING' });
    assert.equal(child.killed, true); assert.equal(stopCalled, true);
    await assert.rejects(start(args), { code: 'X_BRAVE_MAC_BROKER_BUSY' });
    child.exitCode = 1; child.emit('close', 1);
    for (let i = 0; i < 100; i++) { try { await fs.access(lock); await new Promise(resolve => setTimeout(resolve, 5)); } catch { break; } }
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});
