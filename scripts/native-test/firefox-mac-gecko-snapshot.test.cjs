'use strict';
// Opt-in: CBTE_GECKO_IDB_FIXTURE must point to a disposable, synthetic
// pushapi DB produced by firefox-xpcshell-runner.ps1, never a real profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { withMacFirefoxSnapshot } = require('../../src/automation/firefox-mac-snapshot');
const fixture = process.env.CBTE_GECKO_IDB_FIXTURE, helper = process.env.MAC_LOCK_HELPER;

test('Mac snapshot copies an actual Gecko-created synthetic Push IndexedDB',
    { skip: !fixture || !helper || process.platform === 'win32', timeout: 15000 }, async t => {
        // The fixture is mounted read-only by the caller. Do not accept any
        // arbitrary local path or discover an existing browser profile.
        assert.equal(fixture, '/fixture');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-gecko-snapshot-'));
        t.after(async () => {
            const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
            assert.match(path.basename(real), /^cbte-gecko-snapshot-/); await fs.rm(real, { recursive: true });
        });
        const profile = await createMacFirefoxProfile(base), idb = path.join(profile.profilePath, 'storage/permanent/chrome/idb');
        await fs.mkdir(idb, { recursive: true });
        await fs.writeFile(path.join(profile.profilePath, '.parentlock'), '');
        await fs.writeFile(path.join(profile.profilePath, 'prefs.js'), 'user_pref("dom.push.userAgentID", "22222222-2222-4222-8222-222222222222");\n');
        const stem = '2918063365piupsah', hashes = new Map();
        const hash = bytes => createHash('sha256').update(bytes).digest('hex');
        for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal']) {
            const name = stem + suffix, file = path.join(fixture, name);
            try {
                const stat = await fs.lstat(file); assert(stat.isFile() && !stat.isSymbolicLink());
                const bytes = await fs.readFile(file); hashes.set(name, hash(bytes)); await fs.writeFile(path.join(idb, name), bytes);
            } catch (error) { if (error.code !== 'ENOENT' || suffix === '.sqlite') throw error; }
        }
        assert(hashes.has(`${stem}.sqlite`));
        const sourceBlobs = path.join(fixture, `${stem}.files`);
        try {
            const stat = await fs.lstat(sourceBlobs); assert(stat.isDirectory() && !stat.isSymbolicLink());
            assert.deepEqual(await fs.readdir(sourceBlobs), [], 'This test accepts only the empty synthetic blob fixture');
            await fs.mkdir(path.join(idb, `${stem}.files`));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const result = await withMacFirefoxSnapshot({ rootPath: profile.rootPath, profileId: profile.profileId,
            helperPath: helper, expectedSha256: hash(await fs.readFile(helper)), work: async ({ snapshotPath, uaid }) => {
                assert.equal(uaid, '22222222-2222-4222-8222-222222222222');
                const copied = path.join(snapshotPath, 'storage/permanent/chrome/idb');
                for (const [name, digest] of hashes) assert.equal(hash(await fs.readFile(path.join(copied, name))), digest);
                const check = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("pragma integrity_check").fetchone()[0]); c.close()',
                    path.join(copied, `${stem}.sqlite`)], { encoding: 'utf8', timeout: 5000 });
                assert.equal(check.status, 0, check.stderr); assert.equal(check.stdout.trim(), 'ok');
                if (process.env.CBTE_GECKO_SNAPSHOT_OUTPUT) {
                    // This optional mount is an empty, test-owned profile on the
                    // host; never write to a discovered browser profile.
                    assert.equal(process.env.CBTE_GECKO_SNAPSHOT_OUTPUT, '/export');
                    const root = '/export'; assert.deepEqual(await fs.readdir(root), []);
                    let target = root;
                    for (const component of ['storage', 'permanent', 'chrome', 'idb']) {
                        target = path.join(target, component); await fs.mkdir(target, { mode: 0o700 });
                    }
                    for (const name of hashes.keys()) await fs.copyFile(path.join(copied, name), path.join(target, name), require('node:fs').constants.COPYFILE_EXCL);
                    if (await fs.stat(path.join(idb, `${stem}.files`)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
                        await fs.mkdir(path.join(target, `${stem}.files`), { mode: 0o700 });
                }
                return 'ok';
            } });
        assert.equal(result, 'ok');
        for (const [name, digest] of hashes) assert.equal(hash(await fs.readFile(path.join(idb, name))), digest);
        assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-')));
    });
