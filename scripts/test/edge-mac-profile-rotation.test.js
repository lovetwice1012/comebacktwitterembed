'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    const entries = new Map(), p = path.posix, base = '/fixture/private', uid = 501;
    let ino = 0, serial = 0, held = false, failAt = '', directorySyncs = 0;
    const add = (name, type, content = '', mode = type === 'dir' ? 0o700 : 0o600) => {
        const value = { type, content, mode, ino: ++ino, dev: 1, mtimeMs: 1 }; entries.set(name, value); return value;
    };
    const stat = v => ({ uid, mode: v.mode, dev: v.dev, ino: v.ino, mtimeMs: v.mtimeMs,
        nlink: [...entries.values()].filter(item => item === v).length, size: Buffer.byteLength(v.content),
        isDirectory: () => v.type === 'dir', isFile: () => v.type === 'file', isSymbolicLink: () => v.type === 'symlink' });
    const missing = code => Object.assign(new Error(code), { code });
    const maybe = name => { if (failAt === name) throw missing('EIO'); };
    add(base, 'dir'); const oldProfile = { rootPath: `${base}/old`, profileId: 'old-id', profilePath: `${base}/old/edge-profile` };
    add(oldProfile.rootPath, 'dir'); add(oldProfile.profilePath, 'dir'); add(`${oldProfile.profilePath}/sentinel`, 'file', 'old subscription');
    const index = `${base}/edge-setup-profile.json`, lock = `${base}/edge-registry.lock`;
    const original = JSON.stringify({ rootPath: oldProfile.rootPath, profileId: oldProfile.profileId }); add(index, 'file', original);
    const fakeFs = {
        async lstat(name) { const v = entries.get(name); if (!v) throw missing('ENOENT'); return stat(v); },
        async realpath(name) { return name; },
        async open(name, flags, mode) {
            let v = entries.get(name);
            if (flags === 'wx') { if (v) throw missing('EEXIST'); maybe(name.includes('backup-') ? 'backup-open' : name.includes('rotation-') ? 'temp-open' : 'lock-open'); v = add(name, 'file', '', mode); }
            else if (!v) throw missing('ENOENT');
            else if (v.type === 'symlink') throw missing('ELOOP');
            if (flags !== 'wx' && name.includes('backup-') && ['temp-replace', 'temp-modify', 'temp-symlink'].includes(failAt)) {
                const temp = [...entries.keys()].find(key => key.includes('rotation-'));
                if (failAt === 'temp-modify') entries.get(temp).content = 'modified';
                else { entries.delete(temp); add(temp, failAt === 'temp-symlink' ? 'symlink' : 'file', 'replacement'); }
            }
            return { async stat() { return stat(v); }, async readFile() { return v.content; },
                async writeFile(data) { maybe(name.includes('backup-') ? 'backup-write' : 'temp-write'); v.content = String(data); },
                async sync() {
                    if (name === base && ++directorySyncs === 3) maybe('post-rename-sync');
                    if (name.endsWith('/edge-profile')) maybe('profile-directory-sync');
                    if (/\/new-[0-9]+$/.test(name)) maybe('root-directory-sync');
                    if (name.includes('rotation-') && ['backup-delete', 'backup-replace'].includes(failAt)) {
                        const backup = [...entries.keys()].find(key => key.includes('backup-')); entries.delete(backup);
                        if (failAt === 'backup-replace') add(backup, 'file', original);
                    }
                    maybe(name === base ? 'directory-sync' : name.includes('backup-') ? 'backup-sync' : 'temp-sync');
                }, async close() {} };
        },
        async rename(from, to) { maybe('rename'); if (!entries.has(from)) throw missing('ENOENT'); entries.set(to, entries.get(from)); entries.delete(from); },
        async unlink(name) { if (!entries.delete(name)) throw missing('ENOENT'); },
    };
    const profiles = {
        async verifyMacEdgeProfile(root, id) { if (root !== oldProfile.rootPath || id !== oldProfile.profileId) throw missing('X_CHROME_MAC_PROFILE_INVALID'); return oldProfile; },
        async createMacEdgeProfile() { maybe('create'); const rootPath = `${base}/new-${++serial}`, profile = { rootPath, profilePath: `${rootPath}/edge-profile`, profileId: `new-${serial}` };
            add(rootPath, 'dir'); add(profile.profilePath, 'dir'); return profile; },
    };
    const leases = { async acquireMacProfileLease() { if (held) throw missing('X_CHROME_MAC_LEASE_BUSY'); held = true; return {}; },
        async releaseMacProfileLease() { held = false; } };
    const mod = { exports: {} }, source = fs.readFileSync(path.join(__dirname, '../../src/automation/edge-mac-profile-rotation.js'), 'utf8');
    vm.runInNewContext(source, { module: mod, exports: mod.exports, Buffer, process: { platform: 'darwin', getuid: () => uid }, require(name) {
        if (name === 'node:fs/promises') return fakeFs; if (name === 'node:fs') return { constants: { O_RDONLY: 0, O_NOFOLLOW: 256 } };
        if (name === 'node:path') return p; if (name === 'node:crypto') return require('node:crypto');
        if (name === './strict-json') return { parseUniqueJson: JSON.parse }; if (name === './chrome-mac-profile') return profiles;
        if (name === './chrome-mac-profile-lease') return leases; throw new Error('unexpected dependency');
    } });
    const registry = { exports: {} }, registrySource = fs.readFileSync(path.join(__dirname, '../../src/automation/chrome-mac-profile-registry.js'), 'utf8');
    vm.runInNewContext(registrySource, { module: registry, exports: registry.exports, Buffer,
        process: { platform: 'darwin', getuid: () => uid }, require(name) {
            if (name === 'node:fs/promises') return fakeFs; if (name === 'node:fs') return { constants: { O_RDONLY: 0, O_NOFOLLOW: 256 } };
            if (name === 'node:path') return p; if (name === 'node:crypto') return require('node:crypto');
            if (name === './strict-json') return { parseUniqueJson: JSON.parse }; if (name === './chrome-mac-profile') return profiles;
            throw new Error('unexpected dependency');
        } });
    return { rotate: mod.exports.rotateMacEdgeProfile, get: registry.exports.getOrCreateMacEdgeProfile,
        oldProfile, base, index, lock, entries, original, setFailure: value => { failAt = value; } };
}
test('explicit rotation keeps old profile and a recoverable index', async () => {
    const f = fixture();
    await assert.rejects(f.rotate({ directory: f.base, oldProfile: f.oldProfile, confirmed: false }), { code: 'X_EDGE_MAC_ROTATION_INVALID' });
    assert.equal(f.entries.size, 5);
    const next = await f.rotate({ directory: f.base, oldProfile: f.oldProfile, confirmed: true });
    assert.notEqual(next.rootPath, f.oldProfile.rootPath);
    assert.equal(JSON.parse(f.entries.get(f.index).content).rootPath, next.rootPath);
    assert.equal(f.entries.get(`${f.oldProfile.profilePath}/sentinel`).content, 'old subscription');
    const backup = [...f.entries.entries()].find(([name]) => name.includes('backup-'));
    assert.equal(backup[1].content, f.original); assert(!f.entries.has(f.lock));
});
test('failures and competing rotations preserve the prior profile and its index or backup', async () => {
    for (const step of ['backup-open', 'backup-write', 'backup-sync', 'directory-sync', 'create', 'profile-directory-sync', 'root-directory-sync',
        'temp-open', 'temp-write', 'temp-sync', 'backup-delete', 'backup-replace', 'temp-replace', 'temp-modify', 'temp-symlink', 'rename']) {
        const f = fixture(); f.setFailure(step);
        await assert.rejects(f.rotate({ directory: f.base, oldProfile: f.oldProfile, confirmed: true }));
        assert.equal(f.entries.get(f.index).content, f.original, step);
        assert.equal(f.entries.get(`${f.oldProfile.profilePath}/sentinel`).content, 'old subscription', step);
        assert(!f.entries.has(f.lock), step);
        f.setFailure(''); assert.equal((await f.get(f.base)).rootPath, f.oldProfile.rootPath, step);
    }
    const f = fixture(), results = await Promise.allSettled([f.rotate({ directory: f.base, oldProfile: f.oldProfile, confirmed: true }),
        f.rotate({ directory: f.base, oldProfile: f.oldProfile, confirmed: true })]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
    assert.equal(f.entries.get(`${f.oldProfile.profilePath}/sentinel`).content, 'old subscription');
});
test('a post-rename sync failure reports failure but retains the old backup and new index', async () => {
    const f = fixture(); f.setFailure('post-rename-sync');
    await assert.rejects(f.rotate({ directory: f.base, oldProfile: f.oldProfile, confirmed: true }), { code: 'X_EDGE_MAC_ROTATION_FAILED' });
    assert.notEqual(f.entries.get(f.index).content, f.original);
    assert.equal([...f.entries.entries()].find(([name]) => name.includes('backup-'))[1].content, f.original);
    assert.equal(f.entries.get(`${f.oldProfile.profilePath}/sentinel`).content, 'old subscription');
    assert(!f.entries.has(f.lock));
});

test('native private registry survives rotation and reuse with both profiles intact', { skip: process.platform !== 'darwin' }, async t => {
    const fsp = require('node:fs/promises'), os = require('node:os');
    const { getOrCreateMacEdgeProfile } = require('../../src/automation/chrome-mac-profile-registry');
    const { rotateMacEdgeProfile } = require('../../src/automation/edge-mac-profile-rotation');
    const parent = await fsp.realpath(os.tmpdir()), base = await fsp.mkdtemp(path.join(parent, 'cbte-edge-rotation-test-'));
    t.after(async () => {
        const real = await fsp.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-edge-rotation-test-/); await fsp.rm(real, { recursive: true });
    });
    const oldProfile = await getOrCreateMacEdgeProfile(base), marker = path.join(oldProfile.profilePath, 'synthetic-sentinel');
    await fsp.writeFile(marker, 'preserve');
    const oldIndex = await fsp.readFile(path.join(base, 'edge-setup-profile.json'), 'utf8');
    const next = await rotateMacEdgeProfile({ directory: base, oldProfile, confirmed: true });
    assert.notEqual(next.rootPath, oldProfile.rootPath);
    assert.deepEqual(await getOrCreateMacEdgeProfile(base), next);
    assert.equal(await fsp.readFile(marker, 'utf8'), 'preserve');
    const backups = (await fsp.readdir(base)).filter(name => /^edge-setup-profile-backup-[a-f0-9]{32}\.json$/.test(name));
    assert.equal(backups.length, 1);
    assert.equal(await fsp.readFile(path.join(base, backups[0]), 'utf8'), oldIndex);
});
