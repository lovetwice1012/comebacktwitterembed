'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('Windows calibration job bounds pipe output and terminates owned child processes', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
    const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'cbte-edge-job-test-'));
    t.after(() => { const actual = fs.realpathSync(root); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-edge-job-test-/); fs.rmSync(actual, { recursive: true }); });
    const echo = path.join(root, 'echo.cjs'), tree = path.join(root, 'tree.cjs'), large = path.join(root, 'large.cjs');
    fs.writeFileSync(echo, "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({echo:s,env:process.env.EDGE_JOB_FIXTURE})));\n");
    const pidFile = path.join(root, 'fixture-pid.txt');
    fs.writeFileSync(tree, `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.stdout.write(JSON.stringify({pid:c.pid}));setInterval(()=>{},1000);\n`);
    fs.writeFileSync(large, "process.stdout.write('x'.repeat(20000));\n");
    const helper = path.resolve(__dirname, '../../client/angelic-setup/EdgeCalibrationJob.ps1');
    const quoted = value => `'${value.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'; . ${quoted(helper)}; Initialize-XEdgeCalibrationJob
function Start-JobFor([string]$file,[string]$block) { [XEdgeNative.CalibrationJob]::Start(${quoted(process.execPath)},('"'+$file+'"'),${quoted(root)},$block) }
$block=('SystemRoot='+$env:SystemRoot+[char]0+'EDGE_JOB_FIXTURE=owned'+[char]0+[char]0)
$job=Start-JobFor ${quoted(echo)} $block
try { $read=$job.ReadLimitedAsync(4096);$bytes=[Text.Encoding]::UTF8.GetBytes('fixture');$write=$job.WriteAndCloseAsync($bytes)
  if (-not $write.Wait(5000) -or -not $job.WaitForExit(5000)) { throw 'echo timed out' }; $null=$write.GetAwaiter().GetResult()
  $value=[Text.Encoding]::UTF8.GetString($read.GetAwaiter().GetResult())|ConvertFrom-Json
  if ($job.ExitCode -ne 0 -or $value.echo -cne 'fixture' -or $value.env -cne 'owned') { throw 'pipe failed' }; $job.Stop()
} finally { $job.Dispose() }
$job=Start-JobFor ${quoted(tree)}
try { $read=$job.ReadLimitedAsync(4096);$write=$job.WriteAndCloseAsync([byte[]]@());$null=$write.GetAwaiter().GetResult();Start-Sleep -Milliseconds 900
  $job.Stop();if (-not $job.WaitForExit(5000)) { throw 'job did not stop' }
  $value=[Text.Encoding]::UTF8.GetString($read.GetAwaiter().GetResult())|ConvertFrom-Json
  if ($value.pid -le 4 -or $null -ne (Get-Process -Id $value.pid -ErrorAction SilentlyContinue)) { throw 'descendant still running' }
} finally { $job.Dispose() }
Remove-Item -LiteralPath ${quoted(pidFile)}
$job=Start-JobFor ${quoted(tree)}
try { $write=$job.WriteAndCloseAsync([byte[]]@());$null=$write.GetAwaiter().GetResult()
  for($i=0;$i -lt 100 -and -not (Test-Path -LiteralPath ${quoted(pidFile)});$i++){Start-Sleep -Milliseconds 50}
  if (-not (Test-Path -LiteralPath ${quoted(pidFile)})) { throw 'fixture did not start' }
  $childPid=[int][IO.File]::ReadAllText(${quoted(pidFile)});$job.Dispose();$job=$null
  for($i=0;$i -lt 100 -and $null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue);$i++){Start-Sleep -Milliseconds 50}
  if ($null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) { throw 'dispose left descendant running' }
} finally { if ($null -ne $job) { $job.Dispose() } }
$job=Start-JobFor ${quoted(large)}
try { $read=$job.ReadLimitedAsync(1024);$write=$job.WriteAndCloseAsync([byte[]]@());$null=$write.GetAwaiter().GetResult();$null=$job.WaitForExit(5000)
  $rejected=$false;try { $null=$read.GetAwaiter().GetResult() } catch { $rejected=$true }; if (-not $rejected) { throw 'output limit ignored' };$job.Stop()
} finally { $job.Dispose() }
'ok'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ok/);
});
