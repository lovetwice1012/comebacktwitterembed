'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { withExperimentalMacFirefoxReaderDirectory } = require('../../src/automation/firefox-mac-reader-directory');

test('Firefox reader cwd is empty, held until shutdown and refuses unexpected changes',
    { skip: process.platform === 'win32', timeout: 10000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-cwd-fixture-'));
        let profile; const createdDirectories = [];
        t.after(async () => {
            const real = await fs.realpath(base);
            assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-firefox-cwd-fixture-/);
            for (const directory of createdDirectories) {
                assert.equal(path.dirname(directory), profile.rootPath); assert.match(path.basename(directory), /^firefox-reader-cwd-[0-9a-f]{32}$/);
                try { const info = await fs.lstat(directory); if (info.isDirectory() && !info.isSymbolicLink()) await fs.chmod(directory, 0o700); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            await fs.rm(real, { recursive: true });
        });
        profile = await createMacFirefoxProfile(base);
        const args = { rootPath: profile.rootPath, profileId: profile.profileId, experimental: true };
        let cwd, lateHold;
        const result = await withExperimentalMacFirefoxReaderDirectory({ ...args, work: async ({ directory, holdForReader }) => {
            cwd = directory; createdDirectories.push(directory); lateHold = holdForReader;
            assert.deepEqual(await fs.readdir(directory), []);
            assert.equal((await fs.stat(directory)).mode & 0o777, 0o500);
            if (process.getuid() !== 0) await assert.rejects(fs.writeFile(path.join(directory, 'xpcshell.js'), 'blocked'), { code: 'EACCES' });
            const release = holdForReader();
            assert.throws(() => holdForReader(), { code: 'X_FIREFOX_MAC_CWD_INVALID' });
            release(); release(); return 'stopped';
        } });
        assert.equal(result, 'stopped'); await assert.rejects(fs.lstat(cwd), { code: 'ENOENT' });
        assert.throws(() => lateHold(), { code: 'X_FIREFOX_MAC_CWD_INVALID' });
        await assert.rejects(withExperimentalMacFirefoxReaderDirectory({ ...args, experimental: false, work: async () => {} }),
            { code: 'X_FIREFOX_MAC_CWD_INVALID' });
        const controller = new AbortController(); controller.abort();
        await assert.rejects(withExperimentalMacFirefoxReaderDirectory({ ...args, signal: controller.signal, work: async () => {} }),
            { code: 'X_FIREFOX_MAC_CWD_CANCELLED' });

        let held;
        await assert.rejects(withExperimentalMacFirefoxReaderDirectory({ ...args, work: async ({ directory, holdForReader }) => {
            held = directory; createdDirectories.push(directory); holdForReader();
        } }), { code: 'X_FIREFOX_MAC_CWD_CLEANUP_FAILED' });
        assert((await fs.stat(held)).isDirectory());

        let modified;
        await assert.rejects(withExperimentalMacFirefoxReaderDirectory({ ...args, work: async ({ directory }) => {
            modified = directory; createdDirectories.push(directory); await fs.chmod(directory, 0o700);
            await fs.writeFile(path.join(directory, 'xpcshell.js'), 'sentinel'); await fs.chmod(directory, 0o500);
        } }), { code: 'X_FIREFOX_MAC_CWD_CLEANUP_FAILED' });
        assert.equal(await fs.readFile(path.join(modified, 'xpcshell.js'), 'utf8'), 'sentinel');
        const foreign = path.join(base, 'foreign'); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep'), 'unchanged');
        let moved = false, replaced = false, replacementError;
        await assert.rejects(withExperimentalMacFirefoxReaderDirectory({ ...args, work: async ({ directory }) => {
            createdDirectories.push(directory);
            try { await fs.rename(directory, `${directory}-moved`); moved = true; await fs.symlink(foreign, directory); replaced = true; }
            catch (error) { replacementError = error.code; throw error; }
        } }), error => error.code === (moved ? 'X_FIREFOX_MAC_CWD_CLEANUP_FAILED' : 'X_FIREFOX_MAC_CWD_INVALID'));
        if (!replaced) {
            t.diagnostic(`OS refused the synthetic directory replacement: ${replacementError}`);
            assert(['EPERM', 'EACCES', 'EBUSY', 'ENOTSUP'].includes(replacementError));
        }
        assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'unchanged');
    });
