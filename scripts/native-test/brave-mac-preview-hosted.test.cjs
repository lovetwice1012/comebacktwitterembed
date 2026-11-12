'use strict';

// Unsigned preview inspection on a disposable hosted Mac. It stops at the
// first synthetic dialog and never opens a real browser or user profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const exec = promisify(execFile);

test('Mac Brave preview loads its pinned manifest and reaches its first dialog',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_BRAVE_PREVIEW_HOSTED !== '1', timeout: 90000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        assert.ok(path.isAbsolute(process.env.MAC_BRAVE_PREVIEW_ZIP || ''));
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-brave-preview-hosted-'));
        let child, closed = false, closePromise;
        t.after(async () => {
            if (child && !closed && child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Retain on uncertainty. */ }
            let timer;
            const exited = !child || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer);
            const stopped = !child?.pid || exited && await waitForMacProcessGroupExit(child.pid);
            if (stopped) {
                const actual = await fs.realpath(root); assert.equal(path.dirname(actual), temp);
                assert.match(path.basename(actual), /^cbte-brave-preview-hosted-/); await fs.rm(actual, { recursive: true });
            }
            assert.equal(stopped, true, 'synthetic launcher termination unconfirmed; test directory retained');
        });
        await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_BRAVE_PREVIEW_ZIP, root], { timeout: 30000 });
        const app = path.join(root, 'X通知の準備.app', 'Contents'), bin = path.join(app, 'MacOS');
        const manifest = JSON.parse(await fs.readFile(path.join(app, 'Resources', 'MacSetup-manifest.json'), 'utf8'));
        assert.equal(manifest.packageId, 'x-notification-mac-brave-setup'); assert.equal(manifest.version, '0.1.0-mac-brave-preview.2');
        const helper = await fs.readFile(path.join(bin, 'MacStoreLock'));
        assert.equal(createHash('sha256').update(helper).digest('hex'), manifest.lockSha256);
        for (const name of ['Launch', 'MacNode', 'MacStoreLock']) {
            const stat = await fs.lstat(path.join(bin, name)); assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111));
        }
        const home = path.join(root, 'home'), support = path.join(home, 'Library', 'Application Support');
        await fs.mkdir(support, { recursive: true, mode: 0o700 });
        child = spawn(path.join(bin, 'Launch'), [], { detached: true, stdio: 'ignore',
            env: { HOME: home, TMPDIR: root, PATH: '/usr/bin:/bin', CBTE_EXPERIMENTAL_BRAVE_MAC_LOCAL: '1' } });
        closePromise = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
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
        assert.ok(dialogPid, 'synthetic initial dialog was not requested');
        const args = await exec('/bin/ps', ['-p', String(dialogPid), '-o', 'args='], { timeout: 5000, maxBuffer: 65536 });
        assert.ok(args.stdout.includes('専用のBraveでXにログイン') && args.stdout.includes('Googleのプッシュ通知サービス'), 'unexpected synthetic dialog');
        await fs.access(path.join(support, 'XNotificationSetup'));
        assert.equal(closed, false, 'preview exited before its first dialog');
    });
