'use strict';

// CI-only: signed installed Chrome, a newly created profile and a loopback
// page. No normal profile, X account, subscription or user data is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { verifyInstalledChrome } = require('../../src/automation/chrome-mac-broker');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');

test('signed macOS Chrome opens a dedicated synthetic profile over its private pipe',
    { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
        const temp = await fs.realpath(os.tmpdir());
        const base = await fs.mkdtemp(path.join(temp, 'cbte-mac-chrome-hosted-'));
        let child, closed = false, broker, cleanupSafe = true, resolveClosed;
        const closePromise = new Promise(resolve => { resolveClosed = resolve; });
        const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Test</title>'); });
        t.after(async () => {
            if (child && !closed) {
                try { child.kill('SIGTERM'); } catch { /* Preserve the profile if shutdown cannot be confirmed. */ }
                let timer;
                const stopped = await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
                clearTimeout(timer); cleanupSafe = stopped;
            }
            if (broker) await broker.stop();
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
        const profile = await createMacChromeProfile(base), executable = await verifyInstalledChrome();
        const spawnOwned = (file, args, options) => {
            child = spawn(file, args, options);
            child.once('close', () => { closed = true; resolveClosed(); });
            return child;
        };
        broker = await startChromeBroker({ chromePath: executable, profilePath: profile.profilePath, origin,
            extraArgs: ['--headless=new', '--disable-background-networking', '--disable-sync', '--no-proxy-server'], spawnChrome: spawnOwned });
        assert.match(broker.engineVersion, /^\d+\.\d+\.\d+\.\d+$/);
        assert.equal(broker.chrome, child);
        assert.equal(await verifyInstalledChrome(), executable);
    });
