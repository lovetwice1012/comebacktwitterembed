'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('Edge export requires consent, preserves existing files, and writes a private local file', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
    const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cbte-edge-export-test-'));
    t.after(() => { const checked = fs.realpathSync(root); assert.equal(path.dirname(checked).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(checked), /^cbte-edge-export-test-/); fs.rmSync(checked, { recursive: true }); });
    const pkg = path.join(root, 'package'), owned = path.join(root, 'owned'), profile = path.join(owned, 'edge-profile');
    const store = path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'); fs.mkdirSync(store, { recursive: true }); fs.mkdirSync(pkg);
    for (const name of ['LOCK', 'CURRENT', '000001.log']) fs.writeFileSync(path.join(store, name), name);
    const source = path.resolve(__dirname, '../../client/angelic-setup');
    for (const [from, to] of [['EdgeExport.ps1','EdgeExport.ps1'], ['EdgeSnapshot.ps1','EdgeSnapshot.ps1'], ['FirefoxReader.ps1','NativeSetup.ps1']]) fs.copyFileSync(path.join(source, from), path.join(pkg, to));
    const quoted = s => `'${s.replace(/'/g, "''")}'`, output = path.join(root, 'notification.json'), existing = path.join(root, 'existing.json');
    fs.writeFileSync(existing, 'preserve');
    const script = `$ErrorActionPreference='Stop'
$script:Root=${quoted(owned)}; $script:Profile=${quoted(profile)}; $script:PackageRoot=${quoted(pkg)}
$script:Utf8=New-Object Text.UTF8Encoding($false); $script:UserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
function Fail-Safely([string]$code,[string]$message) { throw ($code+': '+$message) }
function Get-LocalPath([string]$p) { [IO.Path]::GetFullPath($p) }
function Assert-SafePath([string]$p) { if (-not $p.StartsWith(${quoted(root)},[StringComparison]::OrdinalIgnoreCase)) { throw 'outside' } }
function Test-InPath([string]$p,[string]$parent) { $p.StartsWith($parent+'\\',[StringComparison]::OrdinalIgnoreCase) }
function Get-PathAttributes([string]$p) { if (Test-Path -LiteralPath $p) { [IO.File]::GetAttributes($p) } else { $null } }
function Write-NewJson([string]$p,$v) { [IO.File]::WriteAllText($p,($v|ConvertTo-Json -Compress)) }
function Read-SmallJson([string]$p) { [IO.File]::ReadAllText($p)|ConvertFrom-Json }
function Assert-PropertyNames($o,[string[]]$n) { if (@($o.PSObject.Properties).Count -ne $n.Count) { throw 'bad marker' } }
$script:readerMismatch=$false
function Invoke-Helper([string]$name,$inputObject) { if ($name -cne 'EdgeReader.cjs') { throw 'wrong reader' }; return [pscustomobject]@{ ok=$true; file=[pscustomobject]@{version=3;provenance=[pscustomobject]@{kind='edge-wns'};value='fixture'}; otherSubscriptionCount=0;unclassifiedRecordCount=1;otherNotificationsPossible=(-not $script:readerMismatch) } }
. ${quoted(path.join(pkg, 'EdgeExport.ps1'))}
$capture=[pscustomobject]@{ scope='https://x.com/'; endpoint='https://fixture';applicationServerKey='fixture';keys=[pscustomobject]@{p256dh='fixture';auth='fixture'} }
$agent=[pscustomobject]@{}; $client=[pscustomobject]@{}
$badVersion=$false; try { Export-XEdgeTransfer -Capture $capture -Agent $agent -Client $client -ConnectVersion '3' -BrowserVersion '157.0.0.1' -OutputPath ${quoted(output)} -AllowOtherNotifications } catch { $badVersion=$_.Exception.Message -like 'X_EDGE_CALIBRATION_FAILED:*' }
if (-not $badVersion -or (Test-Path -LiteralPath ${quoted(output)})) { throw 'unknown connect version accepted' }
$rejected=$false; try { Export-XEdgeTransfer -Capture $capture -Agent $agent -Client $client -BrowserVersion '157.0.0.1' -OutputPath ${quoted(output)} } catch { $rejected=$_.Exception.Message -like 'X_EDGE_OTHER_CONSENT_REQUIRED:*' }
if (-not $rejected -or (Test-Path -LiteralPath ${quoted(output)})) { throw 'consent bypassed' }
if (@(Get-ChildItem -LiteralPath $script:Root -Directory -Filter 'edge-snapshot-*').Count -ne 0) { throw 'scratch remains' }
$script:readerMismatch=$true; $rejected=$false
try { Export-XEdgeTransfer -Capture $capture -Agent $agent -Client $client -BrowserVersion '157.0.0.1' -OutputPath ${quoted(output)} -AllowOtherNotifications } catch { $rejected=$_.Exception.Message -like 'X_EDGE_READER_FAILED:*' }
if (-not $rejected -or (Test-Path -LiteralPath ${quoted(output)})) { throw 'inconsistent reader result accepted' }; $script:readerMismatch=$false
$rejected=$false; try { Export-XEdgeTransfer -Capture $capture -Agent $agent -Client $client -BrowserVersion '157.0.0.1' -OutputPath ${quoted(existing)} -AllowOtherNotifications } catch { $rejected=$true }
if (-not $rejected -or [IO.File]::ReadAllText(${quoted(existing)}) -cne 'preserve') { throw 'existing file changed' }
Export-XEdgeTransfer -Capture $capture -Agent $agent -Client $client -BrowserVersion '157.0.0.1' -OutputPath ${quoted(output)} -AllowOtherNotifications
$saved=[IO.File]::ReadAllText(${quoted(output)}) | ConvertFrom-Json
if ($saved.version -ne 3 -or $saved.value -cne 'fixture') { throw 'wrong output' }
'ok'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ok/);
});
