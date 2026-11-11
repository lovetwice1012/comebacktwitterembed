'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getOrCreateMacChromeProfile, getOrCreateMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile-registry');

test('profile registry reuses the same dedicated profile and rejects tampered or missing identity', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-registry-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-registry-test-/); await fs.rm(real, { recursive: true });
    });
    const initial = await getOrCreateMacChromeProfile(base);
    await fs.writeFile(path.join(initial.profilePath, 'synthetic-existing-data'), 'preserve');
    assert.deepEqual(await getOrCreateMacChromeProfile(base), initial);
    assert.equal(await fs.readFile(path.join(initial.profilePath, 'synthetic-existing-data'), 'utf8'), 'preserve');
    const index = path.join(base, 'setup-profile.json'), saved = await fs.readFile(index, 'utf8');
    assert.equal((await fs.stat(index)).mode & 0o777, 0o600);
    await fs.writeFile(index, 'null');
    await assert.rejects(getOrCreateMacChromeProfile(base), { code: 'X_CHROME_MAC_REGISTRY_INVALID' });
    await fs.writeFile(index, saved.replace(initial.profileId, '00000000-0000-4000-8000-000000000000'));
    await assert.rejects(getOrCreateMacChromeProfile(base), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.unlink(index);
    await assert.rejects(getOrCreateMacChromeProfile(base), { code: 'X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED' });
    assert.equal(await fs.readFile(path.join(initial.profilePath, 'synthetic-existing-data'), 'utf8'), 'preserve');
    await fs.symlink(path.join(initial.rootPath, 'owner.json'), index);
    await assert.rejects(getOrCreateMacChromeProfile(base), { code: 'X_CHROME_MAC_REGISTRY_INVALID' });
    assert.equal(await fs.readFile(path.join(initial.profilePath, 'synthetic-existing-data'), 'utf8'), 'preserve');
});
test('concurrent registry requests do not create multiple profiles', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-registry-race-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-registry-race-/); await fs.rm(real, { recursive: true });
    });
    const results = await Promise.allSettled([getOrCreateMacChromeProfile(base), getOrCreateMacChromeProfile(base)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'X_CHROME_MAC_REGISTRY_BUSY').length, 1);
    const completed = results.find(result => result.status === 'fulfilled').value;
    assert.deepEqual(await getOrCreateMacChromeProfile(base), completed);
    assert.equal((await fs.readdir(base)).filter(name => name.startsWith('x-notification-setup-')).length, 1);
});
test('Firefox profile persists independently of Chrome and fails closed on replacement or missing index', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-firefox-registry-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-firefox-registry-/); await fs.rm(real, { recursive: true });
    });
    const [chrome, firefox] = await Promise.all([getOrCreateMacChromeProfile(base), getOrCreateMacFirefoxProfile(base)]);
    assert.notEqual(chrome.rootPath, firefox.rootPath);
    await fs.writeFile(path.join(firefox.profilePath, 'synthetic-existing-data'), 'preserve');
    assert.deepEqual(await getOrCreateMacFirefoxProfile(base), firefox);
    assert.deepEqual(await getOrCreateMacChromeProfile(base), chrome);
    const index = path.join(base, 'firefox-setup-profile.json');
    assert.equal((await fs.stat(index)).mode & 0o777, 0o600);
    await fs.writeFile(index, JSON.stringify({ rootPath: chrome.rootPath, profileId: chrome.profileId }));
    await assert.rejects(getOrCreateMacFirefoxProfile(base), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.unlink(index);
    await assert.rejects(getOrCreateMacFirefoxProfile(base), { code: 'X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED' });
    assert.equal(await fs.readFile(path.join(firefox.profilePath, 'synthetic-existing-data'), 'utf8'), 'preserve');
    assert.deepEqual(await getOrCreateMacChromeProfile(base), chrome);
});
