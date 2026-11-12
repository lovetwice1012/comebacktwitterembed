'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Edge snapshot copies only the notification store and cleans up only its own copy', { skip: process.platform !== 'win32' }, t => {
    const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cbte-edge-copy-test-'));
    t.after(() => { const checked = fs.realpathSync(root); assert.equal(path.dirname(checked).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(checked), /^cbte-edge-copy-test-/); fs.rmSync(checked, { recursive: true }); });
    const profile = path.join(root, 'edge-profile'), store = path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
    fs.mkdirSync(store, { recursive: true });
    for (const name of ['LOCK', 'CURRENT', '000001.log']) fs.writeFileSync(path.join(store, name), name);
    fs.writeFileSync(path.join(profile, 'Default', 'Cookies'), 'must not copy');
    const helper = path.resolve(__dirname, '../../client/angelic-setup/EdgeSnapshot.ps1');
    const quoted = s => `'${s.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'
function Assert-SafePath([string]$p) { if (-not $p.StartsWith(${quoted(root)}, [StringComparison]::OrdinalIgnoreCase)) { throw 'outside' } }
function Get-PathAttributes([string]$p) { if (Test-Path -LiteralPath $p) { return [IO.File]::GetAttributes($p) }; return $null }
function Write-NewJson([string]$p,$v) { [IO.File]::WriteAllText($p, ($v | ConvertTo-Json -Compress)) }
function Read-SmallJson([string]$p) { [IO.File]::ReadAllText($p) | ConvertFrom-Json }
function Assert-PropertyNames($o,[string[]]$n) { if (@($o.PSObject.Properties).Count -ne $n.Count) { throw 'bad marker' } }
. ${quoted(helper)}
$s=Copy-XEdgeSnapshot -ProfileRoot ${quoted(profile)} -PrivateRoot ${quoted(root)}
if (Test-Path -LiteralPath (Join-Path $s.path 'Default\\Cookies')) { throw 'cookie copied' }
if (-not (Test-Path -LiteralPath (Join-Path $s.path 'Default\\EdgePushStorageWithConnectTokenAndKey\\CURRENT'))) { throw 'database missing' }
$rejected=$false
try { Remove-XEdgeSnapshot -Snapshot $s.path -Token ('0'*32) -PrivateRoot ${quoted(root)} } catch { $rejected=$true }
if (-not $rejected -or -not (Test-Path -LiteralPath $s.path)) { throw 'incorrect deletion' }
Remove-XEdgeSnapshot -Snapshot $s.path -Token $s.token -PrivateRoot ${quoted(root)}
if (Test-Path -LiteralPath $s.path) { throw 'scratch remains' }
$lock=[IO.File]::Open(${quoted(path.join(store, 'LOCK'))},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try { $rejected=$false; try { Copy-XEdgeSnapshot -ProfileRoot ${quoted(profile)} -PrivateRoot ${quoted(root)} } catch { $rejected=$true }; if (-not $rejected) { throw 'lock ignored' } } finally { $lock.Dispose() }
[IO.File]::WriteAllText(${quoted(path.join(store, 'unexpected.txt'))}, 'foreign')
$rejected=$false; try { Copy-XEdgeSnapshot -ProfileRoot ${quoted(profile)} -PrivateRoot ${quoted(root)} } catch { $rejected=$true }
if (-not $rejected -or -not (Test-Path -LiteralPath ${quoted(path.join(store, 'unexpected.txt'))})) { throw 'unexpected input handled incorrectly' }
if (@(Get-ChildItem -LiteralPath ${quoted(root)} -Directory -Filter 'edge-snapshot-*').Count -ne 0) { throw 'failed scratch remains' }
'ok'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ok/);
});
