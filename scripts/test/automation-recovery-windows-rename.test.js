'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module'), { compileFunction } = require('node:vm');
const bootstrapPath = require.resolve('../../src/recoveryBootstrap');
const options = { tables: { autoExtractTargets: 'empty_targets', deregisterNotifications: 'empty_deregister', botErrorAlerts: 'empty_alerts' }, query: async () => [], subscriptions: { load: () => [] } };

async function fixture(work) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-bootstrap-rename-')), names = ['CBTE_RECOVERY_BOOTSTRAP_ID','CBTE_RECOVERY_BOOTSTRAP_DIR','CBTE_FLEET_NODE'];
    const previous = new Map(names.map(name => [name, process.env[name]])), cached = require.cache[bootstrapPath];
    process.env.CBTE_RECOVERY_BOOTSTRAP_ID = 'b'.repeat(24); process.env.CBTE_RECOVERY_BOOTSTRAP_DIR = path.join(directory, 'bootstrap'); process.env.CBTE_FLEET_NODE = 'oci'; delete require.cache[bootstrapPath];
    try {
        const bootstrap = require(bootstrapPath), cutoff = bootstrap.begin().startedAtMs, filename = path.join(process.env.CBTE_RECOVERY_BOOTSTRAP_DIR, 'bootstrap.json');
        await work({ bootstrap, cutoff, filename, directory });
    } finally {
        for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        if (cached) require.cache[bootstrapPath] = cached; else delete require.cache[bootstrapPath];
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('cbte-bootstrap-rename-'));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function denyDeleteSharing(filename, directory) {
    const signal = path.join(directory, 'release-lock'), quoted = value => `'${value.replaceAll("'", "''")}'`;
    const script = `$stream = [System.IO.File]::Open(${quoted(filename)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine('locked')
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [System.IO.File]::Exists(${quoted(signal)}) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 5 }
} finally { $stream.Dispose() }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(undefined) : reject(new Error(`Owned lock helper failed: ${code} ${stderr}`))); });
    await new Promise((resolve, reject) => {
        let text = ''; child.stdout.on('data', value => { text += value; if (text.includes('locked')) resolve(undefined); });
        closed.then(() => reject(new Error('Lock helper exited before holding the file')), reject);
    });
    return { release: () => fs.writeFileSync(signal, 'release'), close: async () => { fs.writeFileSync(signal, 'release'); await closed; } };
}

for (const temporary of [true, false]) test(`Windows actual delete-sharing lock ${temporary ? 'releases during bounded atomic retry' : 'stays fail-closed after bounded retries'}`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => fixture(async ({ bootstrap, cutoff, filename, directory }) => {
    const locker = await denyDeleteSharing(filename, directory), rename = fs.renameSync, failures = []; let attempts = 0;
    fs.renameSync = function (from, to) {
        if (to !== filename) return rename.apply(this, arguments);
        attempts++;
        try { return rename.apply(this, arguments); }
        catch (error) { failures.push(error.code); if (temporary) locker.release(); throw error; }
    };
    try {
        if (temporary) {
            assert.equal((await bootstrap.initialize(options)).complete, true); assert(attempts >= 2); assert(failures.every(code => ['EPERM','EBUSY'].includes(code)));
        } else {
            await assert.rejects(bootstrap.initialize(options), error => ['EPERM','EBUSY'].includes(error.code)); assert.equal(attempts, 11); assert.equal(bootstrap.begin().complete, false);
        }
        const disk = JSON.parse(fs.readFileSync(filename, 'utf8')); assert.equal(disk.startedAtMs, cutoff); assert.equal(disk.complete, temporary);
        assert.equal(fs.readdirSync(path.dirname(filename)).some(name => name.endsWith('.tmp')), false);
    } finally { fs.renameSync = rename; await locker.close(); }
    if (!temporary) assert.equal((await bootstrap.initialize(options)).complete, true);
    assert.equal(bootstrap.begin().startedAtMs, cutoff);
}));

test('recovery atomic EIO is immediate and retains the original uncompleted receipt', async () => fixture(async ({ bootstrap, cutoff, filename }) => {
    const rename = fs.renameSync; let attempts = 0;
    fs.renameSync = function (from, to) { if (to === filename) { attempts++; throw Object.assign(new Error('Injected EIO'), { code: 'EIO' }); } return rename.apply(this, arguments); };
    try { await assert.rejects(bootstrap.initialize(options), { code: 'EIO' }); assert.equal(attempts, 1); assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).complete, false); }
    finally { fs.renameSync = rename; }
    assert.equal((await bootstrap.initialize(options)).startedAtMs, cutoff);
}));

test('Linux platform branch keeps EPERM immediate instead of using Windows retry', async () => fixture(async ({ filename, cutoff }) => {
    const native = createRequire(bootstrapPath), mod = { exports: {} };
    compileFunction(fs.readFileSync(bootstrapPath, 'utf8'), ['require','module','exports','process'], { filename: bootstrapPath })(native, mod, mod.exports, { platform: 'linux', env: process.env });
    const rename = fs.renameSync; let attempts = 0;
    fs.renameSync = function (from, to) { if (to === filename) { attempts++; throw Object.assign(new Error('Injected Linux EPERM'), { code: 'EPERM' }); } return rename.apply(this, arguments); };
    try { await assert.rejects(mod.exports.initialize(options), { code: 'EPERM' }); assert.equal(attempts, 1); assert.equal(mod.exports.begin().complete, false); assert.equal(mod.exports.begin().startedAtMs, cutoff); }
    finally { fs.renameSync = rename; }
}));
