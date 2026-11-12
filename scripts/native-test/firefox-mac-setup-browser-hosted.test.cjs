'use strict';

// Hosted macOS only. This uses an owned profile and replaces the destination
// with about:blank; no account, normal profile, subscription, or X is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { acquireMacProfileLease } = require('../../src/automation/chrome-mac-profile-lease');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('signed Firefox opens only its dedicated Mac profile and releases it after shutdown',
    { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-launch-hosted-'));
        const profile = await createMacFirefoxProfile(base); let child, session, childClosed = false;
        t.after(async () => {
            if (child && !childClosed) try { child.kill('SIGTERM'); } catch { /* Preserve on uncertainty. */ }
            let stopped = !child;
            if (session) {
                let timer;
                try { stopped = await Promise.race([session.releaseComplete, new Promise(resolve => { timer = setTimeout(() => resolve(false), 20000); })]); }
                finally { clearTimeout(timer); }
            } else if (child?.pid) stopped = childClosed && await waitForMacProcessGroupExit(child.pid);
            if (stopped) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-firefox-launch-hosted-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(stopped, true, 'synthetic profile retained because Firefox termination was not confirmed');
        });
        const modulePath = path.resolve(__dirname, '../../src/automation/firefox-mac-setup-browser.js');
        const source = await fs.readFile(modulePath, 'utf8'), local = createRequire(modulePath), mod = { exports: {} };
        function requireForFixture(name) {
            if (name !== 'node:child_process') return local(name);
            return { spawn(executable, args, options) {
                assert.equal(executable, '/Applications/Firefox.app/Contents/MacOS/firefox');
                assert.deepEqual(Array.from(args), ['-no-remote', '-profile', profile.profilePath, 'https://x.com/']);
                child = spawn(executable, ['-headless', '-offline', ...args.slice(0, -1), 'about:blank'],
                    { ...options, env: { ...options.env, MOZ_HEADLESS: '1', MOZ_DISABLE_NONLOCAL_CONNECTIONS: '1' } });
                child.once('close', () => { childClosed = true; }); return child;
            } };
        }
        vm.runInNewContext(source, { module: mod, exports: mod.exports, require: requireForFixture, process });
        session = await mod.exports.startExperimentalMacFirefox({ rootPath: profile.rootPath, profileId: profile.profileId, experimental: true });
        let active = false;
        for (let attempt = 0; attempt < 300 && !active && !childClosed; attempt++) {
            try { await fs.lstat(path.join(profile.profilePath, '.parentlock')); active = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        assert.equal(active, true, 'Firefox did not open the synthetic profile');
        await assert.rejects(acquireMacProfileLease({ rootPath: profile.rootPath, profileId: profile.profileId, browser: 'firefox' }),
            { code: 'X_CHROME_MAC_LEASE_BUSY' });
        assert.equal(child.kill('SIGTERM'), true);
        assert.equal(await session.releaseComplete, true);
        assert.equal(childClosed, true);
    });
