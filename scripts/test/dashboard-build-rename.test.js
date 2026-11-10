'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { renameBuildDirectory } = require('../../dashboard/scripts/start-dashboard')._internal;

test('non-Windows and unrelated errors are not retried', () => {
    const original = fs.renameSync; let calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(new Error('fixture'), { code: 'EPERM' }); };
    try { assert.throws(() => renameBuildDirectory('a', 'b', 'linux'), { code: 'EPERM' }); assert.equal(calls, 1); }
    finally { fs.renameSync = original; }
    calls = 0; fs.renameSync = () => { calls++; throw Object.assign(new Error('fixture'), { code: 'EIO' }); };
    try { assert.throws(() => renameBuildDirectory('a', 'b', 'win32'), { code: 'EIO' }); assert.equal(calls, 1); }
    finally { fs.renameSync = original; }
});

test('Windows stops after bounded retries when the rename remains denied', { skip: process.platform !== 'win32' }, () => {
    const original = fs.renameSync; let calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(new Error('fixture'), { code: 'EPERM' }); };
    try { assert.throws(() => renameBuildDirectory('a', 'b'), { code: 'EPERM' }); assert.equal(calls, 21); }
    finally { fs.renameSync = original; }
});

test('Windows retries a real temporary delete-sharing lock on the build directory', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cbte-dashboard-rename-'));
    t.after(() => {
        const actual = fs.realpathSync(root);
        assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(actual), /^cbte-dashboard-rename-/);
        fs.rmSync(actual, { recursive: true });
    });
    const source = path.join(root, 'staging'), destination = path.join(root, 'final'), signal = path.join(root, 'release');
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'BUILD_ID'), 'fixture');
    const script = `$code = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LockDir {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
}
'@
Add-Type $code
$handle=[LockDir]::CreateFile($env:CBTE_LOCK_PATH,[uint32]2147483648,3,[IntPtr]::Zero,3,0x02000000,[IntPtr]::Zero)
if ($handle.IsInvalid) { throw 'Cannot lock fixture directory' }
try { [Console]::Out.WriteLine('locked'); $deadline=[DateTime]::UtcNow.AddSeconds(10); while (-not [IO.File]::Exists($env:CBTE_RELEASE_PATH) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 5 } }
finally { $handle.Dispose() }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CBTE_LOCK_PATH: source, CBTE_RELEASE_PATH: signal } });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Fixture lock failed'))); });
    await new Promise((resolve, reject) => {
        let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.includes('locked')) resolve(); });
        closed.then(() => reject(new Error('Fixture lock ended early')), reject);
    });
    const original = fs.renameSync; let attempts = 0;
    fs.renameSync = (from, to) => {
        attempts++;
        try { return original(from, to); }
        catch (error) { fs.writeFileSync(signal, 'release'); throw error; }
    };
    try {
        renameBuildDirectory(source, destination);
        assert(attempts >= 2); assert.equal(fs.readFileSync(path.join(destination, 'BUILD_ID'), 'utf8'), 'fixture');
    } finally { fs.renameSync = original; if (!fs.existsSync(signal)) fs.writeFileSync(signal, 'release'); await closed; }
});
