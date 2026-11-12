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
const { spawnSync } = require('node:child_process');
const { constants } = require('node:fs');
const { classifyName, plausibleHeader } = require('./edge-mac-store-classifier.cjs');
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
        let inspectStatus = 'not_called', inspectPhase = 'not_called', recordCount = 0;
        const openPath = path.resolve(__dirname, '../../src/automation/edge-mac-open.js'), openRequire = createRequire(openPath), openModule = { exports: {} };
        vm.runInNewContext(await fs.readFile(openPath, 'utf8'), { module: openModule, exports: openModule.exports, process, Buffer, Promise,
            require(name) {
                if (name === './edge-mac-broker') return brokerModule.exports;
                if (name === './edge-wns-snapshot-io') {
                    const original = openRequire(name);
                    return { ...original, async inspectEdgeSnapshot(options) {
                        inspectPhase = 'before_db';
                        const dbFactory = directory => {
                            inspectPhase = 'factory'; const db = options.dbFactory(directory);
                            return {
                                async open() { inspectPhase = 'opening'; await db.open(); inspectPhase = 'opened'; },
                                async *iterator(iteratorOptions) {
                                    inspectPhase = 'iterating';
                                    for await (const value of db.iterator(iteratorOptions)) { recordCount = Math.min(129, recordCount + 1); yield value; }
                                    inspectPhase = 'scanned';
                                },
                                async close() { return db.close(); },
                            };
                        };
                        try { const result = await original.inspectEdgeSnapshot({ ...options, dbFactory }); inspectStatus = 'success'; return result; }
                        catch { inspectStatus = 'failed'; throw Object.assign(new Error('fixture inspection failed'), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' }); }
                    } };
                }
                return openRequire(name);
            } });
        const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath, expectedSha256 };
        const first = await openModule.exports.openMacEdgeForSetup(args); brokers.push(first);
        assert.equal(first.chrome.kill('SIGTERM'), true); assert.equal(await first.releaseComplete, true); await first.stop();
        async function verifyFixtureDirectories(directories) {
            for (const directory of directories) {
                const info = await fs.lstat(directory);
                if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
                    || await fs.realpath(directory) !== directory) throw new Error('fixture path changed');
            }
        }
        const parents = [base, profile.rootPath, profile.profilePath, path.join(profile.profilePath, 'Default')];
        await verifyFixtureDirectories(parents.slice(0, 3));
        assert.ok((await fs.readdir(profile.profilePath)).length > 0, 'first launch did not populate the synthetic profile');
        const store = path.join(profile.profilePath, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
        let storeState = 'unavailable';
        try { await verifyFixtureDirectories([...parents, store]); storeState = 'present'; }
        catch (error) { if (error.code === 'ENOENT') storeState = 'missing'; }
        t.diagnostic(`synthetic cancelled profile Push store=${storeState}`);
        let second;
        try { second = await openModule.exports.openMacEdgeForSetup(args); }
        catch (error) {
            const known = new Set(['X_EDGE_MAC_PROFILE_INSPECTION_REQUIRED', 'X_CHROME_MAC_LOCK_FAILED', 'X_CHROME_MAC_LOCK_BUSY', 'X_CHROME_MAC_LOCK_INVALID',
                'X_CHROME_MAC_LOCK_LOST', 'X_CHROME_MAC_SNAPSHOT_INVALID', 'X_CHROME_MAC_SNAPSHOT_CLEANUP_FAILED',
                'X_EDGE_MAC_BROKER_INVALID', 'X_EDGE_MAC_BROKER_BUSY', 'X_EDGE_MAC_BROKER_CLEANUP_PENDING']);
            const code = known.has(error?.code) ? error.code : 'OTHER';
            let lockState = 'unknown', helperState = 'not_run', filesScanned = false; const lockPath = path.join(store, 'LOCK');
            const counts = { lock: 0, current: 0, manifest: 0, diagnosticLog: 0, journal: 0, table: 0, other: 0 };
            const sizes = { current: 0, diagnosticLog: 0, journal: 0 };
            const headers = { current: 'not_present', diagnosticLog: 'not_present', journal: 'not_present' };
            try {
                await verifyFixtureDirectories([...parents, store]);
                const entries = await fs.readdir(store, { withFileTypes: true });
                if (entries.length > 256) throw new Error('fixture store too large');
                for (const entry of entries) {
                    const kind = classifyName(entry.name, entry.isFile() && !entry.isSymbolicLink());
                    counts[kind]++;
                    if (!Object.hasOwn(sizes, kind)) continue;
                    await verifyFixtureDirectories([...parents, store]);
                    const file = path.join(store, entry.name), before = await fs.lstat(file);
                    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.nlink !== 1
                        || !Number.isSafeInteger(before.size) || before.size > 64 * 1024 * 1024) throw new Error('fixture file changed');
                    sizes[kind] += before.size;
                    if (sizes[kind] > 128 * 1024 * 1024) throw new Error('fixture size exceeded');
                    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
                    const prefix = Buffer.alloc(Math.min(before.size, 128));
                    try {
                        const opened = await handle.stat();
                        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
                            || opened.uid !== before.uid || opened.nlink !== 1) throw new Error('fixture file changed');
                        const read = await handle.read(prefix, 0, prefix.length, 0);
                        const after = await handle.stat();
                        if (read.bytesRead !== prefix.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
                            throw new Error('fixture file changed');
                        const result = plausibleHeader(kind, prefix, before.size);
                        if (headers[kind] === 'not_present') headers[kind] = result;
                        else if (headers[kind] !== result) headers[kind] = 'mixed';
                    } finally { prefix.fill(0); await handle.close(); }
                }
                filesScanned = true;
                const lock = await fs.lstat(lockPath);
                lockState = lock.isFile() && !lock.isSymbolicLink() && lock.uid === process.getuid() && lock.nlink === 1 ? 'owned_file' : 'unsafe';
                if (lockState === 'owned_file') {
                    // Probe only the fixture's lock. Output is reduced to the
                    // helper's fixed single-character status and never logs a path.
                    const helper = await fs.lstat(helperPath), current = await fs.lstat(lockPath);
                    if (!helper.isFile() || helper.isSymbolicLink() || ![0, process.getuid()].includes(helper.uid)
                        || helper.nlink !== 1 || (helper.mode & 0o022) || !(helper.mode & 0o111)
                        || await fs.realpath(helperPath) !== helperPath || createHash('sha256').update(await fs.readFile(helperPath)).digest('hex') !== expectedSha256
                        || current.isSymbolicLink() || current.dev !== lock.dev || current.ino !== lock.ino
                        || current.uid !== lock.uid || current.nlink !== 1) throw new Error('fixture identity changed');
                    await verifyFixtureDirectories([...parents, store]);
                    const probe = spawnSync(helperPath, [lockPath], { input: '', timeout: 5000, encoding: 'ascii', stdio: ['pipe', 'pipe', 'ignore'] });
                    helperState = ['R', 'B', 'E'].includes(probe.stdout) ? probe.stdout : 'unknown';
                }
            } catch (reason) { lockState = reason?.code === 'ENOENT' ? 'missing' : 'unknown'; }
            const files = filesScanned ? `filesScan=complete filesLock=${counts.lock} filesCurrent=${counts.current} filesManifest=${counts.manifest} filesDiagnosticLog=${counts.diagnosticLog} filesJournal=${counts.journal} filesTable=${counts.table} filesOther=${counts.other} currentBytes=${sizes.current} diagnosticLogBytes=${sizes.diagnosticLog} journalBytes=${sizes.journal} currentHeader=${headers.current} diagnosticLogHeader=${headers.diagnosticLog} journalHeader=${headers.journal}`
                : 'filesScan=unavailable';
            const records = inspectPhase === 'scanned' ? String(recordCount) : 'unavailable';
            t.diagnostic(`synthetic reopen failure code=${code} lock=${lockState} helper=${helperState} reader=${inspectStatus} phase=${inspectPhase} records=${records} ${files}`);
            throw new Error('FIXTURE_EDGE_REOPEN_FAILED');
        }
        brokers.push(second); assert.equal(second.chrome.kill('SIGTERM'), true);
        assert.equal(await second.releaseComplete, true); await second.stop();
        t.diagnostic('synthetic cancelled profile reopened and both owned browsers stopped');
    });
