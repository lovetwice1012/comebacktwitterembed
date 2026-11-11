'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { withMacFirefoxSnapshot } = require('../../src/automation/firefox-mac-snapshot');
const helper = process.env.MAC_LOCK_HELPER;

test('experimental Firefox artifact cleanup is bounded and preserves unsafe trees',
    { skip: !helper || process.platform === 'win32', timeout: 30000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-artifacts-'));
        t.after(async () => {
            const real = await fs.realpath(base);
            assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-firefox-artifacts-/);
            await fs.rm(real, { recursive: true });
        });
        const profile = await createMacFirefoxProfile(base), idb = path.join(profile.profilePath, 'storage/permanent/chrome/idb');
        await fs.mkdir(idb, { recursive: true });
        await fs.writeFile(path.join(profile.profilePath, '.parentlock'), '');
        await fs.writeFile(path.join(profile.profilePath, 'prefs.js'), 'user_pref("dom.push.userAgentID", "22222222-2222-4222-8222-222222222222");\n');
        await fs.writeFile(path.join(idb, '2918063365piupsah.sqlite'), 'original-synthetic-db');
        const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper,
            expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
        const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
        await assert.rejects(withMacFirefoxSnapshot({ ...args, signal: alreadyCancelled.signal,
            work: async () => assert.fail('cancelled work started') }), { code: 'X_FIREFOX_MAC_SNAPSHOT_CANCELLED' });
        const cancelled = new AbortController();
        await assert.rejects(withMacFirefoxSnapshot({ ...args, signal: cancelled.signal, work: async ({ signal }) => {
            assert.equal(signal.aborted, false); cancelled.abort(); assert.equal(signal.aborted, true);
        } }), { code: 'X_FIREFOX_MAC_SNAPSHOT_CANCELLED' });
        assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-')));
        assert.equal(await fs.readFile(path.join(idb, '2918063365piupsah.sqlite'), 'utf8'), 'original-synthetic-db');
        const interrupted = new AbortController();
        await assert.rejects(withMacFirefoxSnapshot({ ...args, signal: interrupted.signal, work: async () => {
            interrupted.abort(); throw new Error('reader interrupted');
        } }), { code: 'X_FIREFOX_MAC_SNAPSHOT_CANCELLED' });
        const generate = async snapshot => {
            await fs.mkdir(path.join(snapshot, 'cache2/entries'), { recursive: true });
            for (const dir of ['cache2/doomed', 'security_state', 'startupCache', 'storage/permanent/chrome/idb/2918063365piupsah.files'])
                await fs.mkdir(path.join(snapshot, dir));
            for (const file of ['cert9.db', 'key4.db', 'pkcs11.txt', 'storage.sqlite', 'storage/ls-archive.sqlite',
                'storage/permanent/chrome/.metadata', 'storage/permanent/chrome/.metadata-v2',
                'storage/permanent/chrome/idb/2918063365piupsah.sqlite-wal', 'storage/permanent/chrome/idb/2918063365piupsah.sqlite-shm'])
                await fs.writeFile(path.join(snapshot, file), 'generated');
        };
        const result = await withMacFirefoxSnapshot({ ...args, experimentalReaderArtifacts: true, work: async ({ snapshotPath }) => {
            await generate(snapshotPath); return 'ok';
        } });
        assert.equal(result, 'ok');
        assert(!(await fs.readdir(profile.rootPath)).some(name => name.startsWith('firefox-snapshot-')));
        assert.equal(await fs.readFile(path.join(idb, '2918063365piupsah.sqlite'), 'utf8'), 'original-synthetic-db');

        let heldPath, releaseHeld;
        await assert.rejects(withMacFirefoxSnapshot({ ...args, experimentalReaderArtifacts: true, work: async ({ snapshotPath, holdForReader }) => {
            heldPath = snapshotPath; releaseHeld = holdForReader();
            assert.throws(() => holdForReader(), { code: 'X_FIREFOX_MAC_SNAPSHOT_INVALID' });
        } }), { code: 'X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED' });
        assert.equal(await fs.readFile(path.join(heldPath, 'storage/permanent/chrome/idb/2918063365piupsah.sqlite'), 'utf8'), 'original-synthetic-db');
        releaseHeld(); releaseHeld();
        let lateHold;
        const afterStopped = await withMacFirefoxSnapshot({ ...args, experimentalReaderArtifacts: true, work: async ({ holdForReader }) => {
            lateHold = holdForReader; const release = holdForReader(); release(); release(); return 'reader-stopped';
        } });
        assert.equal(afterStopped, 'reader-stopped');
        assert.throws(() => lateHold(), { code: 'X_FIREFOX_MAC_SNAPSHOT_INVALID' });
        assert.equal(await fs.readFile(path.join(idb, '2918063365piupsah.sqlite'), 'utf8'), 'original-synthetic-db');
        const cancelHeld = new AbortController(); let cancelledPath;
        await assert.rejects(withMacFirefoxSnapshot({ ...args, experimentalReaderArtifacts: true, signal: cancelHeld.signal,
            work: async ({ snapshotPath, holdForReader }) => { cancelledPath = snapshotPath; holdForReader(); cancelHeld.abort(); } }),
        { code: 'X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED' });
        assert.equal(await fs.readFile(path.join(cancelledPath, 'storage/permanent/chrome/idb/2918063365piupsah.sqlite'), 'utf8'), 'original-synthetic-db');

        for (const scenario of ['default', 'unknown', 'symlink', 'hardlink', 'work-failed']) {
            let snapshot;
            await assert.rejects(withMacFirefoxSnapshot({ ...args, experimentalReaderArtifacts: scenario !== 'default', work: async ({ snapshotPath }) => {
                snapshot = snapshotPath; await generate(snapshotPath);
                if (scenario === 'unknown') await fs.writeFile(path.join(snapshotPath, 'unexpected'), 'preserve');
                if (scenario === 'symlink') {
                    await fs.unlink(path.join(snapshotPath, 'cert9.db'));
                    await fs.symlink(path.join(idb, '2918063365piupsah.sqlite'), path.join(snapshotPath, 'cert9.db'));
                }
                if (scenario === 'hardlink') {
                    await fs.unlink(path.join(snapshotPath, 'cert9.db'));
                    await fs.link(path.join(idb, '2918063365piupsah.sqlite'), path.join(snapshotPath, 'cert9.db'));
                }
                if (scenario === 'work-failed') throw new Error('synthetic failure');
            } }), { code: 'X_FIREFOX_MAC_SNAPSHOT_CLEANUP_FAILED' });
            assert.equal(await fs.readFile(path.join(snapshot, 'storage/permanent/chrome/idb/2918063365piupsah.sqlite'), 'utf8'), 'original-synthetic-db');
            assert.equal(await fs.readFile(path.join(idb, '2918063365piupsah.sqlite'), 'utf8'), 'original-synthetic-db');
            if (scenario === 'hardlink') await fs.unlink(path.join(snapshot, 'cert9.db'));
        }
    });
