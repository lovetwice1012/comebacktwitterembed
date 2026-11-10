'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { runEdgeCalibration } = require('../../src/automation/edge-calibration-runner');
function certFixture() {
    const helper = path.resolve(__dirname, '../../client/angelic-setup/EdgeEphemeralCertificate.ps1').replace(/'/g, "''");
    const script = `$ErrorActionPreference='Stop'; . '${helper}'; $c=New-XEdgeEphemeralCertificate; try { [ordered]@{pfx=[Convert]::ToBase64String($c.pfx);password=$c.password;certificate=[Convert]::ToBase64String($c.certificate)}|ConvertTo-Json -Compress } finally { [Array]::Clear($c.pfx,0,$c.pfx.Length);[Array]::Clear($c.certificate,0,$c.certificate.Length) }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout);
    return { pfx: Buffer.from(value.pfx, 'base64'), passphrase: value.password, certificate: Buffer.from(value.certificate, 'base64') };
}
async function fixture(t) {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-runner-test-'));
    t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-edge-runner-test-/); await fs.rm(actual, { recursive: true }); });
    const token = randomBytes(16).toString('hex'), rootPath = path.join(root, `edge-calibration-${token}`); await fs.mkdir(path.join(rootPath, 'profile'), { recursive: true });
    await fs.writeFile(path.join(rootPath, 'owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token }));
    const cert = certFixture(); t.after(() => { cert.pfx.fill(0); cert.certificate.fill(0); });
    const options = { rootPath, token, edgePath: 'C:\\synthetic\\msedge.exe', ...cert, timeoutMs: 1000,
        captureIdentity: async () => { throw new Error('unexpected identity'); }, authorizePeer: async () => { throw new Error('unexpected peer'); } };
    return { rootPath, options };
}
test('calibration rejects non-owned or nonempty profiles before starting a browser', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const { rootPath, options } = await fixture(t); let spawned = 0;
    const spawnBrowser = () => { spawned++; throw new Error('unexpected browser'); };
    await assert.rejects(runEdgeCalibration({ ...options, token: '0'.repeat(32), spawnBrowser }), { code: 'X_EDGE_CALIBRATION_CONFIG_INVALID' });
    await fs.writeFile(path.join(rootPath, 'profile', 'do-not-touch'), 'fixture');
    await assert.rejects(runEdgeCalibration({ ...options, spawnBrowser }), { code: 'X_EDGE_CALIBRATION_CONFIG_INVALID' });
    assert.equal(spawned, 0); assert.equal(await fs.readFile(path.join(rootPath, 'profile', 'do-not-touch'), 'utf8'), 'fixture');
});
test('cancellation and timeout stop only the owned calibration browser', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const { options } = await fixture(t), cancelled = new AbortController(); cancelled.abort(); let spawned = 0, killed = 0;
    const spawnBrowser = () => {
        spawned++; const child = new EventEmitter(); child.pid = 43210; child.exitCode = null; child.signalCode = null;
        child.stdio = [null, null, null, new Writable({ write(_chunk, _encoding, done) { done(); } }), new PassThrough()];
        child.kill = () => { killed++; child.signalCode = 'SIGTERM'; child.emit('exit'); return true; }; return child;
    };
    await assert.rejects(runEdgeCalibration({ ...options, signal: cancelled.signal, spawnBrowser }), { code: 'X_EDGE_CALIBRATION_STOPPED' });
    assert.equal(spawned, 0);
    await assert.rejects(runEdgeCalibration({ ...options, spawnBrowser }), { code: 'X_EDGE_CALIBRATION_TIMEOUT' });
    assert.equal(spawned, 1); assert.equal(killed, 1);
});
