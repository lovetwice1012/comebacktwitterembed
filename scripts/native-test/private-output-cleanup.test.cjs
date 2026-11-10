'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('failed output cleanup marks the exclusive created handle and never removes a later replacement',
    { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-output-handle-test-'));
        t.after(async () => {
            const actual = await fs.realpath(root);
            assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
            assert.match(path.basename(actual), /^cbte-output-handle-test-[A-Za-z0-9]+$/);
            await fs.rm(actual, { recursive: true });
        });
        const script = `
$ErrorActionPreference='Stop'
. $env:CBTE_FIXTURE_NATIVE
Initialize-XSetupReaderJob
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$path=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'created.json')
$moved=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'moved.json')
$stream=[XSetupNative.ReaderJob]::CreatePrivateFile($path,$sid)
$stream.WriteByte(65)
$renameBlocked=$false
try { [IO.File]::Move($path,$moved) } catch { $renameBlocked=$true }
[XSetupNative.ReaderJob]::DeleteCreatedFile($stream)
$stream.Dispose()
$removed=-not [IO.File]::Exists($path)
[IO.File]::WriteAllText($path,'replacement')
$replacement=[IO.File]::ReadAllText($path) -ceq 'replacement'
$bad=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'invalid-acl.json')
$rejected=$false
try { $wrong=[XSetupNative.ReaderJob]::CreatePrivateFile($bad,'S-1-5-18'); $wrong.Dispose() } catch { $rejected=$true }
$badRemoved=-not [IO.File]::Exists($bad)
. $env:CBTE_FIXTURE_EXPORT
function Assert-SafePath([string]$Path) { }
$script:UserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$script:Utf8=New-Object PSObject
$script:Utf8 | Add-Member ScriptMethod GetBytes { param($text) throw 'synthetic encoding failure' }
$exportPath=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'export.json')
$exportRejected=$false
try { Write-XSetupProtectedExport -Path $exportPath -Text 'synthetic' } catch { $exportRejected=$true }
$exportRemoved=-not [IO.File]::Exists($exportPath)
$script:Utf8=New-Object Text.UTF8Encoding($false)
Write-XSetupProtectedExport -Path $exportPath -Text 'synthetic-success'
$exportSucceeded=[IO.File]::ReadAllText($exportPath) -ceq 'synthetic-success'
[ordered]@{renameBlocked=$renameBlocked;removed=$removed;replacement=$replacement;aclRejected=$rejected;badRemoved=$badRemoved;exportRejected=$exportRejected;exportRemoved=$exportRemoved;exportSucceeded=$exportSucceeded}|ConvertTo-Json -Compress
`;
        const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, CBTE_FIXTURE_ROOT: root,
                CBTE_FIXTURE_NATIVE: path.resolve(__dirname, '../../client/angelic-setup/FirefoxReader.ps1'),
                CBTE_FIXTURE_EXPORT: path.resolve(__dirname, '../../client/angelic-setup/Export-XNotificationData.ps1') } });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { renameBlocked: true, removed: true, replacement: true, aclRejected: true, badRemoved: true, exportRejected: true, exportRemoved: true, exportSucceeded: true });
    });

test('when handle cleanup fails, the partial file is retained and the user is told to check it',
    { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-output-failure-test-'));
        t.after(async () => {
            const actual = await fs.realpath(root);
            assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
            assert.match(path.basename(actual), /^cbte-output-failure-test-[A-Za-z0-9]+$/);
            await fs.rm(actual, { recursive: true });
        });
        const original = await fs.readFile(path.resolve(__dirname, '../../client/angelic-setup/FirefoxReader.ps1'), 'utf8');
        const marker = 'if(!SetFileInformationByHandle(handle,4,ref info,(uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))))throw new Win32Exception();';
        assert.equal(original.split(marker).length, 2);
        const syntheticNative = path.join(root, 'synthetic-native.ps1');
        await fs.writeFile(syntheticNative, original.replace(marker, 'throw new IOException("synthetic cleanup failure");'));
        const script = `
$ErrorActionPreference='Stop'
. $env:CBTE_FIXTURE_NATIVE
. $env:CBTE_FIXTURE_EXPORT
function Assert-SafePath([string]$Path) { }
$script:UserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$script:Utf8=New-Object PSObject
$script:Utf8 | Add-Member ScriptMethod GetBytes { param($text) throw 'synthetic encoding failure' }
$partial=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'partial.json')
$other=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'other.json')
[IO.File]::WriteAllText($other,'unrelated')
$message=''
try { Write-XSetupProtectedExport -Path $partial -Text 'synthetic' } catch { $message=$_.Exception.Message }
[ordered]@{reported=$message.Contains('保存先に途中のファイルが残っていないか確認');partialRemains=[IO.File]::Exists($partial);otherPreserved=([IO.File]::ReadAllText($other) -ceq 'unrelated')}|ConvertTo-Json -Compress
`;
        const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, CBTE_FIXTURE_ROOT: root,
                CBTE_FIXTURE_NATIVE: syntheticNative, CBTE_FIXTURE_EXPORT: path.resolve(__dirname, '../../client/angelic-setup/Export-XNotificationData.ps1') } });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { reported: true, partialRemains: true, otherPreserved: true });
    });
