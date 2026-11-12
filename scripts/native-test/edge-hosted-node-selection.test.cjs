'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('multiple Node candidates select one scalar path and start the owned Windows Job',
    { skip: process.platform !== 'win32', timeout: 30000 }, () => {
        const helper = path.join(__dirname, 'edge-hosted-node-selection.ps1');
        const jobHelper = path.join(__dirname, '../../client/angelic-setup/EdgeCalibrationJob.ps1');
        const quote = value => `'${value.replace(/'/g, "''")}'`;
        const source = `$ErrorActionPreference='Stop'
. ${quote(helper)}
. ${quote(jobHelper)}
Initialize-XEdgeCalibrationJob
$one=$env:CBTE_TEST_NODE_PATH
$two='C:\\fixture-other\\node.exe'
$commands=@([pscustomobject]@{ Source=$one },[pscustomobject]@{ Source=$two })
$selected=Select-XEdgeHostedNodePath -Commands $commands
if ($selected -isnot [string] -or $selected -cne $one) { throw 'SCALAR_SELECTION_FAILED' }
foreach ($bad in @('', 'relative\\node.exe', 'C:\\fixture\\other.exe', ('C:\\fixture'+[char]10+'node.exe'))) {
  $failed=$false; try { Select-XEdgeHostedNodePath -Commands @([pscustomobject]@{Source=$bad}) | Out-Null } catch { $failed=$true }
  if (-not $failed) { throw 'INVALID_SELECTION_ACCEPTED' }
}
$legacy=@($one,$two); $reproduced=$false
try { $unexpected=[XEdgeNative.CalibrationJob]::Start($legacy,'--version',$env:CBTE_TEST_WORKDIR,$null); $unexpected.Stop(); $unexpected.Dispose() }
catch { $reproduced=$_.Exception.Message -match 'CreateProcess 123' }
if (-not $reproduced) { throw 'ARRAY_FAILURE_NOT_REPRODUCED' }
$job=[XEdgeNative.CalibrationJob]::Start($selected,'--version',$env:CBTE_TEST_WORKDIR,$null)
try {
  $read=$job.ReadLimitedAsync(256); $write=$job.WriteAndCloseAsync((New-Object byte[] 0))
  if (-not $write.Wait(5000) -or -not $job.WaitForExit(10000) -or -not $read.Wait(5000) -or $job.ExitCode -ne 0) { throw 'SCALAR_LAUNCH_FAILED' }
  $output=[Text.Encoding]::UTF8.GetString($read.GetAwaiter().GetResult()).Trim()
  if ($output -cne 'v24.21.0') { throw 'SCALAR_NODE_VERSION_INVALID' }
} finally { try { $job.Stop() } finally { $job.Dispose() } }
'selection-and-job-ok'`;
        const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
            env: { ...process.env, CBTE_TEST_NODE_PATH: process.execPath, CBTE_TEST_WORKDIR: path.resolve(__dirname, '../..') },
            encoding: 'utf8', windowsHide: true, timeout: 25000,
        });
        assert.equal(child.error, undefined); assert.equal(child.status, 0, 'synthetic scalar-node Job test failed');
        assert.equal(child.stdout.trim(), 'selection-and-job-ok');
    });
