'use strict';
// Research only: no product profile, browser, network or credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('an advisory lock survives a stale file and is released after holder termination',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_EDGE_HOSTED !== '1', timeout: 45000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-edge-advisory-test-'));
        const children = new Set(); let holderStarted = false, holder, cleanupProbe, cleanupUncertain = false;
        t.after(async () => {
            for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            let timer; const allClosed = await Promise.race([Promise.all([...children].map(child => child.closed)).then(() => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
            clearTimeout(timer);
            if (!allClosed) throw new Error('fixture retained because child termination was not confirmed');
            if (holderStarted) {
                let result = 'B';
                for (let attempt = 0; attempt < 30 && result === 'B'; attempt++) {
                    result = await cleanupProbe(); if (result === 'B') await new Promise(resolve => setTimeout(resolve, 100));
                }
                assert.equal(result, 'R', 'fixture retained because lock release was not confirmed');
                assert.ok(holder?.pid && await waitForMacProcessGroupExit(holder.pid), 'fixture retained because the owned process group remains');
            }
            assert.equal(cleanupUncertain, false, 'fixture retained because probe termination was uncertain');
            const real = await fs.realpath(base); assert.ok(path.dirname(real) === parent && /^cbte-edge-advisory-test-/.test(path.basename(real)), 'fixture root changed');
            await fs.rm(real, { recursive: true });
        });
        const helper = process.env.MAC_LOCK_HELPER;
        assert.ok(path.isAbsolute(helper || ''), 'fixture helper missing');
        const lock = path.join(base, 'session.lock'); await fs.writeFile(lock, '', { flag: 'wx', mode: 0o600 });
        function track(child) {
            child.closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
            children.add(child); return child;
        }
        function status(child) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('fixture lock timeout')), 5000);
                child.stdout.once('data', chunk => { clearTimeout(timeout); const value = chunk.toString('ascii');
                    resolve(['R', 'B', 'E'].includes(value) ? value : 'unknown'); });
                child.once('error', () => { clearTimeout(timeout); reject(new Error('fixture process failed')); });
                child.once('close', () => { clearTimeout(timeout); resolve('closed'); });
            });
        }
        async function probe() {
            const child = track(spawn(helper, [lock], { stdio: ['pipe', 'pipe', 'ignore'] }));
            child.stdin.on('error', () => {});
            try { return await status(child); }
            finally {
                child.stdin.end();
                async function closedWithin() {
                    let timer; const closed = await Promise.race([child.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
                    clearTimeout(timer); return closed;
                }
                if (!await closedWithin()) {
                    cleanupUncertain = true;
                    child.kill('SIGKILL');
                    if (!await closedWithin()) throw new Error('fixture probe termination uncertain');
                    throw new Error('fixture probe required termination');
                }
            }
        }
        cleanupProbe = probe;
        // A file left from a prior run must not itself be treated as a lock.
        assert.equal(await probe(), 'R');
        const holderSource = `const {spawn}=require('node:child_process'); const child=spawn(process.argv[1],[process.argv[2]],{stdio:['pipe','pipe','ignore']}); child.stdout.on('data', b=>process.stdout.write(b)); child.on('error',()=>process.stdout.write('E'));`;
        holderStarted = true;
        holder = track(spawn(process.execPath, ['-e', holderSource, helper, lock], { stdio: ['ignore', 'pipe', 'ignore'], detached: true }));
        assert.equal(await status(holder), 'R'); assert.equal(await probe(), 'B');
        assert.equal(holder.kill('SIGKILL'), true); await holder.closed;
        let result = 'B';
        for (let attempt = 0; attempt < 30 && result === 'B'; attempt++) {
            result = await probe(); if (result === 'B') await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(result, 'R');
        t.diagnostic('synthetic advisory lock: stale file, contention, owner termination and reacquisition verified');
    });
