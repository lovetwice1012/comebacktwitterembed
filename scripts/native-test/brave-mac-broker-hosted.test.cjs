'use strict';

// Disposable GitHub-hosted macOS only. This exercises the real signed Brave
// broker with a synthetic profile and loopback page; no Push service or X is
// needed, and no ordinary browser profile or user Keychain is accessed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createMacBraveProfile } = require('../../src/automation/chrome-mac-profile');
const { acquireMacProfileLease } = require('../../src/automation/chrome-mac-profile-lease');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { snapshotBraveInstallation, diagnoseBraveInstallation } = require('./brave-mac-install-diagnostic.cjs');

const STANDARD_RESOLVER = '--host-resolver-rules=MAP mtalk.google.com ~NOTFOUND';
const FIXTURE_RESOLVER = '--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1';
function useLoopbackResolver(args) {
    const matches = args.filter(arg => typeof arg === 'string' && arg.startsWith('--host-resolver-rules='));
    if (matches.length !== 1 || matches[0] !== STANDARD_RESOLVER) throw new Error('FIXTURE_RESOLVER_INVALID');
    // The exception is a literal loopback address, so no external hostname
    // becomes eligible for DNS resolution. All other hostnames remain mapped
    // to NOTFOUND. This changes only the disposable fixture invocation.
    return args.map(arg => arg === STANDARD_RESOLVER ? FIXTURE_RESOLVER : arg);
}

test('fixture resolver allows only literal loopback and rejects ambiguous flags', () => {
    assert.deepEqual(useLoopbackResolver(['--headless=new', STANDARD_RESOLVER, 'http://127.0.0.1:1234/']),
        ['--headless=new', FIXTURE_RESOLVER, 'http://127.0.0.1:1234/']);
    assert.throws(() => useLoopbackResolver([]), /FIXTURE_RESOLVER_INVALID/);
    assert.throws(() => useLoopbackResolver([STANDARD_RESOLVER, '--host-resolver-rules=MAP * localhost']), /FIXTURE_RESOLVER_INVALID/);
    assert.throws(() => useLoopbackResolver(['--host-resolver-rules=MAP * localhost']), /FIXTURE_RESOLVER_INVALID/);
});

async function waitFor(value, timeoutMs) {
    let timer;
    try { return await Promise.race([value, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
}

async function lockExists(rootPath) {
    try { await fs.lstat(path.join(rootPath, 'broker.lock')); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('signed Mac Brave broker holds its isolated profile until the process group stops',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_BRAVE_LAUNCH_HOSTED !== '1', timeout: 360000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-brave-broker-hosted-'));
        let profile, server, broker, child, childClosed = false, childClose;
        t.after(async () => {
            if (child && !childClosed) try { child.kill('SIGTERM'); } catch { /* Preserve the fixture on uncertainty. */ }
            let stopped = !child;
            if (child) {
                const closed = childClosed || await waitFor(childClose.then(() => true), 20000);
                stopped = Boolean(closed && child.pid && await waitForMacProcessGroupExit(child.pid));
            }
            if (broker) {
                const released = await waitFor(broker.releaseComplete, 20000);
                stopped = stopped && released === true;
                await broker.stop().catch(() => { stopped = false; });
            }
            if (profile && stopped) {
                // The broker's failure path can release asynchronously after
                // close; do not remove its data until the owned lock is gone.
                const deadline = Date.now() + 12000;
                while (await lockExists(profile.rootPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
                if (await lockExists(profile.rootPath)) stopped = false;
            }
            if (server) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
            if (stopped) {
                const actual = await fs.realpath(base); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-brave-broker-hosted-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(stopped, true, 'synthetic profile retained because browser termination was not confirmed');
        });
        profile = await createMacBraveProfile(base);
        let visits = 0;
        server = http.createServer((request, response) => {
            if (request.method === 'GET' && request.url === '/') { visits++; response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end('<!doctype html><title>Synthetic fixture</title>'); }
            else response.writeHead(404).end();
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        // Replace only the fixture origin and offline launch flags in memory.
        // The actual broker, signer, lease and process lifecycle stay intact.
        const privatePath = require.resolve('../../src/automation/chrome-private-broker');
        const brokerPath = require.resolve('../../src/automation/brave-mac-broker');
        const privateModule = require.cache[privatePath] || (require(privatePath), require.cache[privatePath]);
        const previousPrivate = privateModule.exports, previousBroker = require.cache[brokerPath];
        const before = await snapshotBraveInstallation();
        try {
            privateModule.exports = { ...previousPrivate, startChromeBroker: options => previousPrivate.startChromeBroker({ ...options, origin,
                extraArgs: ['--headless=new', '--disable-background-networking', '--no-proxy-server'],
                spawnChrome(executable, args, spawnOptions) {
                    assert.equal(executable, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
                    assert(args.includes(`--user-data-dir=${profile.profilePath}`)); assert.equal(args.at(-1), `${origin}/`);
                    child = options.spawnChrome(executable, useLoopbackResolver(args), spawnOptions);
                    childClose = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
                    return child;
                } }) };
            delete require.cache[brokerPath];
            const { startMacBraveBroker } = require(brokerPath);
            try { broker = await startMacBraveBroker({ rootPath: profile.rootPath, profileId: profile.profileId }); }
            catch (error) { await diagnoseBraveInstallation(t, before); throw error; }
            assert.equal(broker.pushChannelStatus, 'enabled'); assert(child && child.pid && !childClosed);
            const visitDeadline = Date.now() + 15000;
            while (!visits && Date.now() < visitDeadline) await new Promise(resolve => setTimeout(resolve, 100));
            assert(visits > 0, 'synthetic loopback page was not visited');
            await assert.rejects(acquireMacProfileLease({ rootPath: profile.rootPath, profileId: profile.profileId, browser: 'brave' }),
                { code: 'X_CHROME_MAC_LEASE_BUSY' });
            await broker.closeBrowser();
            assert.equal(await waitFor(broker.releaseComplete, 20000), true);
            assert.equal(childClosed, true); assert.equal(await waitForMacProcessGroupExit(child.pid), true);
            assert.equal(await lockExists(profile.rootPath), false);
            t.diagnostic('signed Brave launched with a synthetic loopback profile and released its lease after group shutdown');
        } finally {
            privateModule.exports = previousPrivate;
            if (previousBroker) require.cache[brokerPath] = previousBroker; else delete require.cache[brokerPath];
        }
    });
