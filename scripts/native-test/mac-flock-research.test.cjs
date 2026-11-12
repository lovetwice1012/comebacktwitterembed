'use strict';
// Disposable hosted Mac research only; this addon is not part of the product.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');

test('research addon owns an advisory lock in the Node process',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_FLOCK_RESEARCH !== '1', timeout: 30000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-flock-research-'));
        const addonPath = process.env.CBTE_MAC_FLOCK_ADDON; let addon, holder, worker, workerExited;
        async function waitClosed(child) {
            let timer; const closed = await Promise.race([child.fixtureClosed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
            clearTimeout(timer); return closed;
        }
        async function within(promise) {
            let timer;
            try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timed out')), 5000); })]); }
            finally { clearTimeout(timer); }
        }
        t.after(async () => {
            try {
                if (worker && !workerExited) {
                    let timer; const exited = await Promise.race([worker.terminate().then(() => true, () => false),
                        new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
                    clearTimeout(timer); assert.ok(exited, 'fixture retained because worker termination is uncertain');
                }
                if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
                if (holder) {
                    const closed = await waitClosed(holder);
                    assert.ok(closed && holder.pid && await waitForMacProcessGroupExit(holder.pid), 'fixture retained because owner termination is uncertain');
                }
            } finally {
                if (addon && addon.inspect().fixtureFd >= 0)
                    assert.equal(addon.release(), 'OK', 'fixture retained because lock release is uncertain');
                if (addon) assert.equal(addon.inspect().uncertain, false, 'fixture retained because lock release is uncertain');
            }
            const real = await fs.realpath(base); assert.ok(path.dirname(real) === temp && /^cbte-flock-research-/.test(path.basename(real)), 'fixture path changed');
            await fs.rm(real, { recursive: true });
        });
        assert.ok(path.isAbsolute(addonPath || ''), 'fixture addon unavailable'); addon = require(addonPath);
        const baseStat = await fs.lstat(base);
        assert.ok(baseStat.isDirectory() && !baseStat.isSymbolicLink() && baseStat.uid === process.getuid()
            && (baseStat.mode & 0o777) === 0o700 && await fs.realpath(base) === base, 'fixture directory invalid');
        const file = path.join(base, 'session.lock'); await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
        const link = path.join(base, 'link'); await fs.symlink(file, link);
        assert.equal(addon.acquire(link), 'INVALID');
        const hard = path.join(base, 'hard'); await fs.link(file, hard); assert.equal(addon.acquire(file), 'INVALID'); await fs.unlink(hard);
        await fs.chmod(file, 0o644); assert.equal(addon.acquire(file), 'INVALID'); await fs.chmod(file, 0o600);
        assert.equal(addon.acquire(file), 'OK'); assert.equal(addon.acquire(file), 'BUSY');
        const details = addon.inspect(); assert.equal(details.cloexec, true);
        function run(code, args) {
            const p = spawnSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
            assert.equal(p.status, 0, 'fixture subprocess failed'); return p.stdout;
        }
        const contender = `const a=require(process.argv[1]); const r=a.acquire(process.argv[2]); process.stdout.write(r); if(r==='OK')a.release();`;
        const contenderArgs = [addonPath, file]; assert.equal(run(contender, contenderArgs), 'BUSY');
        const alias = await fs.open(file, 'r'); await alias.close(); assert.equal(run(contender, contenderArgs), 'BUSY');
        const inheritance = `const fs=require('node:fs'); let s; try { const a=fs.fstatSync(Number(process.argv[1])),b=fs.statSync(process.argv[2]); s=a.dev===b.dev&&a.ino===b.ino?'INHERITED':'CLOSED'; } catch { s='CLOSED'; } process.stdout.write(s);`;
        assert.equal(run(inheritance, [String(details.fixtureFd), file]), 'CLOSED');
        t.diagnostic('fixture fd has CLOEXEC; Node spawn child did not observe it (spawn also filters descriptors)');
        assert.equal(addon.release(), 'OK'); assert.equal(run(contender, contenderArgs), 'OK');
        // Negative experiment: replacing the locked inode defeats a path-based lock.
        assert.equal(addon.acquire(file), 'OK'); await fs.unlink(file);
        await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
        assert.equal(run(contender, contenderArgs), 'OK'); assert.equal(addon.release(), 'OK');
        t.diagnostic('synthetic inode replacement bypassed advisory locking; production requires stronger identity protection');
        // Negative experiment: this research addon has no environment cleanup.
        const workerScript = `const {parentPort,workerData}=require('node:worker_threads'); const a=require(workerData.addon); parentPort.postMessage(a.acquire(workerData.file));`;
        worker = new Worker(workerScript, { eval: true, workerData: { addon: addonPath, file } });
        const workerResult = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
        const workerDone = new Promise(resolve => worker.once('exit', () => { workerExited = true; resolve(); }));
        assert.equal(await within(workerResult), 'OK'); await within(workerDone);
        assert.equal(run(contender, contenderArgs), 'BUSY'); assert.equal(addon.release(), 'OK');
        t.diagnostic('synthetic worker exit retained the research lock; production requires environment-aware cleanup');
        const holderScript = `const a=require(process.argv[1]); const r=a.acquire(process.argv[2]); process.stdout.write(r); if(r==='OK')process.stdin.resume();`;
        holder = spawn(process.execPath, ['-e', holderScript, addonPath, file], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
        holder.stdin.on('error', () => {}); holder.fixtureClosed = new Promise(resolve => { holder.once('close', resolve); holder.once('error', resolve); });
        let timer; const status = await Promise.race([new Promise(resolve => holder.stdout.once('data', b => resolve(b.toString('ascii')))),
            new Promise(resolve => { timer = setTimeout(() => resolve('TIMEOUT'), 5000); })]); clearTimeout(timer);
        assert.equal(status, 'OK'); assert.equal(run(contender, contenderArgs), 'BUSY');
        assert.equal(holder.kill('SIGKILL'), true); assert.equal(await waitClosed(holder), true, 'fixture owner did not close');
        assert.equal(run(contender, contenderArgs), 'OK');
        const faultAddon = process.env.CBTE_MAC_FLOCK_FAULT_ADDON; assert.ok(path.isAbsolute(faultAddon || ''), 'fixture fault addon unavailable');
        const faultScript = `const a=require(process.argv[1]),p=process.argv[2]; const ok=a.acquire(p)==='OK'&&a.failClose()==='OK'&&a.release()==='INVALID'&&a.acquire(p)==='INVALID'; process.stdout.write(ok?'EXPECTED':'UNEXPECTED');`;
        assert.equal(run(faultScript, [faultAddon, file]), 'EXPECTED');
        assert.equal(run(contender, contenderArgs), 'OK');
        t.diagnostic('synthetic injected close failure prevented reacquisition until the fixture process exited');
        t.diagnostic('synthetic in-process flock: normal, contention, separate close, child spawn and owner SIGKILL verified');
    });
