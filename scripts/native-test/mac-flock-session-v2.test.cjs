'use strict';
// Research-only lifecycle fixtures; never loaded by the setup app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');

test('research v2 tracks environment ownership and detects a replaced directory',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_FLOCK_RESEARCH !== '1', timeout: 30000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-flock-v2-')); let worker, exited = false, addon, copy;
        t.after(async () => {
            if (worker && !exited) {
                let timer; const stopped = await Promise.race([worker.terminate().then(() => true, () => false),
                    new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]); clearTimeout(timer);
                assert.ok(stopped, 'fixture retained because worker termination was not confirmed');
            }
            let safe = true;
            for (const instance of [copy, addon]) if (instance) {
                try { if (instance.status() === 'HELD' && instance.release() !== 'OK') safe = false;
                    if (instance.status() !== 'NONE') safe = false; } catch { safe = false; }
            }
            assert.equal(safe, true, 'fixture retained because lock release is uncertain');
            const real = await fs.realpath(base); assert.ok(path.dirname(real) === parent && /^cbte-flock-v2-/.test(path.basename(real)), 'fixture root changed');
            await fs.rm(real, { recursive: true });
        });
        const filename = process.env.CBTE_MAC_FLOCK_V2_ADDON; assert.ok(path.isAbsolute(filename || ''), 'fixture addon unavailable');
        const stat = await fs.lstat(base); assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
            && (stat.mode & 0o777) === 0o700 && await fs.realpath(base) === base, 'fixture root invalid');
        await fs.writeFile(path.join(base, 'session.lock'), '', { flag: 'wx', mode: 0o600 }); addon = require(filename);
        assert.equal(addon.acquire(base), 'OK'); assert.equal(addon.acquire(base), 'BUSY');
        const copyPath = path.join(base, 'fixture-addon-copy.node'); await fs.copyFile(filename, copyPath, constants.COPYFILE_EXCL);
        copy = require(copyPath); assert.equal(copy.status(), 'NONE', 'fixture addon instances were not independent');
        assert.equal(copy.acquire(base), 'BUSY');
        assert.equal(addon.begin(), 'OK'); assert.equal(addon.begin(), 'BUSY'); assert.equal(addon.release(), 'BUSY'); assert.equal(addon.end(), 'OK');
        function newWorker(code) {
            exited = false; worker = new Worker(code, { eval: true, workerData: { addon: filename, base } });
            const message = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
            const done = new Promise(resolve => worker.once('exit', () => { exited = true; resolve(); }));
            return { message, done };
        }
        async function within(promise) {
            let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timed out')), 5000); })]); }
            finally { clearTimeout(timer); }
        }
        const script = `const {parentPort,workerData}=require('node:worker_threads');const a=require(workerData.addon);parentPort.postMessage(a.acquire(workerData.base));`;
        let w = newWorker(script); assert.equal(await within(w.message), 'BUSY'); await within(w.done); assert.equal(addon.release(), 'OK');
        w = newWorker(script); assert.equal(await within(w.message), 'OK'); await within(w.done);
        assert.equal(addon.acquire(base), 'OK', 'worker environment did not release a quiescent lock'); assert.equal(addon.release(), 'OK');
        const activeWorker = `const {Worker}=require('node:worker_threads'),{spawnSync}=require('node:child_process'),a=require(process.argv[1]),p=process.argv[2];const code="const {workerData}=require('node:worker_threads');const x=require(workerData.addon);if(x.acquire(workerData.base)!=='OK'||x.begin()!=='OK')process.exitCode=2";const w=new Worker(code,{eval:true,workerData:{addon:process.argv[1],base:p}});w.on('exit',c=>{const probe="const a=require(process.argv[1]);process.stdout.write(a.acquire(process.argv[2]))";const r=spawnSync(process.execPath,['-e',probe,process.argv[1],p],{encoding:'utf8',timeout:5000});process.stdout.write(c===0&&a.status()==='INVALID'&&r.status===0&&r.stdout==='BUSY'?'POISONED':'UNEXPECTED')});`;
        const active = spawnSync(process.execPath, ['-e', activeWorker, filename, base], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
        assert.equal(active.status, 0, 'fixture active worker process failed'); assert.equal(active.stdout, 'POISONED');
        assert.equal(addon.acquire(base), 'OK'); assert.equal(addon.release(), 'OK');
        t.diagnostic('synthetic v2: active worker teardown retained a poisoned lock until process exit');
        const isolated = path.join(base, 'owned'); await fs.mkdir(isolated, { mode: 0o700 });
        await fs.writeFile(path.join(isolated, 'session.lock'), '', { flag: 'wx', mode: 0o600 });
        const replace = `const fs=require('node:fs'),path=require('node:path'),a=require(process.argv[1]),p=process.argv[2];if(a.acquire(p)!=='OK')process.exit(2);fs.renameSync(p,p+'-moved');fs.mkdirSync(p,{mode:0o700});fs.writeFileSync(path.join(p,'session.lock'),'',{flag:'wx',mode:0o600});process.stdout.write(a.begin()==='INVALID'?'DETECTED':'UNEXPECTED');`;
        const child = spawnSync(process.execPath, ['-e', replace, filename, isolated], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        assert.equal(child.status, 0, 'fixture replacement process failed'); assert.equal(child.stdout, 'DETECTED');
        t.diagnostic('synthetic v2: quiescent worker cleanup, same-process contention and directory replacement detection verified');
    });
