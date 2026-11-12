'use strict';

// CI-only preview inspection. It does not launch a browser, inspect existing
// profiles, or upload anything. The second test opens a synthetic dialog.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const { describeSyntheticGroup } = require('./chrome-mac-group-diagnostic.cjs');
const { promisify } = require('node:util');
const exec = promisify(execFile);

test('unpacked macOS preview loads bundled runtime, application and LevelDB',
    { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
        assert.ok(path.isAbsolute(process.env.MAC_PREVIEW_ZIP || ''), 'missing synthetic preview');
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-preview-hosted-'));
        t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
            assert.match(path.basename(real), /^cbte-preview-hosted-/); await fs.rm(real, { recursive: true }); });
        await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_PREVIEW_ZIP, root], { timeout: 30000 });
        const app = path.join(root, 'X通知の準備.app', 'Contents'), bin = path.join(app, 'MacOS');
        for (const name of ['Launch', 'MacNode', 'MacStoreLock']) {
            const stat = await fs.lstat(path.join(bin, name));
            assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111), `${name} is not executable`);
        }
        // Load the real bundled entry without executing its UI, then create a
        // disposable database with the packaged addon and bundled runtime.
        const probe = `require(${JSON.stringify(path.join(app, 'Resources', 'MacSetup.cjs'))});` +
            `const addon=require(${JSON.stringify(path.join(bin, 'MacLevelDB.node'))});` +
            `(async()=>{const db=addon.db_init();await addon.db_open(db,${JSON.stringify(path.join(root, 'synthetic-leveldb'))},` +
            `{createIfMissing:true});try{await addon.db_put(db,'fixture','value',{});}finally{await addon.db_close(db);}` +
            `process.stdout.write('preview-load-ok');})().catch(()=>{process.exitCode=1});`;
        const result = await exec(path.join(bin, 'MacNode'), ['-e', probe], { timeout: 30000, maxBuffer: 16384,
            env: { HOME: root, PATH: '/usr/bin:/bin' } });
        assert.equal(result.stdout, 'preview-load-ok');
    });

test('packaged launcher reaches the initial setup dialog in an isolated home',
    { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
        assert.ok(path.isAbsolute(process.env.MAC_PREVIEW_ZIP || ''), 'missing synthetic preview');
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-preview-dialog-'));
        let child, closed = false, resolveClosed, closePromise;
        t.after(async () => {
            if (child && !closed && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Refuse cleanup if exit is uncertain. */ } }
            let timer; const directStopped = !child || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer);
            const groupStopped = !child?.pid || directStopped && await waitForMacProcessGroupExit(child.pid);
            if (!groupStopped && child?.pid) {
                let probe = 'alive';
                try { process.kill(-child.pid, 0); }
                catch (error) { probe = ['ESRCH', 'EPERM', 'EINVAL'].includes(error?.code) ? error.code : 'other'; }
                t.diagnostic(`synthetic launcher shutdown: directStopped=${directStopped} groupProbe=${probe}`);
                await describeSyntheticGroup(t, child.pid, 'launcher');
            }
            if (groupStopped) { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
                assert.match(path.basename(real), /^cbte-preview-dialog-/); await fs.rm(real, { recursive: true }); }
            assert.equal(groupStopped, true, 'synthetic launcher termination was not confirmed; test directory retained');
        });
        await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_PREVIEW_ZIP, root], { timeout: 30000 });
        const home = path.join(root, 'home'), support = path.join(home, 'Library', 'Application Support');
        await fs.mkdir(support, { recursive: true, mode: 0o700 });
        const launcher = path.join(root, 'X通知の準備.app', 'Contents', 'MacOS', 'Launch');
        closePromise = new Promise(resolve => { resolveClosed = resolve; });
        child = spawn(launcher, [], { detached: true, stdio: 'ignore', env: { HOME: home, TMPDIR: root, PATH: '/usr/bin:/bin' } });
        child.once('close', () => { closed = true; resolveClosed(); });
        child.once('error', () => {});
        let dialogPid = null;
        for (let attempt = 0; attempt < 100 && !dialogPid && !closed; attempt++) {
            const result = await exec('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 1024 * 1024 });
            for (const line of result.stdout.split('\n')) {
                const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
                if (match && Number(match[2]) === child.pid && path.basename(match[3]) === 'osascript') dialogPid = Number(match[1]);
            }
            if (!dialogPid) await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(dialogPid, 'setup dialog process did not start');
        const args = await exec('/bin/ps', ['-p', String(dialogPid), '-o', 'args='], { timeout: 5000, maxBuffer: 65536 });
        assert.ok(args.stdout.includes('専用のChromeでXにログイン'), 'expected initial dialog was not requested');
        await fs.access(path.join(support, 'XNotificationSetup'));
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(closed, false, 'launcher exited before the initial dialog could be answered');
    });
