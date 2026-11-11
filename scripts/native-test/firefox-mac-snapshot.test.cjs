'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { withMacFirefoxSnapshot } = require('../../src/automation/firefox-mac-snapshot');
const { withMacStoreLocks } = require('../../src/automation/chrome-mac-store-locks');
const helper = process.env.MAC_LOCK_HELPER;

test('Firefox snapshot copies only push files while locked and removes its own copy', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-snapshot-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-firefox-snapshot-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacFirefoxProfile(base), dir = path.join(profile.profilePath, 'storage/permanent/chrome/idb');
    const db = '2918063365piupsah', id = '0123456789abcdef0123456789abcdef';
    await fs.mkdir(path.join(dir, `${db}.files`, 'nested'), { recursive: true });
    await fs.writeFile(path.join(profile.profilePath, '.parentlock'), '');
    await fs.writeFile(path.join(profile.profilePath, 'prefs.js'), `user_pref("dom.push.userAgentID", "${id}");\n`);
    await fs.writeFile(path.join(profile.profilePath, 'cookies.sqlite'), 'private-cookie');
    await fs.writeFile(path.join(dir, `${db}.sqlite`), 'synthetic-db');
    await fs.writeFile(path.join(dir, `${db}.sqlite-wal`), 'synthetic-wal');
    await fs.writeFile(path.join(dir, `${db}.files/nested/1`), 'synthetic-blob');
    await fs.writeFile(path.join(dir, 'unrelated.sqlite'), 'private-other-db');
    const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper,
        expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
    const result = await withMacFirefoxSnapshot({ ...args, work: async ({ snapshotPath, uaid, signal }) => {
        assert.equal(uaid, id); assert.equal(signal.aborted, false);
        const dest = path.join(snapshotPath, 'storage/permanent/chrome/idb');
        assert.equal(await fs.readFile(path.join(dest, `${db}.sqlite`), 'utf8'), 'synthetic-db');
        assert.equal(await fs.readFile(path.join(dest, `${db}.sqlite-wal`), 'utf8'), 'synthetic-wal');
        assert.equal(await fs.readFile(path.join(dest, `${db}.files/nested/1`), 'utf8'), 'synthetic-blob');
        await assert.rejects(fs.access(path.join(snapshotPath, 'cookies.sqlite')), { code: 'ENOENT' });
        await assert.rejects(fs.access(path.join(dest, 'unrelated.sqlite')), { code: 'ENOENT' });
        await assert.rejects(withMacStoreLocks({ ...args, browser: 'firefox', work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_BUSY' });
        return 'snapshot-checked';
    } });
    assert.equal(result, 'snapshot-checked');
    assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-')));
    assert.equal(await fs.readFile(path.join(profile.profilePath, 'cookies.sqlite'), 'utf8'), 'private-cookie');
    await assert.rejects(withMacFirefoxSnapshot({ ...args, work: async () => { throw new Error('private fixture error'); } }), { code: 'X_FIREFOX_MAC_SNAPSHOT_INVALID' });
    assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-')));
    await fs.unlink(path.join(dir, `${db}.sqlite`));
    await fs.symlink(path.join(profile.profilePath, 'cookies.sqlite'), path.join(dir, `${db}.sqlite`));
    await assert.rejects(withMacFirefoxSnapshot({ ...args, work: async () => assert.fail('symlink copied') }), { code: 'X_FIREFOX_MAC_SNAPSHOT_INVALID' });
    assert.equal(await fs.readFile(path.join(profile.profilePath, 'cookies.sqlite'), 'utf8'), 'private-cookie');
    assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-')));
    await fs.unlink(path.join(dir, `${db}.sqlite`)); await fs.writeFile(path.join(dir, `${db}.sqlite`), 'synthetic-db');
    const link = path.join(dir, `${db}.files/nested/foreign`);
    await fs.symlink(path.join(profile.profilePath, 'cookies.sqlite'), link);
    await assert.rejects(withMacFirefoxSnapshot({ ...args, work: async () => assert.fail('linked blob copied') }), { code: 'X_FIREFOX_MAC_SNAPSHOT_INVALID' });
    await fs.unlink(link);
    const earlyExit = path.join(base, 'synthetic-exit-helper');
    await fs.writeFile(earlyExit, '#!/bin/sh\nprintf R\nsleep 0.1\n', { mode: 0o700 });
    const earlyHash = createHash('sha256').update(await fs.readFile(earlyExit)).digest('hex');
    const realOpen = fs.open.bind(fs), dbPath = path.join(dir, `${db}.sqlite`);
    const hook = mock.method(fs, 'open', async (name, ...options) => {
        const handle = await realOpen(name, ...options);
        if (name === dbPath) {
            const read = handle.read.bind(handle);
            handle.read = async (...readArgs) => { await new Promise(resolve => setTimeout(resolve, 200)); return read(...readArgs); };
        }
        return handle;
    });
    try {
        await assert.rejects(withMacFirefoxSnapshot({ ...args, helperPath: earlyExit, expectedSha256: earlyHash,
            work: async () => assert.fail('snapshot continued after lost lock') }), { code: 'X_CHROME_MAC_LOCK_LOST' });
    } finally { hook.mock.restore(); }
    assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-')));
    const sentinel = path.join(base, 'unrelated-sentinel'); await fs.writeFile(sentinel, 'preserve');
    await assert.rejects(withMacFirefoxSnapshot({ ...args, work: async ({ snapshotPath }) => {
        const copied = path.join(snapshotPath, 'storage/permanent/chrome/idb', `${db}.sqlite`);
        await fs.unlink(copied); await fs.symlink(sentinel, copied);
    } }), { code: 'X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED' });
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
});
