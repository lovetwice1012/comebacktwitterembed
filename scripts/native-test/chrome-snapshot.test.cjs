'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Chrome snapshot copies only allowlisted notification databases and removes its own scratch', { skip: process.platform !== 'win32' }, t => {
    const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cbte-chrome-copy-test-'));
    t.after(() => {
        const checked = fs.realpathSync(root); assert.equal(path.dirname(checked).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(checked), /^cbte-chrome-copy-test-/); fs.rmSync(checked, { recursive: true });
    });
    const profile = path.join(root, 'chrome-profile'), store = path.join(profile, 'Default', 'GCM Store'), encryption = path.join(store, 'Encryption');
    fs.mkdirSync(encryption, { recursive: true });
    for (const f of ['LOCK', 'CURRENT', '000001.log']) fs.writeFileSync(path.join(store, f), f);
    for (const f of ['LOCK', 'CURRENT', '000001.log']) fs.writeFileSync(path.join(encryption, f), f);
    fs.writeFileSync(path.join(profile, 'Local State'), '{}'); fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), '{}');
    fs.writeFileSync(path.join(profile, 'Default', 'Cookies'), 'must not copy');
    const helper = path.resolve(__dirname, '../../client/angelic-setup/ChromeSnapshot.ps1');
    const quoted = s => `'${s.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'
function Assert-SafePath([string]$p) { if (-not $p.StartsWith(${quoted(root)}, [StringComparison]::OrdinalIgnoreCase)) { throw 'outside' } }
function Get-PathAttributes([string]$p) { if (Test-Path -LiteralPath $p) { return [IO.File]::GetAttributes($p) }; return $null }
function Write-NewJson([string]$p,$v) { [IO.File]::WriteAllText($p, ($v | ConvertTo-Json -Compress)) }
function Read-SmallJson([string]$p) { return [IO.File]::ReadAllText($p) | ConvertFrom-Json }
function Assert-PropertyNames($o,[string[]]$n) { if (@($o.PSObject.Properties).Count -ne $n.Count) { throw 'bad marker' } }
. ${quoted(helper)}
$s=Copy-XChromeSnapshot -ProfileRoot ${quoted(profile)} -PrivateRoot ${quoted(root)}
if (Test-Path -LiteralPath (Join-Path $s.path 'Default\\Cookies')) { throw 'cookie copied' }
if (-not (Test-Path -LiteralPath (Join-Path $s.path 'Default\\GCM Store\\CURRENT'))) { throw 'database missing' }
Remove-XChromeSnapshot -Snapshot $s.path -Token $s.token -PrivateRoot ${quoted(root)}
if (Test-Path -LiteralPath $s.path) { throw 'scratch remains' }
'ok'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ok/);
});
