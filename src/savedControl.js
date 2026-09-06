'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const MAX_GID = 2147483647;
const CONTROL_LIMIT = 64 * 1024;
const identity = stat => `${stat.dev}:${stat.ino}`;
function failure(code, message, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { code }); }
function configuredGid(env = process.env) {
    const value = env.ADMIN_SAVE_CONTROL_GID;
    if (value === undefined || value === '') return null;
    if (!/^[1-9]\d{0,9}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_GID) {
        throw failure('SAVE_CONTROL_CONFIG_INVALID', 'ADMIN_SAVE_CONTROL_GID must be an integer from 1 to 2147483647.');
    }
    return Number(value);
}
function policy() {
    const gid = configuredGid();
    if (gid !== null && (process.platform !== 'linux' || typeof process.getuid !== 'function')) {
        throw failure('SAVE_CONTROL_CONFIG_UNSUPPORTED', 'Shared save-control ownership requires Linux descriptor and ACL support.');
    }
    return { gid, uid: typeof process.getuid === 'function' ? process.getuid() : null, mode: gid === null ? 0o600 : 0o660 };
}
function permissionFailure(error) {
    if (['EACCES', 'EPERM'].includes(error.code)) return failure('SAVE_CONTROL_PERMISSION', 'Save-control ownership or permissions require administrator repair. The existing lock or recovery journal was preserved.', error);
    return error;
}
async function acl(handle, operation, entries = '') {
    const args = operation === 'clear' ? ['--remove-all', '/proc/self/fd/3'] : operation === 'modify' ? ['--modify', entries, '/proc/self/fd/3'] : ['--omit-header', '--numeric', '--absolute-names', '/proc/self/fd/3'];
    const executable = operation === 'read' ? '/usr/bin/getfacl' : '/usr/bin/setfacl';
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore', handle.fd] });
        let output = '', done = false, timer;
        const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
        timer = setTimeout(() => { child.kill('SIGKILL'); finish(failure('SAVE_CONTROL_ACL_UNAVAILABLE', 'Save-control ACL verification exceeded its deadline.')); }, 3000);
        child.stdout.on('data', chunk => {
            output += chunk.toString('utf8');
            if (output.length > 16384) { child.kill('SIGKILL'); finish(failure('SAVE_CONTROL_ACL_UNAVAILABLE', 'Save-control ACL response exceeded its limit.')); }
        });
        child.once('error', error => finish(failure('SAVE_CONTROL_ACL_UNAVAILABLE', 'Linux getfacl/setfacl is required for shared save-control files.', error)));
        child.once('close', code => finish(code === 0 ? null : failure('SAVE_CONTROL_PERMISSION', 'Save-control ACL inspection or preparation failed; administrator repair is required.'), output));
    });
}
function directoryAclPlan(raw) {
    const lines = String(raw).split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean);
    const defaults = lines.filter(line => line.startsWith('default:')).sort();
    const access = lines.filter(line => !line.startsWith('default:'));
    const parsed = access.map(line => {
        const match = /^(user|group|mask|other):(\d*):([r-][w-][x-])$/.exec(line);
        if (!match || ['mask', 'other'].includes(match[1]) && match[2]) throw failure('SAVE_CONTROL_UNTRUSTED', 'New directory has an unrecognized access ACL.');
        return { type: match[1], qualifier: match[2], permissions: match[3] };
    });
    for (const type of ['user', 'group', 'other']) if (parsed.filter(row => row.type === type && row.qualifier === '').length !== 1) throw failure('SAVE_CONTROL_UNTRUSTED', 'New directory ACL is incomplete.');
    if (parsed.filter(row => row.type === 'mask').length > 1) throw failure('SAVE_CONTROL_UNTRUSTED', 'New directory ACL mask is ambiguous.');
    const mask = parsed.find(row => row.type === 'mask')?.permissions || 'rwx';
    const desired = parsed.map(row => {
        let permissions = row.permissions;
        if (row.type === 'group' && row.qualifier === '' || row.type === 'mask') permissions = 'rwx';
        else if (row.qualifier) permissions = [...permissions].map((value, index) => mask[index] === '-' ? '-' : value).join('');
        return `${row.type}:${row.qualifier}:${permissions}`;
    }).sort();
    return { entries: desired.join(','), access: desired, defaults };
}
async function verifyHandle(handle, file, expected = null) {
    const rules = policy();
    const stat = await handle.stat();
    const named = await fsp.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || named.isSymbolicLink() || identity(stat) !== identity(named) || expected && identity(stat) !== expected) {
        throw failure('SAVE_CONTROL_UNTRUSTED', 'Save-control file identity changed or is not a plain owned file.');
    }
    if (rules.uid !== null && (rules.gid === null ? stat.uid !== rules.uid : stat.gid !== rules.gid) || process.platform !== 'win32' && (stat.mode & 0o7777) !== rules.mode) {
        throw failure('SAVE_CONTROL_PERMISSION', 'Save-control file owner, group, or mode does not match the configured policy. Administrator repair is required.');
    }
    if (rules.gid !== null) {
        const lines = String(await acl(handle, 'read')).split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort();
        if (JSON.stringify(lines) !== JSON.stringify(['group::rw-', 'other::---', 'user::rw-'])) {
            throw failure('SAVE_CONTROL_PERMISSION', 'Save-control file has unexpected access ACL entries. Administrator repair is required.');
        }
    }
    return stat;
}
async function removeOwned(file, expected) {
    const stat = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw permissionFailure(error); });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || identity(stat) !== expected) throw failure('SAVE_CONTROL_CHANGED', 'Save-control file changed; it was not removed.');
    await fsp.unlink(file).catch(error => { throw permissionFailure(error); });
}
async function create(file) {
    const rules = policy();
    let handle, owned;
    try {
        handle = await fsp.open(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
        const stat = await handle.stat(); owned = identity(stat);
        if (!stat.isFile() || stat.nlink !== 1 || rules.uid !== null && stat.uid !== rules.uid) throw failure('SAVE_CONTROL_UNTRUSTED', 'New save-control file ownership could not be verified.');
        if (rules.gid !== null) {
            await handle.chown(rules.uid, rules.gid);
            // Do not unmask inherited named ACLs when granting group rw.
            await acl(handle, 'clear');
        }
        if (process.platform !== 'win32') await handle.chmod(rules.mode);
        await verifyHandle(handle, file, owned);
        return { handle, identity: owned };
    } catch (error) {
        if (handle) { await handle.close().catch(() => {}); await removeOwned(file, owned).catch(() => {}); }
        throw permissionFailure(error);
    }
}
async function read(file, kind) {
    let handle;
    try {
        const before = await fsp.lstat(file);
        if (before.isSymbolicLink() || !before.isFile()) throw failure('SAVE_CONTROL_UNTRUSTED', 'Save-control files must not be symbolic links or special files.');
        handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = await verifyHandle(handle, file, identity(before));
        if (stat.size > CONTROL_LIMIT) throw failure('SAVE_CONTROL_UNTRUSTED', 'Save-control record exceeds its size limit.');
        const buffer = Buffer.alloc(CONTROL_LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > CONTROL_LIMIT) throw failure('SAVE_CONTROL_UNTRUSTED', 'Save-control record exceeds its size limit.');
        let value;
        try {
            value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Control record is not an object.');
        }
        catch (cause) { throw failure(kind === 'lock' ? 'SAVE_BUSY' : 'SAVE_RECOVERY_UNKNOWN', 'Save-control record is incomplete or malformed. It was preserved for recovery.', cause); }
        await verifyHandle(handle, file, identity(stat));
        return { value, identity: identity(stat) };
    } catch (error) { throw permissionFailure(error); }
    finally { await handle?.close(); }
}
async function prepareCreatedDirectory(directory) {
    const rules = policy();
    if (rules.gid === null) return;
    const handle = await fsp.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        const before = await handle.stat();
        if (!before.isDirectory() || before.uid !== rules.uid) throw failure('SAVE_CONTROL_UNTRUSTED', 'New shared-save directory ownership could not be verified.');
        const plan = directoryAclPlan(await acl(handle, 'read'));
        await handle.chown(rules.uid, rules.gid);
        // Growing the ACL mask alone could grant inherited named principals
        // new write access. Pin those entries to their previous effective rights.
        await acl(handle, 'modify', plan.entries);
        await handle.chmod((before.mode & 0o777) | 0o2070);
        const after = await handle.stat(), named = await fsp.lstat(directory);
        if (named.isSymbolicLink() || identity(named) !== identity(after) || after.gid !== rules.gid || (after.mode & 0o2070) !== 0o2070) throw failure('SAVE_CONTROL_UNTRUSTED', 'New shared-save directory verification failed.');
        const finalLines = String(await acl(handle, 'read')).split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean);
        if (JSON.stringify(finalLines.filter(line => !line.startsWith('default:')).sort()) !== JSON.stringify(plan.access) || JSON.stringify(finalLines.filter(line => line.startsWith('default:')).sort()) !== JSON.stringify(plan.defaults)) throw failure('SAVE_CONTROL_UNTRUSTED', 'New shared-save directory ACL verification failed.');
    } catch (error) { throw permissionFailure(error); }
    finally { await handle.close(); }
}

module.exports = { configuredGid, create, read, removeOwned, prepareCreatedDirectory, _internal: { directoryAclPlan } };
