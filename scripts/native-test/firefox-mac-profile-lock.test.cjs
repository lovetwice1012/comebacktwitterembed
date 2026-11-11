'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { withMacStoreLocks } = require('../../src/automation/chrome-mac-store-locks');
const helper = process.env.MAC_LOCK_HELPER;

test('Firefox profile lock conflicts with native fcntl and rejects replaced or linked lock files', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-lock-test-'));
    const children = [];
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); await once(child, 'exit').catch(() => {}); }
        const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-firefox-lock-test-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacFirefoxProfile(base), filename = path.join(profile.profilePath, '.parentlock');
    await fs.writeFile(filename, '', { mode: 0o600 });
    const args = { rootPath: profile.rootPath, profileId: profile.profileId, browser: 'firefox', helperPath: helper,
        expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
    // Firefox opens with O_TRUNC before acquiring the fcntl lock.
    const code = 'import fcntl,sys\nf=open(sys.argv[1],"w+")\nfcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint("ready",flush=True)\nsys.stdin.read(1)';
    const holder = spawn('python3', ['-c', code, filename], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(holder);
    assert.equal((await once(holder.stdout, 'data'))[0].toString().trim(), 'ready');
    await assert.rejects(withMacStoreLocks({ ...args, work: async () => assert.fail('busy profile read') }), { code: 'X_CHROME_MAC_LOCK_BUSY' });
    const ended = once(holder, 'exit'); holder.stdin.end(); await ended;
    await withMacStoreLocks({ ...args, work: async ({ profilePath, signal }) => {
        assert.equal(profilePath, profile.profilePath); assert.equal(signal.aborted, false);
        const contender = spawn('python3', ['-c', code, filename], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(contender);
        const [status] = await once(contender, 'exit'); assert.notEqual(status, 0);
        await assert.rejects(withMacStoreLocks({ ...args, work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_BUSY' });
    } });
    const prematureHelper = path.join(base, 'synthetic-exit-helper');
    await fs.writeFile(prematureHelper, '#!/bin/sh\nprintf R\nsleep 0.1\n', { mode: 0o700 });
    const prematureHash = createHash('sha256').update(await fs.readFile(prematureHelper)).digest('hex');
    await assert.rejects(withMacStoreLocks({ ...args, helperPath: prematureHelper, expectedSha256: prematureHash,
        work: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }), { code: 'X_CHROME_MAC_LOCK_LOST' });
    await assert.rejects(withMacStoreLocks({ ...args, work: async () => {
        await fs.rename(filename, `${filename}.old`); await fs.writeFile(filename, '');
    } }), { code: 'X_CHROME_MAC_LOCK_LOST' });
    await fs.unlink(filename); await fs.symlink(`${filename}.old`, filename);
    await assert.rejects(withMacStoreLocks({ ...args, work: async () => assert.fail('symlink accepted') }), { code: 'X_CHROME_MAC_LOCK_INVALID' });
    await fs.unlink(filename);
    await assert.rejects(withMacStoreLocks({ ...args, work: async () => assert.fail('missing lock accepted') }), { code: 'X_CHROME_MAC_LOCK_FAILED' });
    await fs.link(`${filename}.old`, filename);
    await assert.rejects(withMacStoreLocks({ ...args, work: async () => assert.fail('hard link accepted') }), { code: 'X_CHROME_MAC_LOCK_INVALID' });
});
