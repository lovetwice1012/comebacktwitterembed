'use strict';

// Disposable CI experiment only. Ad-hoc signatures are not Developer ID,
// notarization, publisher identity, or authorization to distribute.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const exec = promisify(execFile);

test('ad-hoc hardened Mac preview can load its native database',
    { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
        assert.ok(path.isAbsolute(process.env.MAC_PREVIEW_ZIP || ''), 'missing synthetic preview');
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-adhoc-package-'));
        let child, closed = false, resolveClosed, closePromise;
        t.after(async () => {
            if (child && !closed && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Preserve on uncertainty. */ } }
            let timer; const stopped = !child || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer); const groupGone = !child?.pid || stopped && await waitForMacProcessGroupExit(child.pid);
            if (groupGone) { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
                assert.match(path.basename(real), /^cbte-adhoc-package-/); await fs.rm(real, { recursive: true }); }
            assert.equal(groupGone, true, 'synthetic signed launcher termination unconfirmed; directory retained');
        });
        await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_PREVIEW_ZIP, root], { timeout: 30000 });
        const app = path.join(root, 'X通知の準備.app'), bin = path.join(app, 'Contents', 'MacOS');
        const entitlements = path.join(root, 'node-entitlements.plist');
        await fs.writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
        const sign = async (name, options = []) => exec('/usr/bin/codesign', ['--force', '--sign', '-', ...options, name], { timeout: 30000 });
        await sign(path.join(bin, 'MacLevelDB.node'));
        await sign(path.join(bin, 'MacNode'), ['--options', 'runtime', '--entitlements', entitlements]);
        // The manifest pins the helper bytes, so it must be signed before
        // packaging and must not be re-signed after the manifest is generated.
        await sign(app, ['--options', 'runtime']);
        await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 30000 });
        await exec('/usr/bin/codesign', ['--verify', '--strict', path.join(bin, 'MacStoreLock')], { timeout: 30000 });
        const manifest = JSON.parse(await fs.readFile(path.join(app, 'Contents', 'Resources', 'MacSetup-manifest.json'), 'utf8'));
        const helperHash = createHash('sha256').update(await fs.readFile(path.join(bin, 'MacStoreLock'))).digest('hex');
        assert.equal(helperHash, manifest.lockSha256, 'signing changed the helper after the manifest was created');
        const probe = `require(${JSON.stringify(path.join(app, 'Contents', 'Resources', 'MacSetup.cjs'))});` +
            `const addon=require(${JSON.stringify(path.join(bin, 'MacLevelDB.node'))});` +
            `(async()=>{const db=addon.db_init();await addon.db_open(db,${JSON.stringify(path.join(root, 'synthetic-db'))},{createIfMissing:true});` +
            `try{await addon.db_put(db,'fixture','value',{});}finally{await addon.db_close(db);}process.stdout.write('signed-preview-ok');})().catch(()=>{process.exitCode=1});`;
        const result = await exec(path.join(bin, 'MacNode'), ['-e', probe], { timeout: 30000, maxBuffer: 16384, env: { HOME: root, PATH: '/usr/bin:/bin' } });
        assert.equal(result.stdout, 'signed-preview-ok');
        const home = path.join(root, 'home'), support = path.join(home, 'Library', 'Application Support');
        await fs.mkdir(support, { recursive: true, mode: 0o700 });
        closePromise = new Promise(resolve => { resolveClosed = resolve; });
        child = spawn(path.join(bin, 'Launch'), [], { detached: true, stdio: 'ignore',
            env: { HOME: home, PATH: '/usr/bin:/bin', DYLD_INSERT_LIBRARIES: '/nonexistent/synthetic' } });
        child.once('close', () => { closed = true; resolveClosed(); }); child.once('error', () => {});
        let dialogPid;
        for (let attempt = 0; attempt < 100 && !dialogPid && !closed; attempt++) {
            const list = await exec('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 1024 * 1024 });
            for (const line of list.stdout.split('\n')) {
                const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
                if (match && Number(match[2]) === child.pid && path.basename(match[3]) === 'osascript') dialogPid = Number(match[1]);
            }
            if (!dialogPid) await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(dialogPid, 'signed package did not reach the initial dialog');
        await fs.access(path.join(support, 'XNotificationSetup'));
    });
