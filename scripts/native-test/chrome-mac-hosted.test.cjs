'use strict';

// CI-only: signed installed Chrome, a newly created profile and a loopback
// page. No normal profile, X account, subscription or user data is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { verifyInstalledChrome } = require('../../src/automation/chrome-mac-broker');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { describeInstalledChrome } = require('./chrome-mac-install-diagnostic.cjs');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('signed macOS Chrome opens a dedicated synthetic profile over its private pipe',
    { skip: process.platform !== 'darwin', timeout: 400000 }, async t => {
        const temp = await fs.realpath(os.tmpdir());
        const base = await fs.mkdtemp(path.join(temp, 'cbte-mac-chrome-hosted-'));
        let child, closed = false, broker, cleanupSafe = true, resolveClosed;
        const closePromise = new Promise(resolve => { resolveClosed = resolve; });
        const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Test</title>'); });
        t.after(async () => {
            if (broker && child && !closed) await broker.closeBrowser().catch(() => {});
            if (child && !closed) {
                try { child.kill('SIGTERM'); } catch { /* Preserve the profile if shutdown cannot be confirmed. */ }
                let timer;
                const stopped = await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
                clearTimeout(timer); cleanupSafe = stopped;
            }
            if (child?.pid && cleanupSafe) cleanupSafe = await waitForMacProcessGroupExit(child.pid);
            if (broker) await broker.stop();
            await describeInstalledChrome(t, 'after launch');
            server.closeAllConnections();
            if (server.listening) await new Promise(resolve => server.close(resolve));
            if (cleanupSafe) {
                const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
                assert.match(path.basename(real), /^cbte-mac-chrome-hosted-/); await fs.rm(real, { recursive: true });
            }
            assert.equal(cleanupSafe, true, 'browser shutdown was not confirmed; synthetic profile retained');
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const profile = await createMacChromeProfile(base);
        const beforeVerification = await describeInstalledChrome(t, 'before launch');
        let executable;
        try { executable = await verifyInstalledChrome(); }
        catch (error) {
            const app = '/Applications/Google Chrome.app', binary = path.join(app, 'Contents/MacOS/Google Chrome');
            const afterFailure = await describeInstalledChrome(t, 'after initial signature failure');
            t.diagnostic(`framework Current changed across failed verification=${beforeVerification && afterFailure ? beforeVerification.current !== afterFailure.current : 'unknown'}`);
            for (const filename of [app, binary]) {
                try { const stat = await fs.lstat(filename); t.diagnostic(`installed ${path.basename(filename)}: directory=${stat.isDirectory()} file=${stat.isFile()} link=${stat.isSymbolicLink()} canonical=${await fs.realpath(filename) === filename}`); }
                catch (reason) { t.diagnostic(`installed ${path.basename(filename)}: ${reason.code}`); }
            }
            const check = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"', app],
                { encoding: 'utf8', timeout: 120000 });
            t.diagnostic(`codesign status=${check.status} signal=${check.signal} error=${check.error?.code || 'none'} stderr=${(check.stderr || '').slice(0, 2048)}`);
            // Diagnosis only: retain the original failure even if a later
            // strict verification succeeds. This checks whether the bundle
            // was changing, without mutating it or relaxing signature rules.
            await new Promise(resolve => setTimeout(resolve, 3000));
            const beforeRecheck = await describeInstalledChrome(t, 'before settled signature recheck');
            const recheck = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"', app],
                { encoding: 'utf8', timeout: 120000 });
            const afterRecheck = await describeInstalledChrome(t, 'after settled signature recheck');
            t.diagnostic(`settled strict signature status=${recheck.status === 0 ? 'valid' : recheck.status === null ? 'unknown' : 'invalid'} frameworkUnchanged=${beforeRecheck && afterRecheck ? beforeRecheck.current === afterRecheck.current && beforeRecheck.hash === afterRecheck.hash : 'unknown'}`);
            throw error;
        }
        const spawnOwned = (file, args, options) => {
            child = spawn(file, args, { ...options, detached: true });
            child.once('close', () => { closed = true; resolveClosed(); });
            return child;
        };
        broker = await startChromeBroker({ chromePath: executable, profilePath: profile.profilePath, origin, pipeTimeoutMs: 30000,
            extraArgs: ['--headless=new', '--disable-background-networking', '--disable-sync', '--no-proxy-server'], spawnChrome: spawnOwned });
        assert.match(broker.engineVersion, /^\d+\.\d+\.\d+\.\d+$/);
        assert.equal(broker.chrome, child);
        assert.equal(await verifyInstalledChrome(), executable);
    });
