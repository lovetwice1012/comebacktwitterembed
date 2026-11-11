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
const { spawn, spawnSync } = require('node:child_process');
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
            if (name === './edge-private-broker') {
                const original = local(name);
                return { ...original, async startChromeBroker(options) {
                    try { return await original.startChromeBroker(options); }
                    catch (error) {
                        const code = /^X_CHROME_(?:PIPE|BROKER|CAPTURE)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'OTHER';
                        t.diagnostic(`synthetic broker failure code=${code}`); throw error;
                    }
                } };
            }
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
        try { broker = await mod.exports.startMacEdgeBroker({ rootPath: profile.rootPath, profileId: profile.profileId, suppressReceive: false }); }
        catch (error) {
            const app = '/Applications/Microsoft Edge.app', executable = path.join(app, 'Contents/MacOS/Microsoft Edge');
            for (const filename of [app, executable]) {
                try { const stat = await fs.lstat(filename); t.diagnostic(`installed ${path.basename(filename)}: directory=${stat.isDirectory()} file=${stat.isFile()} link=${stat.isSymbolicLink()} canonical=${await fs.realpath(filename) === filename}`); }
                catch (reason) { t.diagnostic(`installed ${path.basename(filename)}: ${reason.code}`); }
            }
            const requirement = '=anchor apple generic and identifier "com.microsoft.edgemac" and certificate leaf[subject.OU] = "UBF8T346G9"';
            const check = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, app], { encoding: 'utf8', timeout: 120000 });
            const diagnostic = /resource fork|Finder information|unsealed contents/i.test(check.stderr || '') ? 'resource-metadata'
                : /not signed|signature|invalid/i.test(check.stderr || '') ? 'signature' : 'other';
            t.diagnostic(`signature check status=${check.status} signal=${check.signal || 'none'} class=${check.status === 0 ? 'ok' : diagnostic}`);
            const info = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8', timeout: 30000 });
            const identifier = /^Identifier=(.+)$/m.exec(info.stderr || '')?.[1], team = /^TeamIdentifier=(.+)$/m.exec(info.stderr || '')?.[1];
            t.diagnostic(`signature identity expectedIdentifier=${identifier === 'com.microsoft.edgemac'} expectedTeam=${team === 'UBF8T346G9'}`);
            throw error;
        }
        assert.equal(typeof broker.engineVersion, 'string'); assert(child && !childClosed);
        await assert.rejects(acquireMacProfileLease({ rootPath: profile.rootPath, profileId: profile.profileId, browser: 'edge' }),
            { code: 'X_CHROME_MAC_LEASE_BUSY' });
        assert.equal(child.kill('SIGTERM'), true);
        assert.equal(await broker.releaseComplete, true); assert.equal(childClosed, true);
    });
