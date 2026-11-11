'use strict';

// Disposable macOS host only. The actual Edge binary opens an isolated
// profile and about:blank; it never touches X or a normal browser profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createMacEdgeProfile } = require('../../src/automation/chrome-mac-profile');
const { acquireMacProfileLease } = require('../../src/automation/chrome-mac-profile-lease');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('signed Edge uses its isolated Mac profile and releases only after termination',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1', timeout: 300000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-edge-launch-hosted-'));
        const profile = await createMacEdgeProfile(base); let child, childClosed = false, broker;
        t.after(async () => {
            if (child && !childClosed) try { child.kill('SIGTERM'); } catch { /* Retain the profile if uncertain. */ }
            let stopped = !child;
            if (broker) {
                let timer;
                try { stopped = await Promise.race([broker.releaseComplete, new Promise(resolve => { timer = setTimeout(() => resolve(false), 20000); })]); }
                finally { clearTimeout(timer); await broker.stop().catch(() => {}); }
            } else if (child?.pid) stopped = childClosed && await waitForMacProcessGroupExit(child.pid);
            if (stopped) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-edge-launch-hosted-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(stopped, true, 'synthetic profile retained because Edge termination was not confirmed');
        });
        const modulePath = path.resolve(__dirname, '../../src/automation/edge-mac-broker.js');
        const source = await fs.readFile(modulePath, 'utf8'), local = createRequire(modulePath), mod = { exports: {} };
        vm.runInNewContext(source, { module: mod, exports: mod.exports, process, require(name) {
            if (name !== 'node:child_process') return local(name);
            const native = local(name);
            return { ...native, spawn(executable, args, options) {
                assert.equal(executable, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
                assert(args.includes(`--user-data-dir=${profile.profilePath}`));
                assert.equal(args.at(-1), 'https://x.com/');
                child = spawn(executable, [...args.slice(0, -1), '--headless=new', '--disable-background-networking',
                    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank'], options);
                child.once('close', () => { childClosed = true; }); return child;
            } };
        } });
        broker = await mod.exports.startMacEdgeBroker({ rootPath: profile.rootPath, profileId: profile.profileId, suppressReceive: false });
        assert.equal(typeof broker.engineVersion, 'string'); assert(child && !childClosed);
        await assert.rejects(acquireMacProfileLease({ rootPath: profile.rootPath, profileId: profile.profileId, browser: 'edge' }),
            { code: 'X_CHROME_MAC_LEASE_BUSY' });
        assert.equal(child.kill('SIGTERM'), true);
        assert.equal(await broker.releaseComplete, true); assert.equal(childClosed, true);
    });
