'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildChromeBundles } = require('../build-chrome-setup-bundles.cjs');
test('bundled Edge calibration obtains metadata using only an owned synthetic profile', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-calibration-package-'));
    t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-edge-calibration-package-/); await fs.rm(actual, { recursive: true }); });
    const pkg = path.join(root, 'package'), token = randomBytes(16).toString('hex'), calibrationRoot = path.join(root, `edge-calibration-${token}`);
    await fs.mkdir(pkg); await fs.mkdir(path.join(calibrationRoot, 'profile'), { recursive: true });
    await fs.writeFile(path.join(calibrationRoot, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }));
    const source = path.resolve(__dirname, '../../client/angelic-setup');
    for (const name of ['EdgePeerIdentity.ps1', 'EdgePeerVerify.ps1', 'EdgeCalibrationJob.ps1']) await fs.copyFile(path.join(source, name), path.join(pkg, name));
    const bundles = await buildChromeBundles({ includeEdge: true }); await fs.writeFile(path.join(pkg, 'EdgeCalibrate.cjs'), bundles['EdgeCalibrate.cjs']);
    const helper = path.join(source, 'EdgeEphemeralCertificate.ps1').replace(/'/g, "''");
    const certScript = `$ErrorActionPreference='Stop'; . '${helper}'; $c=New-XEdgeEphemeralCertificate; try { [ordered]@{pfx=[Convert]::ToBase64String($c.pfx).TrimEnd('=').Replace('+','-').Replace('/','_');passphrase=$c.password;certificate=[Convert]::ToBase64String($c.certificate).TrimEnd('=').Replace('+','-').Replace('/','_')}|ConvertTo-Json -Compress } finally { [Array]::Clear($c.pfx,0,$c.pfx.Length);[Array]::Clear($c.certificate,0,$c.certificate.Length) }`;
    const certResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(certScript, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(certResult.status, 0, certResult.stderr); const cert = JSON.parse(certResult.stdout);
    const input = { rootPath: calibrationRoot, token, edgePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ...cert };
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [path.join(pkg, 'EdgeCalibrate.cjs')], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env, timeout: 75000 });
    assert.equal(result.status, 0, result.stderr || 'calibration failed');
    const resultData = JSON.parse(result.stdout); assert.equal(resultData.ok, true); assert.match(resultData.browserVersion, /^\d+\.\d+\.\d+\.\d+$/);
    assert.match(resultData.client.channel, /^[0-9a-f]{1,16}$/i); assert(!result.stdout.includes(cert.pfx)); assert(!result.stdout.includes(cert.passphrase));
    const retry = spawnSync(process.execPath, [path.join(pkg, 'EdgeCalibrate.cjs')], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env, timeout: 15000 });
    assert.notEqual(retry.status, 0); assert.equal(JSON.parse(retry.stdout).errorCode, 'X_EDGE_CALIBRATION_CONFIG_INVALID');
    const fakeDir = path.join(root, 'untrusted'); await fs.mkdir(fakeDir); const fakeEdge = path.join(fakeDir, 'msedge.exe'); await fs.writeFile(fakeEdge, 'unsigned fixture');
    const badToken = randomBytes(16).toString('hex'), badRoot = path.join(root, `edge-calibration-${badToken}`);
    await fs.mkdir(path.join(badRoot, 'profile'), { recursive: true });
    await fs.writeFile(path.join(badRoot, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token: badToken }));
    const rejected = spawnSync(process.execPath, [path.join(pkg, 'EdgeCalibrate.cjs')],
        { input: JSON.stringify({ ...input, rootPath: badRoot, token: badToken, edgePath: fakeEdge }), encoding: 'utf8', windowsHide: true, env, timeout: 15000 });
    assert.notEqual(rejected.status, 0); assert.equal(JSON.parse(rejected.stdout).errorCode, 'X_EDGE_CALIBRATION_CONFIG_INVALID');
    assert.deepEqual(await fs.readdir(path.join(badRoot, 'profile')), []);
    const jobToken = randomBytes(16).toString('hex'), jobRoot = path.join(root, `edge-calibration-${jobToken}`);
    await fs.mkdir(path.join(jobRoot, 'profile'), { recursive: true });
    await fs.writeFile(path.join(jobRoot, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token: jobToken }));
    const quoted = value => `'${value.replace(/'/g, "''")}'`;
    const jobScript = `$ErrorActionPreference='Stop'; . ${quoted(path.join(pkg, 'EdgeCalibrationJob.ps1'))}; Initialize-XEdgeCalibrationJob
$memory=New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($memory); $inputBytes=$memory.ToArray();$memory.Dispose()
$job=[XEdgeNative.CalibrationJob]::Start(${quoted(process.execPath)},('"'+${quoted(path.join(pkg, 'EdgeCalibrate.cjs'))}+'"'),${quoted(pkg)},$null)
try { $read=$job.ReadLimitedAsync(16384);$write=$job.WriteAndCloseAsync($inputBytes)
  if (-not $write.Wait(10000) -or -not $job.WaitForExit(65000)) { throw 'calibration timed out' }; $null=$write.GetAwaiter().GetResult()
  if ($job.ExitCode -ne 0) { throw 'calibration failed' };$data=$read.GetAwaiter().GetResult();[Console]::OpenStandardOutput().Write($data,0,$data.Length)
  $job.Stop()
} finally { [Array]::Clear($inputBytes,0,$inputBytes.Length);$job.Dispose() }`;
    const viaJob = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(jobScript, 'utf16le').toString('base64')],
        { input: JSON.stringify({ ...input, rootPath: jobRoot, token: jobToken }), encoding: 'utf8', windowsHide: true, env, timeout: 75000 });
    assert.equal(viaJob.status, 0, viaJob.stderr || 'job calibration failed');
    const jobResult = JSON.parse(viaJob.stdout); assert.equal(jobResult.ok, true); assert.equal(jobResult.browserVersion, resultData.browserVersion);
    assert(!viaJob.stdout.includes(cert.pfx)); assert(!viaJob.stdout.includes(cert.passphrase));
});
