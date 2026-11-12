'use strict';

// Disposable CI host only. LaunchServices receives an isolated HOME and the
// test stops at the first dialog; no browser or account is opened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

async function processes() {
    const result = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
        .map(match => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }));
}
test('LaunchServices opens the packaged setup using a synthetic home',
    { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
        assert.ok(path.isAbsolute(process.env.MAC_PREVIEW_ZIP || ''), 'missing synthetic preview');
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-preview-open-'));
        let opener, closed = false, resolveClosed, closePromise, nodePid, dialogPid;
        const app = path.join(root, 'X通知の準備.app'), bin = path.join(app, 'Contents', 'MacOS'), nodePath = path.join(bin, 'MacNode');
        const belongs = p => p.pid === nodePid && p.command.startsWith(nodePath + ' ');
        t.after(async () => {
            // Only the unique executable under this invocation's temp root and
            // its direct osascript child are eligible for termination.
            const list = await processes();
            const appProcess = list.find(belongs);
            if (appProcess) {
                const dialogs = list.filter(p => p.parent === nodePid && /^\/usr\/bin\/osascript(?:\s|$)/.test(p.command));
                try { process.kill(nodePid, 'SIGTERM'); } catch { /* Already stopped. */ }
                for (const dialog of dialogs) try { process.kill(dialog.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
            }
            let timer; const stopped = !opener || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer);
            if (opener && !closed) opener.kill('SIGTERM');
            const remainingList = await processes();
            const remaining = remainingList.some(belongs) || remainingList.some(p => p.pid === dialogPid && /^\/usr\/bin\/osascript(?:\s|$)/.test(p.command));
            if (stopped && nodePid && !remaining) { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
                assert.match(path.basename(real), /^cbte-preview-open-/); await fs.rm(real, { recursive: true }); }
            assert.ok(stopped && nodePid && !remaining, 'synthetic application termination unconfirmed; test directory retained');
        });
        await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_PREVIEW_ZIP, root], { timeout: 30000 });
        const home = path.join(root, 'home'), support = path.join(home, 'Library', 'Application Support');
        await fs.mkdir(support, { recursive: true, mode: 0o700 });
        closePromise = new Promise(resolve => { resolveClosed = resolve; });
        opener = spawn('/usr/bin/open', ['-W', '-n', '--env', `HOME=${home}`, app], { stdio: 'ignore', env: { ...process.env, HOME: home } });
        opener.once('close', () => { closed = true; resolveClosed(); }); opener.once('error', () => {});
        for (let attempt = 0; attempt < 100 && !nodePid && !closed; attempt++) {
            const candidates = (await processes()).filter(p => p.command.startsWith(nodePath + ' '));
            assert.ok(candidates.length <= 1, 'multiple synthetic application processes');
            if (candidates.length) nodePid = candidates[0].pid;
            else await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(nodePid, 'LaunchServices did not start the packaged application');
        for (let attempt = 0; attempt < 100 && !dialogPid && !closed; attempt++) {
            const list = await processes();
            if (!list.some(belongs)) break;
            dialogPid = list.find(p => p.parent === nodePid && /^\/usr\/bin\/osascript(?:\s|$)/.test(p.command))?.pid;
            if (!dialogPid) await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(dialogPid, 'packaged application did not request the initial dialog');
        await fs.access(path.join(support, 'XNotificationSetup'));
    });
