'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { ClassicLevel } = require('classic-level');
const { createHash } = require('node:crypto');
const { createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { withMacStoreLocks } = require('../../src/automation/chrome-mac-store-locks');
const helper = process.env.MAC_LOCK_HELPER;

function runLock(first, second) {
    const child = spawn(helper, [first, second], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const ready = Promise.race([
        once(child.stdout, 'data').then(([data]) => data.toString('ascii')),
        exited.then(() => { throw new Error('helper exited without a status'); }),
        new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('helper timed out')), 5000); timer.unref(); }),
    ]);
    return { child, ready, exited };
}
test('native helper holds real LevelDB fcntl locks and releases them on EOF', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-mac-lock-test-'));
    const processes = [];
    t.after(async () => {
        for (const item of processes) if (item.child.exitCode === null) { item.child.stdin.end(); await item.exited.catch(() => {}); }
        const real = await fs.realpath(root); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-lock-test-/); await fs.rm(real, { recursive: true });
    });
    const dirs = ['first', 'second', 'third', 'fourth'].map(name => path.join(root, name));
    for (const dir of dirs) { const db = new ClassicLevel(dir); await db.put('test', 'synthetic'); await db.close(); }
    const locks = dirs.map(dir => path.join(dir, 'LOCK'));
    const first = runLock(locks[0], locks[1]); processes.push(first); assert.equal(await first.ready, 'R');
    const contender = runLock(locks[0], locks[1]); processes.push(contender); assert.equal(await contender.ready, 'B'); await contender.exited;
    const db = new ClassicLevel(dirs[0], { createIfMissing: false });
    try { await assert.rejects(db.open(), error => error.code === 'LEVEL_LOCKED' || /lock/i.test(String(error.cause?.message || error.message))); }
    finally { await db.close().catch(() => {}); }
    first.child.stdin.end(); assert.equal((await first.exited)[0], 0);
    const successor = runLock(locks[0], locks[1]); processes.push(successor); assert.equal(await successor.ready, 'R');
    successor.child.stdin.end(); await successor.exited;
    const holder = runLock(locks[1], locks[2]); processes.push(holder); assert.equal(await holder.ready, 'R');
    const partial = runLock(locks[0], locks[1]); processes.push(partial); assert.equal(await partial.ready, 'B'); await partial.exited;
    const afterPartial = runLock(locks[0], locks[3]); processes.push(afterPartial); assert.equal(await afterPartial.ready, 'R');
    afterPartial.child.stdin.end(); await afterPartial.exited; holder.child.stdin.end(); await holder.exited;
    const link = path.join(root, 'link'); await fs.symlink(locks[0], link);
    const invalid = runLock(link, locks[1]); processes.push(invalid); assert.equal(await invalid.ready, 'E'); await invalid.exited;
    const same = runLock(locks[0], path.join(dirs[0], '.', 'LOCK')); processes.push(same); assert.equal(await same.ready, 'E'); await same.exited;
});
test('profile lock wrapper fences browser starts and real LevelDB access until work finishes', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-lock-wrapper-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-lock-wrapper-test-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacChromeProfile(base), store = path.join(profile.profilePath, 'Default', 'GCM Store');
    const nested = path.join(store, 'Encryption'); await fs.mkdir(nested, { recursive: true });
    for (const dir of [store, nested]) { const db = new ClassicLevel(dir); await db.put('test', 'synthetic'); await db.close(); }
    const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper,
        expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
    await assert.rejects(withMacStoreLocks({ ...args, expectedSha256: '0'.repeat(64), work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_INVALID' });
    const busyDb = new ClassicLevel(store, { createIfMissing: false }); await busyDb.open();
    try { await assert.rejects(withMacStoreLocks({ ...args, work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_BUSY' }); }
    finally { await busyDb.close(); }
    const result = await withMacStoreLocks({ ...args, work: async ({ profilePath, signal }) => {
        assert.equal(profilePath, profile.profilePath); assert.equal(signal.aborted, false);
        await assert.rejects(withMacStoreLocks({ ...args, work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_BUSY' });
        for (const dir of [store, nested]) {
            const db = new ClassicLevel(dir, { createIfMissing: false });
            try { await assert.rejects(db.open(), error => /lock/i.test(String(error.cause?.message || error.message))); }
            finally { await db.close().catch(() => {}); }
        }
        return 'snapshot-ready';
    } });
    assert.equal(result, 'snapshot-ready');
    assert.equal(await withMacStoreLocks({ ...args, work: async () => 'reacquired' }), 'reacquired');
    await assert.rejects(withMacStoreLocks({ ...args, work: async () => { throw new Error('sensitive'); } }), { code: 'X_CHROME_MAC_LOCK_FAILED' });
    assert.equal(await withMacStoreLocks({ ...args, work: async () => 'released-after-failure' }), 'released-after-failure');
    const failingHelper = path.join(base, 'synthetic-exit-helper');
    await fs.writeFile(failingHelper, '#!/bin/sh\nprintf R\nsleep 0.1\n', { mode: 0o700 });
    const badHash = createHash('sha256').update(await fs.readFile(failingHelper)).digest('hex');
    await assert.rejects(withMacStoreLocks({ ...args, helperPath: failingHelper, expectedSha256: badHash,
        work: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }), { code: 'X_CHROME_MAC_LOCK_LOST' });
    assert.equal(await withMacStoreLocks({ ...args, work: async () => 'released-after-exit' }), 'released-after-exit');
});
