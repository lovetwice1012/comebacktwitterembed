'use strict';

// Hosted macOS only: synthetic profiles and about:blank. No X account,
// ordinary Chrome profile, notification credential, or upload is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { verifyInstalledChrome } = require('../../src/automation/chrome-mac-broker');
const { createChromePipe } = require('../../src/automation/chrome-cdp-pipe');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { describeSyntheticGroup } = require('./chrome-mac-group-diagnostic.cjs');

test('graceful Chrome shutdown releases each synthetic process group',
    { skip: process.platform !== 'darwin', timeout: 240000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-chrome-group-'));
        const children = []; let safe = true;
        t.after(async () => {
            for (const item of children) {
                if (!item.closed && item.child.exitCode === null && item.child.signalCode === null) {
                    try { item.child.kill('SIGTERM'); } catch { /* Keep the profile if termination is uncertain. */ }
                }
                let timer;
                const closed = item.closed || await Promise.race([item.done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
                clearTimeout(timer);
                const gone = closed && item.child.pid && await waitForMacProcessGroupExit(item.child.pid);
                if (!gone) { safe = false; if (item.child.pid) await describeSyntheticGroup(t, item.child.pid, 'shutdown'); }
            }
            if (safe) { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
                assert.match(path.basename(real), /^cbte-chrome-group-/); await fs.rm(real, { recursive: true }); }
            assert.equal(safe, true, 'synthetic Chrome termination unconfirmed; profiles retained');
        });
        const executable = await verifyInstalledChrome();
        for (let i = 0; i < 3; i++) {
            const profile = path.join(root, `profile-${i}`); await fs.mkdir(profile, { mode: 0o700 });
            const child = spawn(executable, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
                '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', 'about:blank'],
            { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
            const item = { child, closed: false, done: null };
            item.done = new Promise(resolve => { child.once('close', () => { item.closed = true; resolve(); }); });
            child.once('error', () => {}); children.push(item);
            const pipe = createChromePipe(child, { timeoutMs: 30000 });
            await pipe.ready();
            await pipe.closeBrowser();
            let timer;
            const closed = item.closed || await Promise.race([item.done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer); assert.equal(closed, true, 'direct synthetic browser did not close');
            const started = Date.now(), gone = await waitForMacProcessGroupExit(child.pid);
            t.diagnostic(`synthetic graceful shutdown ${i + 1}: groupGone=${gone} elapsedMs=${Date.now() - started}`);
            if (!gone) await describeSyntheticGroup(t, child.pid, 'graceful Chrome');
            assert.equal(gone, true, 'synthetic browser group remained');
        }
    });
