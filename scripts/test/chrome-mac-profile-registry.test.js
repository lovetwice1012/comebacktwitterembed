'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { getOrCreateMacChromeProfile, getOrCreateMacBraveProfile, getOrCreateMacFirefoxProfile, getOrCreateMacEdgeProfile } = require('../../src/automation/chrome-mac-profile-registry');

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
    const [chrome, firefox, brave] = await Promise.all([getOrCreateMacChromeProfile(base), getOrCreateMacFirefoxProfile(base), getOrCreateMacBraveProfile(base)]);
    assert.notEqual(chrome.rootPath, firefox.rootPath);
    await fs.writeFile(path.join(firefox.profilePath, 'synthetic-existing-data'), 'preserve');
    assert.deepEqual(await getOrCreateMacFirefoxProfile(base), firefox);
    assert.deepEqual(await getOrCreateMacChromeProfile(base), chrome);
    assert.deepEqual(await getOrCreateMacBraveProfile(base), brave);
    const bravePreferences = path.join(brave.profilePath, 'Default', 'Preferences');
    assert.equal(JSON.parse(await fs.readFile(bravePreferences, 'utf8')).brave.gcm.channel_status, true);
    assert.equal((await fs.stat(bravePreferences)).mode & 0o777, 0o600);
    // Reusing an existing dedicated profile must not overwrite user choices.
    await fs.writeFile(bravePreferences, JSON.stringify({ brave: { gcm: { channel_status: false } }, sentinel: 'preserve' }));
    assert.deepEqual(await getOrCreateMacBraveProfile(base), brave);
    assert.equal(JSON.parse(await fs.readFile(bravePreferences, 'utf8')).sentinel, 'preserve');
    assert.equal(JSON.parse(await fs.readFile(bravePreferences, 'utf8')).brave.gcm.channel_status, false);
    const index = path.join(base, 'firefox-setup-profile.json');
    assert.equal((await fs.stat(index)).mode & 0o777, 0o600);
    await fs.writeFile(index, JSON.stringify({ rootPath: chrome.rootPath, profileId: chrome.profileId }));
    await assert.rejects(getOrCreateMacFirefoxProfile(base), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.unlink(index);
    await assert.rejects(getOrCreateMacFirefoxProfile(base), { code: 'X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED' });
    assert.equal(await fs.readFile(path.join(firefox.profilePath, 'synthetic-existing-data'), 'utf8'), 'preserve');
    assert.deepEqual(await getOrCreateMacChromeProfile(base), chrome);
    const braveIndex = path.join(base, 'brave-setup-profile.json');
    await fs.writeFile(braveIndex, JSON.stringify({ rootPath: firefox.rootPath, profileId: firefox.profileId }));
    await assert.rejects(getOrCreateMacBraveProfile(base), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.unlink(braveIndex);
    await assert.rejects(getOrCreateMacBraveProfile(base), { code: 'X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED' });
});

test('Edge profile stays independent, is reused, and preserves data when its index is lost or replaced',
    { skip: process.platform === 'win32' }, async t => {
        const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-edge-registry-'));
        t.after(async () => {
            const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
            assert.match(path.basename(real), /^cbte-mac-edge-registry-/); await fs.rm(real, { recursive: true });
        });
        const [chrome, brave, firefox, edge] = await Promise.all([
            getOrCreateMacChromeProfile(base), getOrCreateMacBraveProfile(base), getOrCreateMacFirefoxProfile(base), getOrCreateMacEdgeProfile(base),
        ]);
        assert.equal(new Set([chrome.rootPath, brave.rootPath, firefox.rootPath, edge.rootPath]).size, 4);
        assert.equal(path.basename(edge.profilePath), 'edge-profile');
        const marker = path.join(edge.profilePath, 'synthetic-existing-data'); await fs.writeFile(marker, 'preserve');
        assert.deepEqual(await getOrCreateMacEdgeProfile(base), edge);
        const index = path.join(base, 'edge-setup-profile.json'), original = await fs.readFile(index, 'utf8');
        assert.equal((await fs.stat(index)).mode & 0o777, 0o600);
        await fs.writeFile(index, JSON.stringify({ rootPath: firefox.rootPath, profileId: firefox.profileId }));
        await assert.rejects(getOrCreateMacEdgeProfile(base), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
        await fs.writeFile(index, original);
        assert.deepEqual(await getOrCreateMacEdgeProfile(base), edge);
        await fs.unlink(index);
        await assert.rejects(getOrCreateMacEdgeProfile(base), { code: 'X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED' });
        assert.equal(await fs.readFile(marker, 'utf8'), 'preserve');
        assert.deepEqual(await getOrCreateMacChromeProfile(base), chrome);
        assert.deepEqual(await getOrCreateMacBraveProfile(base), brave);
        assert.deepEqual(await getOrCreateMacFirefoxProfile(base), firefox);
    });

// Exercise the actual registry module on every platform without opening a
// real browser profile. The in-memory driver models private ownership, hard
// links and O_NOFOLLOW; native filesystem behavior is covered by the Mac test.
async function registryFixture() {
    const entries = new Map(), posix = path.posix, uid = 501, base = '/fixture/private';
    let nextInode = 1, nextId = 1;
    function put(name, type, content = '', mode = type === 'dir' ? 0o700 : 0o600) {
        const entry = { type, content, mode, ino: nextInode++, dev: 1 }; entries.set(name, entry); return entry;
    }
    function missing(code) { return Object.assign(new Error(code), { code }); }
    function stat(entry) { return { uid, mode: entry.mode, dev: entry.dev, ino: entry.ino,
        nlink: [...entries.values()].filter(value => value === entry).length, size: Buffer.byteLength(entry.content),
        isDirectory: () => entry.type === 'dir', isFile: () => entry.type === 'file', isSymbolicLink: () => entry.type === 'symlink' }; }
    put(base, 'dir');
    const fakeFs = {
        async lstat(name) { const entry = entries.get(name); if (!entry) throw missing('ENOENT'); return stat(entry); },
        async realpath(name) { if (!entries.has(name)) throw missing('ENOENT'); return name; },
        async readdir(name) { return [...entries.keys()].filter(value => posix.dirname(value) === name).map(value => posix.basename(value)); },
        async open(name, flags, mode) {
            let entry = entries.get(name);
            if (flags === 'wx') { if (entry) throw missing('EEXIST'); entry = put(name, 'file', '', mode); }
            else if (!entry) throw missing('ENOENT');
            else if (entry.type === 'symlink') throw missing('ELOOP');
            return { async stat() { return stat(entry); }, async readFile() { return entry.content; },
                async writeFile(value) { entry.content = String(value); }, async sync() {}, async close() {} };
        },
        async link(from, to) { if (entries.has(to)) throw missing('EEXIST'); if (!entries.has(from)) throw missing('ENOENT'); entries.set(to, entries.get(from)); },
        async unlink(name) { if (!entries.delete(name)) throw missing('ENOENT'); },
    };
    const kinds = { Chrome: ['setup', 'chrome'], Brave: ['brave', 'brave'], Firefox: ['firefox', 'firefox'], Edge: ['edge', 'edge'] };
    const profiles = new Map(), profileApi = {};
    for (const [browser, [prefix, folder]] of Object.entries(kinds)) {
        profileApi[`createMac${browser}Profile`] = async parent => {
            const suffix = String(nextId++).padStart(32, '0'), rootPath = posix.join(parent, `x-notification-${prefix}-${suffix}`);
            const profileId = `${suffix.slice(0, 8)}-${suffix.slice(8, 12)}-4000-8000-${suffix.slice(-12)}`;
            const value = { rootPath, profilePath: posix.join(rootPath, `${folder}-profile`), profileId, browser };
            profiles.set(rootPath, value); put(rootPath, 'dir'); put(value.profilePath, 'dir');
            return { rootPath, profilePath: value.profilePath, profileId };
        };
        profileApi[`verifyMac${browser}Profile`] = async (rootPath, profileId) => {
            const value = profiles.get(rootPath);
            if (!value || value.browser !== browser || value.profileId !== profileId) throw missing('X_CHROME_MAC_PROFILE_INVALID');
            return { rootPath, profilePath: value.profilePath, profileId };
        };
    }
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/chrome-mac-profile-registry.js'), 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, Buffer,
        process: { platform: 'darwin', getuid: () => uid }, require(name) {
            if (name === 'node:fs/promises') return fakeFs;
            if (name === 'node:fs') return { constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100 } };
            if (name === 'node:path') return posix;
            if (name === 'node:crypto') return require('node:crypto');
            if (name === './strict-json') return { parseUniqueJson: JSON.parse };
            if (name === './chrome-mac-profile') return profileApi;
            throw new Error('unexpected dependency');
        } });
    return { base, entries, put, ...module.exports };
}

test('Edge registry separates browser identities and preserves an orphan using a synthetic filesystem', async () => {
    const f = await registryFixture();
    const chrome = await f.getOrCreateMacChromeProfile(f.base), brave = await f.getOrCreateMacBraveProfile(f.base);
    const firefox = await f.getOrCreateMacFirefoxProfile(f.base), edge = await f.getOrCreateMacEdgeProfile(f.base);
    assert.equal(new Set([chrome.rootPath, brave.rootPath, firefox.rootPath, edge.rootPath]).size, 4);
    assert.deepEqual(await f.getOrCreateMacEdgeProfile(f.base), edge);
    const sentinel = `${edge.profilePath}/synthetic-existing-data`; f.put(sentinel, 'file', 'preserve');
    const index = `${f.base}/edge-setup-profile.json`, original = f.entries.get(index).content;
    f.entries.get(index).content = JSON.stringify({ rootPath: firefox.rootPath, profileId: firefox.profileId });
    await assert.rejects(f.getOrCreateMacEdgeProfile(f.base), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    f.entries.get(index).content = original;
    assert.deepEqual(await f.getOrCreateMacEdgeProfile(f.base), edge);
    f.entries.delete(index);
    await assert.rejects(f.getOrCreateMacEdgeProfile(f.base), { code: 'X_CHROME_MAC_REGISTRY_RECOVERY_REQUIRED' });
    assert.equal(f.entries.get(sentinel).content, 'preserve');
    assert.deepEqual(await f.getOrCreateMacChromeProfile(f.base), chrome);
    assert.deepEqual(await f.getOrCreateMacBraveProfile(f.base), brave);
    assert.deepEqual(await f.getOrCreateMacFirefoxProfile(f.base), firefox);
});

test('Edge registry rejects a linked index and concurrent creation with a synthetic filesystem', async () => {
    const f = await registryFixture(), edge = await f.getOrCreateMacEdgeProfile(f.base);
    const index = `${f.base}/edge-setup-profile.json`;
    f.entries.delete(index); f.put(index, 'symlink');
    await assert.rejects(f.getOrCreateMacEdgeProfile(f.base), { code: 'X_CHROME_MAC_REGISTRY_INVALID' });
    assert(f.entries.has(edge.profilePath));
    const g = await registryFixture();
    const results = await Promise.allSettled([g.getOrCreateMacEdgeProfile(g.base), g.getOrCreateMacEdgeProfile(g.base)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'X_CHROME_MAC_REGISTRY_BUSY').length, 1);
});
