'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Exercise the real export coordinator with an offline reader double. The
// actual Gecko storage/key checks live in x-notification-reader.test.js and the
// opt-in native test; this test verifies the save/cleanup/consent ordering.
if (process.platform === 'win32') for (const engine of [
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'pwsh.exe',
]) test(`${path.basename(engine)}: the reviewed snapshot is saved only after cleanup and explicit mixed-notification consent`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-x-export-consent-'));
    t.after(async () => {
        assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        assert.match(path.basename(directory), /^cbte-x-export-consent-/);
        await fs.rm(directory, { recursive: true, force: true });
    });
    const script = path.join(directory, 'verify-export-consent.ps1');
    await fs.writeFile(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`param([string] $Helper,[string] $TestDirectory)
$ErrorActionPreference='Stop'; Set-StrictMode -Version 2
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$script:Utf8=New-Object Text.UTF8Encoding($false)
$script:Root=Join-Path $TestDirectory 'private'
$script:ProfilePath=Join-Path $script:Root 'firefox-profile'
$script:PackageRoot=Join-Path $TestDirectory 'package'
$script:AppId='x-notification-setup'
$script:UserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$script:SystemSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$null=[IO.Directory]::CreateDirectory($script:ProfilePath)
$null=[IO.Directory]::CreateDirectory($script:PackageRoot)
[IO.File]::WriteAllText((Join-Path $script:ProfilePath 'parent.lock'),'synthetic lock')
$script:Owner=[pscustomobject]@{profileId='synthetic-only'}
$script:Answer=$false; $script:Prompts=0; $script:Count=1; $script:SourceLabel='reviewed'
$script:Destination=''
. $Helper
Add-Type -TypeDefinition @'
namespace XSetupNative {public class ReaderJob {public static bool SupportsPrivateAcl(string path){return true;}}}
'@
function Assert-SafePath {param([string] $Path) if(-not [IO.Path]::GetFullPath($Path).StartsWith($TestDirectory+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Test path escaped'}}
function Get-LocalPath {param([string] $Value) Assert-SafePath $Value;return [IO.Path]::GetFullPath($Value)}
function Get-PathAttributes {param([string] $Path) if([IO.File]::Exists($Path)-or [IO.Directory]::Exists($Path)){return [IO.File]::GetAttributes($Path)};return $null}
function Test-InPath {param([string] $Path,[string] $Root) return $Path.StartsWith($Root+'\\',[StringComparison]::OrdinalIgnoreCase)}
function Initialize-XSetupReaderJob {}
function Assert-PropertyNames {param($Value,[string[]] $Names) $actual=@($Value.PSObject.Properties.Name);if($actual.Count -ne $Names.Count){throw 'Unexpected DTO fields'};foreach($name in $actual){if($name -notin $Names){throw 'Unexpected DTO field'}}}
function Get-Owner {return $script:Owner}
function Get-LaunchState {param($Owner) return [pscustomobject]@{active=$false;locked=$false}}
function Write-NewJson {param([string] $Path,$Object) [IO.File]::WriteAllText($Path,($Object|ConvertTo-Json -Depth 12),$script:Utf8)}
function Read-SmallJson {param([string] $Path,[int] $Limit=65536) return ([IO.File]::ReadAllText($Path)|ConvertFrom-Json)}
function Get-XSetupOwnedUaid {return '22222222222242228222222222222222'}
function Copy-XSetupPushSnapshot {param([string] $Profile) $script:Snapshot=$script:SourceLabel}
function Copy-XSetupFirefoxApplication {param([string] $Executable,[string] $Destination) $null=[IO.Directory]::CreateDirectory($Destination);return 'synthetic-reader-never-executed'}
function Write-XSetupReaderConfiguration {
 param([string] $Application,[string] $Profile,[string] $ResultPath,[string] $Uaid)
 $fake=[ordered]@{ok=$true;export=[ordered]@{format='x-notification-subscription';version=1;syntheticLabel=$script:Snapshot};otherSubscriptionCount=$script:Count}
 Write-NewJson $ResultPath $fake
}
function Start-XSetupReaderJob {
 param($Executable,$Profile)
 $job=New-Object psobject
 $job|Add-Member ScriptMethod WaitForExit {param($Timeout) return $true}
 $job|Add-Member ScriptMethod Stop {}
 $job|Add-Member ScriptMethod Dispose {}
 return $job
}
function Assert-NoScratch {if(@([IO.Directory]::GetDirectories($script:Root,'export-scratch-*')).Count -ne 0){throw 'Consent happened before private scratch cleanup'}}
function Show-XSetupOtherNotificationsConsent {
 param([string] $Message)
 Assert-NoScratch
 if([IO.File]::Exists($script:Destination)){throw 'Output existed before consent'}
 if(-not $Message.Contains('1 件')){throw 'Wrong snapshot count reviewed'}
 $script:Prompts++
 # Simulate a later profile change. The already-reviewed snapshot must be saved.
 $script:SourceLabel='changed-after-review'
 return $script:Answer
}
function Write-XSetupProtectedExport {param([string] $Path,[string] $Text) Assert-NoScratch; $stream=[IO.File]::Open($Path,'CreateNew','Write','None');try{$bytes=$script:Utf8.GetBytes($Text);$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}
function Run-Case {param([string] $Name,[switch] $Prompt,[switch] $Allow)
 $script:Destination=Join-Path $TestDirectory ($Name+'.json')
 return (Invoke-XSetupExport -Owner $script:Owner -OutputPath $script:Destination -FirefoxExecutable 'synthetic-only' -PromptForOtherNotifications:$Prompt -AllowOtherNotifications:$Allow)
}
try{Run-Case 'missing-consent';throw 'Implicit consent accepted'}catch{if($_.Exception.Message -notmatch '^X_SETUP_OTHER_NOTIFICATIONS_CONSENT_REQUIRED:'){throw}}
Assert-NoScratch;if([IO.File]::Exists($script:Destination)){throw 'Missing consent created an output'}
try{Run-Case 'declined' -Prompt;throw 'Declined consent accepted'}catch{if($_.Exception.Message -notmatch '^X_SETUP_EXPORT_CANCELLED:'){throw}}
Assert-NoScratch;if([IO.File]::Exists($script:Destination)){throw 'No created an output'}
$script:Answer=$true;$script:SourceLabel='reviewed'
$saved=Run-Case 'accepted' -Prompt
if(-not $saved.fileCreated){throw 'Yes did not create a file'}
$document=[IO.File]::ReadAllText($script:Destination)|ConvertFrom-Json
if($document.syntheticLabel -cne 'reviewed'){throw 'A different snapshot replaced the reviewed data'}
if($document.PSObject.Properties.Name -contains 'otherSubscriptionCount'){throw 'Local warning metadata leaked into export'}
$saved=Run-Case 'explicit-cli' -Allow
if(-not $saved.fileCreated -or $script:Prompts -ne 2){throw 'CLI acknowledgement did not remain explicit'}
$script:Count=0;$saved=Run-Case 'only-x'
if(-not $saved.fileCreated -or $script:Prompts -ne 2){throw 'X-only export unexpectedly prompted'}
foreach($bad in @($null,'0',64,-1)){
 $script:Count=$bad
 try{Run-Case ('bad-'+[Guid]::NewGuid().ToString('N')) -Allow;throw 'Invalid count was accepted'}catch{if($_.Exception.Message -notmatch '^X_SETUP_READER_FAILED:'){throw}}
 Assert-NoScratch;if([IO.File]::Exists($script:Destination)){throw 'Invalid metadata created an output'}
}
Write-Output 'export-consent-order-pass'
`, 'utf8')]));
    const actual = spawnSync(engine, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
        path.resolve(__dirname, '../../client/angelic-setup/Export-XNotificationData.ps1'), directory],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (actual.error) throw actual.error;
    assert.equal(actual.status, 0, actual.stderr); assert.match(actual.stdout, /export-consent-order-pass/);
});
