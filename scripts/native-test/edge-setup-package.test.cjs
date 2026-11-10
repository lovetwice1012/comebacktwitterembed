'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const { buildArchive } = require('../build-edge-setup-package.cjs');
const { buildArchive: buildChromeArchive } = require('../build-chrome-setup-package.cjs');
test('Edge distribution protects its profile, refuses tampering and preserves existing files', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-package-test-'));
    t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-edge-package-test-/); await fs.rm(actual, { recursive: true }); });
    const bundle = path.join(root, '配布 & fixture'), owned = path.join(root, '専用 & fixture'); await fs.mkdir(bundle);
    const built = await buildArchive({ nodeExecutable: process.execPath }), entries = unzipSync(built.archive);
    for (const [name, bytes] of Object.entries(entries)) {
        assert.match(name, /^(?:_app\/)?[^/\\]+$/); const file = path.join(bundle, name);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
    }
    const app = path.join(bundle, '_app'), powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const invoke = args => {
        const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'EdgeSetup.ps1'), ...args],
            { encoding: 'utf8', windowsHide: true, timeout: 30000 });
        if (result.error) throw result.error; return { ...result, data: JSON.parse(result.stdout) };
    };
    const initial = invoke(['-Action', 'Status', '-PrivateRoot', owned]); assert.equal(initial.status, 0); assert.equal(initial.data.prepared, false);
    const prepared = invoke(['-Action', 'Prepare', '-PrivateRoot', owned]); assert.equal(prepared.status, 0); assert.equal(prepared.data.prepared, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(owned, 'browser.json'), 'utf8')).browser, 'edge');
    const existing = path.join(root, 'existing.json'); await fs.writeFile(existing, 'preserve');
    const output = invoke(['-Action', 'Export', '-PrivateRoot', owned, '-OutputPath', existing]);
    assert.equal(output.status, 1); assert.match(output.data.message, /^X_EDGE_OUTPUT_INVALID:/); assert.equal(await fs.readFile(existing, 'utf8'), 'preserve');
    const foreign = path.join(root, 'foreign'); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep.txt'), 'keep');
    assert.equal(invoke(['-Action', 'Prepare', '-PrivateRoot', foreign]).status, 1); assert.equal(await fs.readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'keep');
    const uiLocal = path.join(root, 'ui-local'); await fs.mkdir(uiLocal);
    const quoted = value => `'${value.replace(/'/g, "''")}'`, uiFile = path.join(app, 'Start-EdgeSetup.ps1');
    const launchUi = `$info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=${quoted(powershell)}
$info.Arguments='-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "'+${quoted(uiFile)}+'"';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.EnvironmentVariables['LOCALAPPDATA']=${quoted(uiLocal)};$p=[Diagnostics.Process]::Start($info);$p.Id;$p.Dispose()`;
    const launchedUi = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launchUi, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(launchedUi.status, 0, launchedUi.stderr); const uiPid = Number(launchedUi.stdout.trim()); assert(Number.isInteger(uiPid) && uiPid > 4);
    try {
        const inspect = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes
$p=Get-Process -Id ${uiPid};try{for($i=0;$i -lt 100 -and $p.MainWindowHandle -eq 0;$i++){Start-Sleep -Milliseconds 100;$p.Refresh()}
if($p.MainWindowHandle -eq 0){throw 'window missing'};$w=[Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
if($w.Current.Name -cne 'X 通知の準備'){throw 'unexpected window'};$bounds=$w.Current.BoundingRectangle
$all=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition);$names=New-Object 'Collections.Generic.List[string]'
for($i=0;$i -lt $all.Count;$i++){$a=$all.Item($i);$r=$a.Current.BoundingRectangle;if(-not $r.IsEmpty -and ($r.Left -lt $bounds.Left -or $r.Top -lt $bounds.Top -or $r.Right -gt $bounds.Right -or $r.Bottom -gt $bounds.Bottom)){throw 'control outside window'};$names.Add($a.Current.Name)}
[ordered]@{names=@($names)}|ConvertTo-Json -Compress;$null=$p.CloseMainWindow();if(-not $p.WaitForExit(5000)){throw 'window did not close'}
}finally{$p.Dispose()}`;
        const snapshot = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspect, 'utf16le').toString('base64')],
            { encoding: 'utf8', windowsHide: true, timeout: 20000 });
        assert.equal(snapshot.status, 0, snapshot.stderr); const names = JSON.parse(snapshot.stdout).names;
        assert(names.includes('設定用 Edge を開く')); assert(names.includes('通知データを保存'));
    } finally {
        const cleanup = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${uiPid}' -ErrorAction SilentlyContinue
if($null -ne $p){if($p.Name -ine 'powershell.exe' -or $p.CommandLine -notlike ${quoted('*' + uiFile + '*')}){throw 'unexpected process'};$p=Get-Process -Id ${uiPid};try{$null=$p.CloseMainWindow();if(-not $p.WaitForExit(5000)){$p.Kill();$p.WaitForExit()}}finally{$p.Dispose()}}`;
        const closed = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')],
            { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(closed.status, 0, closed.stderr);
    }
    await fs.appendFile(path.join(app, 'EdgeCapture.cjs'), '\n// modified\n');
    const bad = invoke(['-Action', 'Status', '-PrivateRoot', path.join(root, 'new-owned')]);
    assert.equal(bad.status, 1); assert.match(bad.data.message, /^X_EDGE_PACKAGE_INVALID:/);
    await assert.rejects(fs.stat(path.join(root, 'new-owned')), { code: 'ENOENT' });
});
test('Chrome package built from shared setup code still prepares its own profile', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-chrome-shared-test-'));
    t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-chrome-shared-test-/); await fs.rm(actual, { recursive: true }); });
    const bundle = path.join(root, 'package'), owned = path.join(root, 'owned'); await fs.mkdir(bundle);
    for (const [name, bytes] of Object.entries(unzipSync((await buildChromeArchive({ nodeExecutable: process.execPath })).archive))) {
        assert.match(name, /^(?:_app\/)?[^/\\]+$/); const file = path.join(bundle, name);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
    }
    const run = action => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundle, '_app', 'ChromeSetup.ps1'), '-Action', action, '-PrivateRoot', owned],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const wrongBrowser = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundle, '_app', 'ChromeSetup.ps1'), '-Browser', 'edge', '-PrivateRoot', owned],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(wrongBrowser.status, 1); assert.match(JSON.parse(wrongBrowser.stdout).message, /^X_CHROME_PACKAGE_INVALID:/);
    await assert.rejects(fs.stat(owned), { code: 'ENOENT' });
    const status = run('Status'); assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).prepared, false);
    const prepare = run('Prepare'); assert.equal(prepare.status, 0, prepare.stderr); assert.equal(JSON.parse(prepare.stdout).prepared, true);
    assert((await fs.stat(path.join(owned, 'chrome-profile'))).isDirectory());
});
test('Edge launcher opens its own interface from a path with Japanese characters and symbols', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-launch-test-'));
    t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-edge-launch-test-/); await fs.rm(actual, { recursive: true }); });
    const bundle = path.join(root, '日本語 [folder] & ! $value %literal%'); await fs.mkdir(bundle);
    const entries = unzipSync((await buildArchive({ nodeExecutable: process.execPath })).archive);
    await fs.writeFile(path.join(bundle, 'Edgeで開始.cmd'), entries['Edgeで開始.cmd']);
    const app = path.join(bundle, '_app'); await fs.mkdir(app); const output = path.join(root, 'launcher.json');
    await fs.writeFile(path.join(app, 'Start-EdgeSetup.ps1'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`
[IO.File]::WriteAllText($env:X_EDGE_LAUNCH_RESULT,([ordered]@{apartment=[Threading.Thread]::CurrentThread.GetApartmentState().ToString();argumentCount=$args.Count;scriptDirectory=$PSScriptRoot}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
exit 0
`, 'utf8')]));
    const launched = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '""%X_EDGE_SETUP_ENTRY%" ignored-user-argument"'],
        { encoding: 'utf8', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true,
            env: { ...process.env, X_EDGE_SETUP_ENTRY: path.join(bundle, 'Edgeで開始.cmd'), X_EDGE_LAUNCH_RESULT: output } });
    if (launched.error) throw launched.error; assert.equal(launched.status, 0, launched.stderr);
    const actual = JSON.parse(await fs.readFile(output, 'utf8')); assert.equal(actual.apartment, 'STA'); assert.equal(actual.argumentCount, 0);
    assert.equal(actual.scriptDirectory.toLowerCase(), app.toLowerCase());
});
