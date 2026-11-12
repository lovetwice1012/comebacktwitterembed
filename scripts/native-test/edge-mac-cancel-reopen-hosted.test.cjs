'use strict';

// Disposable hosted Mac only. Both launches use a new tool-owned profile and
// a loopback page; X and the user's ordinary browser profile are never used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { createMacEdgeProfile } = require('../../src/automation/chrome-mac-profile');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('a fresh Edge setup cancelled before notifications can be reopened',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1', timeout: 300000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-edge-cancel-reopen-'));
        const children = [], brokers = []; let server, listening = false;
        t.after(async () => {
            for (const broker of brokers) {
                if (broker.chrome.exitCode === null && broker.chrome.signalCode === null) { try { broker.chrome.kill('SIGTERM'); } catch {} }
                await broker.stop().catch(() => {});
            }
            let safe = true;
            for (const child of children) {
                if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGTERM'); } catch {} }
                let timer;
                const closed = await Promise.race([child.fixtureClosed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
                clearTimeout(timer); if (!closed || !child.pid || !await waitForMacProcessGroupExit(child.pid)) safe = false;
            }
            if (server && listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            if (safe) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-edge-cancel-reopen-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(safe, true, 'fixture retained because Edge termination could not be confirmed');
        });
        const profile = await createMacEdgeProfile(base);
        server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Fixture</title>'));
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { listening = true; resolve(); }); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const helperPath = process.env.MAC_LOCK_HELPER;
        assert.ok(path.isAbsolute(helperPath || ''));
        const expectedSha256 = createHash('sha256').update(await fs.readFile(helperPath)).digest('hex');
        const brokerPath = path.resolve(__dirname, '../../src/automation/edge-mac-broker.js'), brokerRequire = createRequire(brokerPath);
        const brokerModule = { exports: {} };
        vm.runInNewContext(await fs.readFile(brokerPath, 'utf8'), { module: brokerModule, exports: brokerModule.exports, process, Buffer, Promise,
            require(name) {
                if (name !== './edge-private-broker') return brokerRequire(name);
                const original = brokerRequire(name);
                return { ...original, startChromeBroker: options => original.startChromeBroker({ ...options, origin,
                    extraArgs: ['--headless=new', '--no-proxy-server'], spawnChrome(file, args, spawnOptions) {
                        const child = options.spawnChrome(file, args, spawnOptions);
                        child.fixtureClosed = new Promise(resolve => child.once('close', resolve)); children.push(child); return child;
                    } }) };
            } });
        const openPath = path.resolve(__dirname, '../../src/automation/edge-mac-open.js'), openRequire = createRequire(openPath), openModule = { exports: {} };
        vm.runInNewContext(await fs.readFile(openPath, 'utf8'), { module: openModule, exports: openModule.exports, process, Buffer, Promise,
            require(name) { return name === './edge-mac-broker' ? brokerModule.exports : openRequire(name); } });
        const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath, expectedSha256 };
        const first = await openModule.exports.openMacEdgeForSetup(args); brokers.push(first);
        assert.equal(first.chrome.kill('SIGTERM'), true); assert.equal(await first.releaseComplete, true); await first.stop();
        assert.ok((await fs.readdir(profile.profilePath)).length > 0, 'first launch did not populate the synthetic profile');
        const store = path.join(profile.profilePath, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
        let storePresent = false;
        try { const info = await fs.lstat(store); storePresent = info.isDirectory() && !info.isSymbolicLink(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        t.diagnostic(`synthetic cancelled profile has Push store=${storePresent}`);
        let second;
        try { second = await openModule.exports.openMacEdgeForSetup(args); }
        catch (error) {
            const code = /^X_[A-Z_]+$/.test(error?.code || '') ? error.code : 'OTHER';
            t.diagnostic(`synthetic reopen failure code=${code}`); throw new Error('FIXTURE_EDGE_REOPEN_FAILED');
        }
        brokers.push(second); assert.equal(second.chrome.kill('SIGTERM'), true);
        assert.equal(await second.releaseComplete, true); await second.stop();
        t.diagnostic('synthetic cancelled profile reopened and both owned browsers stopped');
    });
