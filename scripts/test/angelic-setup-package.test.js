'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { unzipSync } = require('fflate');
const { buildPackage, FILES } = require('../build-angelic-setup-package.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cleanupTasks = new WeakMap();
async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-angelic-setup-test-'));
    const tasks = []; cleanupTasks.set(t, tasks);
    t.after(async () => {
        for (const task of tasks.reverse()) await task();
        assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        assert.match(path.basename(directory), /^cbte-angelic-setup-test-/);
        await fs.rm(directory, { recursive: true, force: true });
    });
    return directory;
}
async function sourceAt(directory) {
    const source = path.join(directory, 'source');
    await fs.mkdir(source);
    for (const filename of FILES) await fs.writeFile(path.join(source, filename), `Auditable fixture ${filename}\n`);
    return source;
}
async function unpack(t, name = 'bundle') {
    const directory = await fixture(t), result = await buildPackage({ output: path.join(directory, 'preview.zip') });
    const bundle = path.join(directory, name);
    await fs.mkdir(bundle);
    const entries = unzipSync(await fs.readFile(result.path));
    for (const [filename, bytes] of Object.entries(entries)) {
        assert.equal(path.basename(filename), filename);
        await fs.writeFile(path.join(bundle, filename), bytes);
    }
    return { directory, bundle, result, script: path.join(bundle, 'Setup-XNotifications.ps1') };
}
const engines = process.platform === 'win32' ? [
    { name: 'Windows PowerShell 5.1', path: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') },
    { name: 'PowerShell 7', path: 'pwsh.exe' },
] : [];
function invoke(engine, script, args = [], env = process.env) {
    const result = spawnSync(engine.path, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { encoding: 'utf8', timeout: 20000, windowsHide: true, env });
    if (result.error) throw result.error;
    return result;
}
function invokeLaunch(engine, script, args, env, directory) {
    // A process launched by PowerShell inherits output handles. Capture to
    // ordinary files, so Node does not wait for a live GUI child's pipe EOF.
    const base = path.join(directory, `launch-output-${randomUUID()}`);
    const out = syncFs.openSync(`${base}.out`, 'wx'), err = syncFs.openSync(`${base}.err`, 'wx');
    let result;
    try {
        result = spawnSync(engine.path, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
            { timeout: 10000, windowsHide: true, env, stdio: ['ignore', out, err] });
    } finally { syncFs.closeSync(out); syncFs.closeSync(err); }
    if (result.error) throw result.error;
    return { ...result, stdout: syncFs.readFileSync(`${base}.out`, 'utf8'), stderr: syncFs.readFileSync(`${base}.err`, 'utf8') };
}
async function eventually(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail('Fixture process did not reach its expected state.');
}

test('release ZIP is deterministic and contains only allowlisted auditable source, license and exact hashes', async t => {
    const directory = await fixture(t), source = await sourceAt(directory);
    await fs.writeFile(path.join(source, 'private-key.json'), 'FAKE_SECRET_MUST_NOT_PACKAGE');
    await fs.writeFile(path.join(source, '.env'), 'FAKE_ENV_MUST_NOT_PACKAGE');
    const first = await buildPackage({ source, output: path.join(directory, 'one.zip') });
    const second = await buildPackage({ source, output: path.join(directory, 'two.zip') });
    assert.equal(first.sha256, second.sha256);
    const archive = await fs.readFile(first.path), entries = unzipSync(archive);
    assert.deepEqual(Object.keys(entries).sort(), [...FILES, 'package-manifest.json'].sort());
    assert.equal(first.sha256, hash(archive));
    assert.equal(await fs.readFile(first.checksumPath, 'utf8'), `${first.sha256}  one.zip\n`);
    const manifest = JSON.parse(Buffer.from(entries['package-manifest.json']).toString('utf8'));
    assert.equal(manifest.capabilities.realPushExport, true); assert.equal(manifest.capabilities.serverTransfer, false);
    for (const filename of FILES) assert.equal(manifest.files[filename], hash(entries[filename]));
    assert.equal(Object.values(entries).some(bytes => Buffer.from(bytes).includes('FAKE_SECRET')), false);
});

test('packager preserves existing release and checksum files and refuses incomplete or oversized sources', async t => {
    const directory = await fixture(t), source = await sourceAt(directory), output = path.join(directory, 'existing.zip');
    const first = await buildPackage({ source, output });
    await assert.rejects(buildPackage({ source, output }));
    assert.equal(hash(await fs.readFile(output)), first.sha256);
    await fs.writeFile(path.join(directory, 'blocked.zip.sha256'), 'keep');
    await assert.rejects(buildPackage({ source, output: path.join(directory, 'blocked.zip') }));
    await assert.rejects(fs.stat(path.join(directory, 'blocked.zip')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(directory, 'blocked.zip.sha256'), 'utf8'), 'keep');
    await fs.writeFile(path.join(source, FILES[0]), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(buildPackage({ source, output: path.join(directory, 'oversize.zip') }));
    await fs.unlink(path.join(source, FILES[0]));
    await assert.rejects(buildPackage({ source, output: path.join(directory, 'missing.zip') }));
    await assert.rejects(buildPackage({ source, output: path.join(directory, 'bad.exe') }));
});

test('packager rejects source and destination directory junctions without reading or replacing their targets', async t => {
    const directory = await fixture(t), source = await sourceAt(directory), link = path.join(directory, 'linked');
    await fs.symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildPackage({ source: link, output: path.join(directory, 'unsafe.zip') }));
    await assert.rejects(buildPackage({ source, output: path.join(link, 'unsafe.zip') }));
    await assert.rejects(fs.stat(path.join(source, 'unsafe.zip')), { code: 'ENOENT' });
});

if (process.platform === 'win32') test('double-click entry handles Japanese/symbol paths, starts STA PowerShell and forwards no arbitrary arguments', async t => {
    const directory = await fixture(t), source = await sourceAt(directory);
    const launcherSource = path.resolve(__dirname, '../../client/angelic-setup/ダブルクリックで開始.cmd');
    await fs.copyFile(launcherSource, path.join(source, 'ダブルクリックで開始.cmd'));
    const resultPath = path.join(directory, 'launcher-result.json');
    await fs.writeFile(path.join(source, 'Start-Setup.ps1'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`
[IO.File]::WriteAllText($env:X_SETUP_LAUNCH_RESULT,([ordered]@{apartment=[Threading.Thread]::CurrentThread.GetApartmentState().ToString();argumentCount=$args.Count;scriptDirectory=$PSScriptRoot}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
exit 0
`, 'utf8')]));
    const built = await buildPackage({ source, output: path.join(directory, 'launcher.zip') });
    const bundle = path.join(directory, '日本語 [folder] & ! $value %literal%');
    await fs.mkdir(bundle);
    for (const [name, bytes] of Object.entries(unzipSync(await fs.readFile(built.path)))) await fs.writeFile(path.join(bundle, name), bytes);
    const launched = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '""%X_SETUP_ENTRY%" ignored-user-argument"'],
        { encoding: 'utf8', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true,
            env: { ...process.env, X_SETUP_ENTRY: path.join(bundle, 'ダブルクリックで開始.cmd'), X_SETUP_LAUNCH_RESULT: resultPath } });
    if (launched.error) throw launched.error;
    assert.equal(launched.status, 0, launched.stderr);
    assert.ok(syncFs.existsSync(resultPath), `Entry output: ${launched.stdout}; ${launched.stderr}`);
    const actual = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    assert.equal(actual.apartment, 'STA'); assert.equal(actual.argumentCount, 0);
    assert.equal(actual.scriptDirectory.toLowerCase(), bundle.toLowerCase());
});

for (const engine of engines) {
    test(`${engine.name}: the real mixed-notification dialog defaults to No and accepts only an explicit Yes`, async t => {
        const packaged = await unpack(t), check = path.join(packaged.directory, 'verify-consent-dialog.ps1');
        await fs.writeFile(check, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`param([string] $Helper)
$ErrorActionPreference='Stop'
. $Helper
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class ConsentDialogProbe {
 private delegate bool WindowVisitor(IntPtr window,IntPtr state);
 [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor,IntPtr state);
 [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window,StringBuilder text,int capacity);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window,StringBuilder text,int capacity);
 public static bool IsOwnedWindow(IntPtr window) {
  uint owner;GetWindowThreadProcessId(window,out owner);
  return owner==(uint)Process.GetCurrentProcess().Id;
 }
 public static IntPtr FindOwnedDialog(string title) {
  IntPtr result=IntPtr.Zero;
  EnumWindows(delegate(IntPtr window,IntPtr state) {
   if(!IsOwnedWindow(window))return true;
   var windowClass=new StringBuilder(128);var windowTitle=new StringBuilder(256);
   GetClassName(window,windowClass,windowClass.Capacity);GetWindowText(window,windowTitle,windowTitle.Capacity);
   if(windowClass.ToString()=="#32770" && windowTitle.ToString()==title){result=window;return false;}
   return true;
  },IntPtr.Zero);
  return result;
 }
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
}
'@
foreach($answer in @(7,6)){
 $script:DialogSeen=$false;$script:DefaultButton=0;$script:AnswerId=$answer
 $timer=New-Object Windows.Forms.Timer;$timer.Interval=50
 $timer.Add_Tick({
  # Match this test PowerShell process before reading or sending a message.
  # Another user's exporter confirmation must never be selected by its caption.
  $window=[ConsentDialogProbe]::FindOwnedDialog('ほかのサイトの通知について')
  if($window -eq [IntPtr]::Zero){return}
  if(-not [ConsentDialogProbe]::IsOwnedWindow($window)){return}
  $script:DialogSeen=$true
  $script:DefaultButton=([ConsentDialogProbe]::SendMessage($window,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -band 65535)
  $null=[ConsentDialogProbe]::PostMessage($window,0x111,[IntPtr]$script:AnswerId,[IntPtr]::Zero)
  $timer.Stop()
 })
 try{
  $timer.Start()
  $accepted=Show-XSetupOtherNotificationsConsent 'Synthetic local dialog test. No network or profile is used.'
  if(-not $script:DialogSeen -or $script:DefaultButton -ne 7){throw 'The real consent dialog did not default to No'}
  if($accepted -ne ($answer -eq 6)){throw 'The dialog decision was ignored'}
 } finally {$timer.Stop();$timer.Dispose()}
}
Write-Output 'native-consent-dialog-pass'
`, 'utf8')]));
        const result = invoke(engine, check, [path.join(packaged.bundle, 'Export-XNotificationData.ps1')]);
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /native-consent-dialog-pass/);
    });

    test(`${engine.name}: mixed-notification consent is explicit, local, bounded and never authorizes foreign use`, async t => {
        const packaged = await unpack(t), check = path.join(packaged.directory, 'verify-consent.ps1');
        await fs.writeFile(check, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`param([string] $Helper)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. $Helper
$script:PromptCount=0; $script:LastMessage=''; $script:Answer=$false
function Show-XSetupOtherNotificationsConsent {param([string] $Message) $script:PromptCount++; $script:LastMessage=$Message; return $script:Answer}
Confirm-XSetupOtherNotifications -OtherSubscriptionCount 0 -PromptForOtherNotifications
if($script:PromptCount -ne 0){throw 'Unmixed data prompted'}
foreach($invalid in @($null,'0',0.0,-1,64,[decimal]1)){
 $rejected=$false
 try{Confirm-XSetupOtherNotifications -OtherSubscriptionCount $invalid -AllowOtherNotifications}catch{if($_.Exception.Message -notmatch '^X_SETUP_READER_FAILED:'){throw};$rejected=$true}
 if(-not $rejected){throw 'Invalid metadata silently became zero'}
}
$rejected=$false
try{Confirm-XSetupOtherNotifications -OtherSubscriptionCount 1}catch{if($_.Exception.Message -notmatch '^X_SETUP_OTHER_NOTIFICATIONS_CONSENT_REQUIRED:'){throw};$rejected=$true}
if(-not $rejected -or $script:PromptCount -ne 0){throw 'CLI implicitly consented or opened a dialog'}
try{Confirm-XSetupOtherNotifications -OtherSubscriptionCount 1 -PromptForOtherNotifications;throw 'No was accepted'}catch{if($_.Exception.Message -notmatch '^X_SETUP_EXPORT_CANCELLED:'){throw}}
if($script:PromptCount -ne 1){throw 'Missing final prompt'}
foreach($word in @('X以外','X用の通知情報と鍵だけ','共通','暗号化された通知データや識別情報','サーバー','届く可能性','保存・復号・利用せず','受信時に破棄','技術的には取得・保存','別途、明確な許可','後からFirefox')){if(-not $script:LastMessage.Contains($word)){throw 'Incomplete consent explanation'}}
$script:Answer=$true
Confirm-XSetupOtherNotifications -OtherSubscriptionCount 63 -PromptForOtherNotifications
if($script:PromptCount -ne 2 -or -not $script:LastMessage.Contains('63')){throw 'Explicit Yes did not accept the reviewed count'}
Confirm-XSetupOtherNotifications -OtherSubscriptionCount 1 -AllowOtherNotifications
if($script:PromptCount -ne 2){throw 'Explicit CLI acknowledgement unexpectedly prompted'}
# A previous acknowledgement must not become a persistent default.
try{Confirm-XSetupOtherNotifications -OtherSubscriptionCount 1;throw 'Consent persisted'}catch{if($_.Exception.Message -notmatch '^X_SETUP_OTHER_NOTIFICATIONS_CONSENT_REQUIRED:'){throw}}
Write-Output 'mixed-consent-contract-pass'
`, 'utf8')]));
        const result = invoke(engine, check, [path.join(packaged.bundle, 'Export-XNotificationData.ps1')]);
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /mixed-consent-contract-pass/);
        assert.match(result.stderr, /サーバー/);
        assert.deepEqual((await fs.readdir(packaged.directory)).sort(), ['bundle', 'preview.zip', 'preview.zip.sha256', 'verify-consent.ps1'].sort(), 'Consent alone creates no output file or profile');
    });

    test(`${engine.name}: distributed script status, preview, ownership and failure boundaries`, async t => {
        const packaged = await unpack(t, 'unpacked folder & literal $value');
        const privateRoot = path.join(packaged.directory, 'private folder & literal $value');
        const status = invoke(engine, packaged.script, ['-Action', 'Status', '-PrivateRoot', privateRoot]);
        assert.equal(status.status, 0, status.stderr);
        const unprepared = JSON.parse(status.stdout.trim().replace(/^\uFEFF/, ''));
        assert.equal(unprepared.prepared, false);
        assert.equal(unprepared.capabilities.realPushExport, true);
        assert.equal(unprepared.capabilities.serverTransfer, false);
        await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' });
        const preview = invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', privateRoot, '-WhatIf']);
        assert.equal(preview.status, 0, preview.stderr);
        await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' });
        for (const [action, code, text] of [['Export', 5, 'X_SETUP_OUTPUT_REQUIRED'], ['Transfer', 6, 'X_SETUP_TRANSFER_NOT_AVAILABLE']]) {
            const result = invoke(engine, packaged.script, ['-Action', action, '-PrivateRoot', privateRoot]);
            assert.equal(result.status, code, result.stderr);
            assert.ok((result.stdout + result.stderr).includes(text));
            await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' });
        }
        const prepared = invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', privateRoot]);
        assert.equal(prepared.status, 0, prepared.stderr);
        const before = await fs.readFile(path.join(privateRoot, 'owner.json'));
        const prepare = invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', privateRoot]);
        assert.equal(prepare.status, 0, prepare.stderr);
        assert.deepEqual(await fs.readFile(path.join(privateRoot, 'owner.json')), before);
        const after = invoke(engine, packaged.script, ['-Action', 'Status', '-PrivateRoot', privateRoot]);
        assert.equal(after.status, 0, after.stderr); assert.equal(JSON.parse(after.stdout).prepared, true);
        const foreign = path.join(packaged.directory, 'foreign-profile');
        await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'sentinel'), 'keep');
        assert.equal(invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', foreign]).status, 3);
        assert.equal(await fs.readFile(path.join(foreign, 'sentinel'), 'utf8'), 'keep');
        const ownPackage = invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', packaged.bundle]);
        assert.equal(ownPackage.status, 3);
        const executable = invoke(engine, packaged.script, ['-Action', 'OpenFirefox', '-PrivateRoot', privateRoot, '-FirefoxPath', path.join(packaged.directory, 'absent.exe')]);
        assert.equal(executable.status, 4);
        const linked = path.join(packaged.directory, 'junction-profile');
        await fs.symlink(foreign, linked, 'junction');
        assert.equal(invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', path.join(linked, 'new-root')]).status, 3);
        await assert.rejects(fs.stat(path.join(foreign, 'new-root')), { code: 'ENOENT' });
    });

    test(`${engine.name}: altered, missing or extra package files block mutations before profile creation`, async t => {
        const packaged = await unpack(t), privateRoot = path.join(packaged.directory, 'must-not-exist');
        const readme = path.join(packaged.bundle, 'README-ja.md'), original = await fs.readFile(readme);
        await fs.appendFile(readme, '\nchanged');
        assert.equal(invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', privateRoot]).status, 2);
        await fs.writeFile(readme, original);
        await fs.writeFile(path.join(packaged.bundle, 'unexpected.ps1'), 'throw "must not execute"');
        assert.equal(invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', privateRoot]).status, 2);
        await fs.unlink(path.join(packaged.bundle, 'unexpected.ps1'));
        await fs.unlink(readme);
        assert.equal(invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', privateRoot]).status, 2);
        await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' });
    });

    test(`${engine.name}: double-click window explains manual upload, distinguishes readiness from file success, and prevents overlapping work`, async t => {
        const packaged = await unpack(t), privateRoot = path.join(packaged.directory, 'not-created-by-window');
        const verifyScript = path.join(packaged.directory, 'verify-window.ps1');
        await fs.writeFile(verifyScript, `param([string] $GuiPath,[string] $OwnRoot)
$ErrorActionPreference='Stop'
. $GuiPath
Assert-Distribution
$form=New-SetupForm -RootPath $OwnRoot
try {
 $form.CreateControl(); $form.PerformLayout()
 $export=$form.Controls.Find('ExportButton',$true)[0]
 $open=$form.Controls.Find('OpenFirefoxButton',$true)[0]
 $folder=$form.Controls.Find('FolderButton',$true)[0]
 if($export.Enabled -or $open.Enabled -or $folder.Enabled){throw 'Unprepared controls are enabled'}
 $intro=$form.Controls.Find('IntroductionLabel',$true)[0].Text
 $limitation=$form.Controls.Find('LimitationLabel',$true)[0].Text
 if($intro -notmatch 'ファイル' -or $intro -notmatch 'ご自身' -or $intro -notmatch '送信'){throw 'Missing file/manual-upload explanation'}
 if($limitation -notmatch '確認|未対応|まだ利用でき|まだ使え'){throw 'Missing initial-state explanation'}
 if($form.Text -match 'Angelic|Angel'){throw 'Unrequested branding in title'}
 Update-ReadyState ([pscustomobject]@{appId='x-notification-setup';version='0.1.0-preview.4';packageVerified=$true;prepared=$true;privateRoot=$OwnRoot;profilePath=($OwnRoot+'\\firefox-profile');capabilities=[pscustomobject]@{prepareProfile=$true;openFirefox=$true;realPushExport=$true;serverTransfer=$false}})
 if(-not $export.Enabled -or $folder.Enabled -or -not $open.Enabled){throw 'Readiness was confused with file success'}
 if($form.Controls.Find('LimitationLabel',$true)[0].Text -notmatch 'ご自身|自分|本人'){throw 'Missing manual upload instruction'}
 Set-BusyState $true
 foreach($name in @('PrepareButton','OpenFirefoxButton','ExportButton','FolderButton','ReadHelpButton','ChooseFirefoxButton','CloseButton')){if($form.Controls.Find($name,$true)[0].Enabled){throw 'Overlapping operation allowed'}}
 $closing=New-Object Windows.Forms.FormClosingEventArgs([Windows.Forms.CloseReason]::UserClosing,$false)
 $method=[Windows.Forms.Form].GetMethod('OnFormClosing',[Reflection.BindingFlags]'Instance,NonPublic')
 $closingArgs=New-Object object[] 1; $closingArgs.SetValue($closing.PSObject.BaseObject,0)
 $null=$method.Invoke($form,$closingArgs)
 if(-not $closing.Cancel){throw 'Closing interrupted private-data cleanup'}
 Set-BusyState $false
 if(-not $export.Enabled -or -not $open.Enabled){throw 'Ready controls did not recover'}
 $form.Size=New-Object Drawing.Size(780,696);$form.PerformLayout()
 $footer=$form.Controls.Find('CloseButton',$true)[0].Parent
 if($footer.Bottom -gt $form.ClientSize.Height+1){throw 'Footer escaped the small screen'}
 $fakeBrowser=Join-Path ([IO.Path]::GetDirectoryName($OwnRoot)) 'firefox.exe'
 [IO.File]::WriteAllText($fakeBrowser,'Synthetic selector fixture, never executed.')
 Set-SelectedFirefox $fakeBrowser
 if($script:FirefoxPath -cne $fakeBrowser){throw 'Browser choice did not persist'}
 if([IO.Directory]::Exists($OwnRoot)){throw 'Showing instructions changed the PC'}
 Write-Output 'window-contract-pass'
} finally {$form.Dispose()}
`, 'utf8');
        // Use BOM so the Japanese assertions also parse in Windows PowerShell.
        const body = await fs.readFile(verifyScript);
        await fs.writeFile(verifyScript, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
        const result = invoke(engine, verifyScript, [path.join(packaged.bundle, 'Start-Setup.ps1'), privateRoot]);
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /window-contract-pass/);
        await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' });
    });

    test(`${engine.name}: literal launch arguments, process identity, WhatIf and stale/active profile locks`, async t => {
        const packaged = await unpack(t), privateRoot = path.join(packaged.directory, 'literal [profile] & $value');
        const stubDirectory = path.join(packaged.directory, 'offline [Firefox] & $value');
        await fs.mkdir(stubDirectory);
        const executable = path.join(stubDirectory, 'firefox.exe');
        const compileScript = path.join(packaged.directory, 'compile-fixture.ps1');
        await fs.writeFile(compileScript, `param([string] $OutputExe)
$source = @'
using System;
using System.IO;
using System.Threading;
public class OfflineFirefoxFixture {
    [STAThread] public static void Main(string[] args) {
        File.WriteAllLines(Environment.GetEnvironmentVariable("ANGELIC_FIXTURE_ARGS"), args);
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (!File.Exists(Environment.GetEnvironmentVariable("ANGELIC_FIXTURE_RELEASE")) && DateTime.UtcNow < deadline) Thread.Sleep(20);
    }
}
'@
Add-Type -TypeDefinition $source -OutputAssembly $OutputExe -OutputType WindowsApplication -ErrorAction Stop
`, 'utf8');
        // Add-Type's OutputAssembly resolves wildcard syntax in PowerShell 5.1;
        // compile in a plain path, then copy with literal Node filesystem APIs.
        const compiledExe = path.join(packaged.directory, 'compiled-fixture.exe');
        const compiled = invoke(engines[0], compileScript, [compiledExe]);
        assert.equal(compiled.status, 0, compiled.stderr);
        await fs.copyFile(compiledExe, executable);
        const prepare = invoke(engine, packaged.script, ['-Action', 'Prepare', '-PrivateRoot', privateRoot]);
        assert.equal(prepare.status, 0, prepare.stderr);
        const argumentsFile = path.join(packaged.directory, 'arguments.txt'), release = path.join(packaged.directory, 'release');
        const env = { ...process.env, ANGELIC_FIXTURE_ARGS: argumentsFile, ANGELIC_FIXTURE_RELEASE: release };
        cleanupTasks.get(t).push(async () => { await fs.writeFile(release, 'stop'); await new Promise(resolve => setTimeout(resolve, 100)); });
        const launchArgs = ['-Action', 'OpenFirefox', '-PrivateRoot', privateRoot, '-FirefoxPath', executable];
        const preview = invoke(engine, packaged.script, [...launchArgs, '-WhatIf'], env);
        assert.equal(preview.status, 0, preview.stderr);
        await assert.rejects(fs.stat(argumentsFile), { code: 'ENOENT' });
        const started = invokeLaunch(engine, packaged.script, launchArgs, env, packaged.directory);
        assert.equal(started.status, 0, started.stderr);
        await eventually(async () => { try { return (await fs.readFile(argumentsFile, 'utf8')).length > 0; } catch { return false; } });
        assert.deepEqual((await fs.readFile(argumentsFile, 'utf8')).trim().split(/\r?\n/), ['-no-remote', '-profile', path.join(privateRoot, 'firefox-profile'), 'https://x.com/']);
        assert.equal(JSON.parse(started.stdout).firefoxActive, true);
        assert.equal(invoke(engine, packaged.script, launchArgs, env).status, 4);
        await fs.writeFile(release, 'stop');
        await eventually(async () => !JSON.parse(invoke(engine, packaged.script, ['-Action', 'Status', '-PrivateRoot', privateRoot]).stdout).firefoxActive);
        // A stale lock file is expected after normal Firefox shutdown.
        const lockFile = path.join(privateRoot, 'firefox-profile', 'parent.lock');
        await fs.writeFile(lockFile, 'fixture lock contents must remain untouched');
        const stale = invoke(engine, packaged.script, ['-Action', 'Status', '-PrivateRoot', privateRoot]);
        assert.equal(stale.status, 0, stale.stderr); assert.equal(JSON.parse(stale.stdout).profileLocked, false);
        assert.equal(invoke(engine, packaged.script, [...launchArgs, '-WhatIf'], env).status, 0);

        const holdScript = path.join(packaged.directory, 'hold-fixture-lock.ps1');
        const ready = path.join(packaged.directory, 'lock-ready'), unlock = path.join(packaged.directory, 'unlock');
        await fs.writeFile(holdScript, `param([string] $LockPath,[string] $ReadyPath,[string] $ReleasePath)
$held=[IO.File]::Open($LockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
try {
 [IO.File]::WriteAllText($ReadyPath,'ready')
 $end=[DateTime]::UtcNow.AddSeconds(15)
 while(-not [IO.File]::Exists($ReleasePath) -and [DateTime]::UtcNow -lt $end){Start-Sleep -Milliseconds 20}
} finally {$held.Dispose()}
`, 'utf8');
        const locker = spawn(engine.path, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', holdScript, lockFile, ready, unlock], { windowsHide: true, stdio: 'ignore' });
        cleanupTasks.get(t).push(async () => { await fs.writeFile(unlock, 'stop'); await new Promise(resolve => locker.exitCode !== null ? resolve() : locker.once('exit', resolve)); });
        await eventually(async () => { try { await fs.stat(ready); return true; } catch { return false; } });
        const active = invoke(engine, packaged.script, ['-Action', 'Status', '-PrivateRoot', privateRoot]);
        assert.equal(active.status, 0, active.stderr); assert.equal(JSON.parse(active.stdout).profileLocked, true);
        assert.equal(invoke(engine, packaged.script, launchArgs, env).status, 4);
        await fs.writeFile(unlock, 'stop');
        await new Promise(resolve => locker.exitCode !== null ? resolve() : locker.once('exit', resolve));
        assert.equal(await fs.readFile(lockFile, 'utf8'), 'fixture lock contents must remain untouched');
    });
}
