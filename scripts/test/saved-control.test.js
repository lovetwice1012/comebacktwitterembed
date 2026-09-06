'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const controls = require('../../src/savedControl');

async function fixture(work) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cbte-save-control-'));
    const previous = process.env.ADMIN_SAVE_CONTROL_GID;
    delete process.env.ADMIN_SAVE_CONTROL_GID;
    try { await work(directory); }
    finally {
        if (previous === undefined) delete process.env.ADMIN_SAVE_CONTROL_GID; else process.env.ADMIN_SAVE_CONTROL_GID = previous;
        await fsp.rm(directory, { recursive: true, force: true });
    }
}
async function createJson(file, value) {
    const created = await controls.create(file);
    await created.handle.writeFile(JSON.stringify(value));
    await created.handle.sync();
    await created.handle.close();
    return created;
}

test('save-control GID is an opt-in integer and rejects ambiguous/root group values', () => {
    assert.equal(controls.configuredGid({}), null);
    assert.equal(controls.configuredGid({ ADMIN_SAVE_CONTROL_GID: '' }), null);
    assert.equal(controls.configuredGid({ ADMIN_SAVE_CONTROL_GID: '456' }), 456);
    assert.equal(controls.configuredGid({ ADMIN_SAVE_CONTROL_GID: '2147483647' }), 2147483647);
    for (const value of ['0', '-1', '1.0', '1e3', ' 456', '456 ', '0456', '456extra', '2147483648']) {
        assert.throws(() => controls.configuredGid({ ADMIN_SAVE_CONTROL_GID: value }), { code: 'SAVE_CONTROL_CONFIG_INVALID' });
    }
});

test('new shared-directory ACL expands only the owning group and preserves inherited effective rights', () => {
    const plan = controls._internal.directoryAclPlan('user::rwx\nuser:65533:rwx #effective:r-x\ngroup::r-x\ngroup:1234:rwx #effective:r-x\nmask::r-x\nother::r-x\ndefault:user::rwx\ndefault:group::r-x\ndefault:other::r-x\n');
    assert.ok(plan.access.includes('group::rwx'));
    assert.ok(plan.access.includes('mask::rwx'));
    assert.ok(plan.access.includes('user:65533:r-x'));
    assert.ok(plan.access.includes('group:1234:r-x'));
    assert.ok(plan.access.includes('other::r-x'));
    assert.deepEqual(plan.defaults, ['default:group::r-x', 'default:other::r-x', 'default:user::rwx']);
});

test('default private control files retain0600 and round-trip through verified handles', async () => {
    await fixture(async directory => {
        const file = path.join(directory, '.admin-save.lock');
        const created = await createJson(file, { pid: process.pid, tweetId: '123' });
        const record = await controls.read(file, 'lock');
        assert.equal(record.identity, created.identity);
        assert.equal(record.value.pid, process.pid);
        if (process.platform !== 'win32') assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
        await controls.removeOwned(file, record.identity);
        assert.equal(fs.existsSync(file), false);
    });
});

test('malformed, initializing, and non-object records are preserved as busy or unknown', async () => {
    await fixture(async directory => {
        for (const [index, value] of ['', '{unfinished', 'null', '[]'].entries()) {
            const file = path.join(directory, `.admin-save-${index}.lock`);
            const created = await controls.create(file);
            await created.handle.writeFile(value); await created.handle.close();
            await assert.rejects(controls.read(file, 'lock'), { code: 'SAVE_BUSY' });
            await assert.rejects(controls.read(file, 'journal'), { code: 'SAVE_RECOVERY_UNKNOWN' });
            assert.equal(await fsp.readFile(file, 'utf8'), value);
        }
    });
});

test('control readers reject symlinks and unlink never removes a replacement inode', async () => {
    await fixture(async directory => {
        const file = path.join(directory, '.admin-save.lock');
        const old = await createJson(file, { pid: process.pid, tweetId: '123' });
        await fsp.rename(file, path.join(directory, 'original'));
        await createJson(file, { pid: process.pid, tweetId: '456' });
        await assert.rejects(controls.removeOwned(file, old.identity), { code: 'SAVE_CONTROL_CHANGED' });
        assert.equal((await controls.read(file, 'lock')).value.tweetId, '456');
        const linked = path.join(directory, 'linked.lock');
        try { await fsp.symlink(file, linked); }
        catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
        await assert.rejects(controls.read(linked, 'lock'), { code: 'SAVE_CONTROL_UNTRUSTED' });
        assert.equal(fs.existsSync(file), true);
    });
});

test('legacy EACCES reports repair needed and preserves its record', async () => {
    await fixture(async directory => {
        const file = path.join(directory, '.admin-save.lock');
        await createJson(file, { pid: 999999, tweetId: '123' });
        const before = await fsp.readFile(file);
        const stub = mock.method(fsp, 'open', async () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); });
        try { await assert.rejects(controls.read(file, 'lock'), { code: 'SAVE_CONTROL_PERMISSION' }); }
        finally { stub.mock.restore(); }
        assert.deepEqual(await fsp.readFile(file), before);
    });
});

const posixProbeAvailable = process.platform === 'linux' && process.getuid?.() === 0 && fs.existsSync('/usr/bin/setfacl') && fs.existsSync('/usr/bin/getfacl');
test('POSIX shared group supports root-worker-root recovery without inherited named ACL access', { skip: !posixProbeAvailable }, async () => {
    await fixture(async directory => {
        const gid = 65534;
        await fsp.chown(directory, 0, gid); await fsp.chmod(directory, 0o2775);
        execFileSync('/usr/bin/setfacl', ['-m', 'd:u:65533:rwx', directory]);
        const helper = path.join(directory, 'savedControl.js');
        await fsp.copyFile(require.resolve('../../src/savedControl'), helper); await fsp.chmod(helper, 0o644);
        process.env.ADMIN_SAVE_CONTROL_GID = String(gid);
        const file = path.join(directory, '.admin-save.lock');
        await createJson(file, { pid: process.pid, tweetId: '123' });
        const info = await fsp.stat(file);
        assert.equal(info.gid, gid); assert.equal(info.mode & 0o7777, 0o660);
        const env = { ADMIN_SAVE_CONTROL_GID: String(gid), PATH: process.env.PATH };
        const program = `const c=require(process.argv[1]);(async()=>{const r=await c.read(process.argv[2],'lock');const j=await c.create(process.argv[3]);await j.handle.writeFile(JSON.stringify({from:'worker'}));await j.handle.close();console.log(JSON.stringify({pid:r.value.pid}));})().catch(e=>{console.error(e.code);process.exit(1)})`;
        const journal = path.join(directory, '.admin-save-journal.json');
        const value = JSON.parse(execFileSync(process.execPath, ['-e', program, helper, file, journal], { uid: gid, gid, env, timeout: 10000, encoding: 'utf8' }));
        assert.equal(value.pid, process.pid);
        assert.equal((await controls.read(journal, 'journal')).value.from, 'worker');
        const denied = execFileSync(process.execPath, ['-e', `try{require('fs').readFileSync(process.argv[1]);process.exit(2)}catch(e){console.log(e.code)}`, file], { uid: 65533, gid: 65533, env: { PATH: process.env.PATH }, timeout: 5000, encoding: 'utf8' });
        assert.equal(denied.trim(), 'EACCES');
        const legacy = path.join(directory, 'legacy.lock');
        await fsp.writeFile(legacy, '{}', { mode: 0o600 });
        const legacyProbe = execFileSync(process.execPath, ['-e', `require(process.argv[1]).read(process.argv[2],'lock').then(()=>process.exit(2)).catch(e=>console.log(e.code))`, helper, legacy], { uid: gid, gid, env, timeout: 5000, encoding: 'utf8' });
        assert.equal(legacyProbe.trim(), 'SAVE_CONTROL_PERMISSION');
        const newDirectory = path.join(directory, 'new-user'); await fsp.mkdir(newDirectory, { mode: 0o755 });
        const before = await fsp.stat(newDirectory);
        await controls.prepareCreatedDirectory(newDirectory);
        const after = await fsp.stat(newDirectory);
        assert.equal(after.gid, gid); assert.equal(after.mode & 0o2070, 0o2070); assert.equal(after.mode & 0o007, before.mode & 0o007);
        const otherWrite = execFileSync(process.execPath, ['-e', `try{require('fs').writeFileSync(process.argv[1],'unexpected');process.exit(2)}catch(e){console.log(e.code)}`, path.join(newDirectory, 'other-write')], { uid: 65533, gid: 65533, env: { PATH: process.env.PATH }, timeout: 5000, encoding: 'utf8' });
        assert.equal(otherWrite.trim(), 'EACCES');
    });
});
