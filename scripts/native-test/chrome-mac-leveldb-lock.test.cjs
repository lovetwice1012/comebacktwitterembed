'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { ClassicLevel } = require('classic-level');
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
