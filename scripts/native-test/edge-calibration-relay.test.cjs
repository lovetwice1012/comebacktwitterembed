'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { X509Certificate } = require('node:crypto');
const path = require('node:path');
const tls = require('node:tls');
const { createEdgeCalibrationRelay } = require('../../src/automation/edge-calibration-relay');
const { bindFrame } = require('../../src/automation/edge-wns-protocol');
function certificate() {
    const helper = path.resolve(__dirname, '../../client/angelic-setup/EdgeEphemeralCertificate.ps1').replace(/'/g, "''");
    const script = `$ErrorActionPreference='Stop'; . '${helper}'; $c=New-XEdgeEphemeralCertificate; try { [ordered]@{pfx=[Convert]::ToBase64String($c.pfx);password=$c.password;certificate=[Convert]::ToBase64String($c.certificate)}|ConvertTo-Json -Compress } finally { [Array]::Clear($c.pfx,0,$c.pfx.Length);[Array]::Clear($c.certificate,0,$c.certificate.Length) }`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(run.status, 0, run.stderr); const value = JSON.parse(run.stdout);
    return { pfx: Buffer.from(value.pfx, 'base64'), passphrase: value.password, ca: new X509Certificate(Buffer.from(value.certificate, 'base64')).toString() };
}
const connect = (port, ca) => tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca });
test('calibration relay authenticates before forwarding and extracts metadata without exposing token', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const cert = certificate(), upstream = tls.createServer({ pfx: cert.pfx, passphrase: cert.passphrase });
    let connections = 0, forwarded = Buffer.alloc(0), release, allowed = false;
    const gate = new Promise(resolve => { release = resolve; });
    upstream.on('secureConnection', socket => { connections++; socket.on('data', data => { forwarded = Buffer.concat([forwarded, data]); }); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const relay = await createEdgeCalibrationRelay({ pfx: cert.pfx, passphrase: cert.passphrase, timeoutMs: 3000,
        authorizePeer: async ({ clientPort, serverPort }) => { assert(clientPort > 0 && serverPort === relay.port); if (!allowed) return false; await gate; return true; },
        connectUpstream: () => connect(upstream.address().port, cert.ca) });
    const secret = 'PRIVATE-SYNTHETIC-TOKEN';
    const message = bindFrame({ channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4', nonce: '1'.repeat(32),
        reconnectToken: Buffer.from(secret), deviceKey: Buffer.alloc(32, 7) }, 3);
    try {
        const rejected = connect(relay.port, cert.ca); rejected.on('error', () => {}); await once(rejected, 'close'); assert.equal(connections, 0);
        allowed = true;
        const client = connect(relay.port, cert.ca); client.on('error', () => {}); await once(client, 'secureConnect'); client.write(message);
        await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(connections, 0);
        release(); const metadata = await relay.metadata;
        assert.deepEqual(metadata, { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' });
        assert(!JSON.stringify(metadata).includes(secret));
        for (let i = 0; i < 100 && forwarded.length < message.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(connections, 1); assert.deepEqual(forwarded, message); client.destroy();
    } finally { message.fill(0); forwarded.fill(0); release(); await relay.close(); await new Promise(resolve => upstream.close(resolve)); cert.pfx.fill(0); }
});
test('closing during a pending peer check prevents a late upstream connection', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const cert = certificate(); let release, upstreamAttempts = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const relay = await createEdgeCalibrationRelay({ pfx: cert.pfx, passphrase: cert.passphrase, timeoutMs: 3000,
        authorizePeer: async () => { await gate; return true; }, connectUpstream: () => { upstreamAttempts++; throw new Error('unexpected'); } });
    try {
        const client = connect(relay.port, cert.ca); client.on('error', () => {}); await once(client, 'secureConnect');
        await relay.close(); release(); await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(upstreamAttempts, 0); await assert.rejects(relay.metadata, { code: 'X_EDGE_CALIBRATION_STOPPED' }); client.destroy();
    } finally { release(); await relay.close(); cert.pfx.fill(0); }
});
test('ambiguous metadata is rejected before any of that chunk is forwarded', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const cert = certificate(), upstream = tls.createServer({ pfx: cert.pfx, passphrase: cert.passphrase }); let forwarded = 0;
    upstream.on('secureConnection', socket => socket.on('data', data => { forwarded += data.length; }));
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const relay = await createEdgeCalibrationRelay({ pfx: cert.pfx, passphrase: cert.passphrase, timeoutMs: 3000,
        authorizePeer: async () => true, connectUpstream: () => connect(upstream.address().port, cert.ca) });
    const message = bindFrame({ channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4', nonce: '1'.repeat(32),
        reconnectToken: Buffer.from('PRIVATE-SYNTHETIC-TOKEN'), deviceKey: Buffer.alloc(32, 7) }, 3);
    try {
        const client = connect(relay.port, cert.ca); client.on('error', () => {}); await once(client, 'secureConnect'); client.write(Buffer.concat([message, message]));
        await assert.rejects(relay.metadata, { code: 'X_EDGE_CALIBRATION_PROTOCOL_INVALID' });
        await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(forwarded, 0); client.destroy();
    } finally { message.fill(0); await relay.close(); await new Promise(resolve => upstream.close(resolve)); cert.pfx.fill(0); }
});
test('disconnected clients do not exhaust pending authorization capacity', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const cert = certificate(), upstream = tls.createServer({ pfx: cert.pfx, passphrase: cert.passphrase }); let attempts = 0;
    upstream.on('secureConnection', socket => socket.on('data', () => {})); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const relay = await createEdgeCalibrationRelay({ pfx: cert.pfx, passphrase: cert.passphrase, timeoutMs: 3000,
        authorizePeer: async () => { attempts++; if (attempts <= 5) return new Promise(() => {}); return true; },
        connectUpstream: () => connect(upstream.address().port, cert.ca) });
    const message = bindFrame({ channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4', nonce: '1'.repeat(32),
        reconnectToken: Buffer.from('PRIVATE-SYNTHETIC-TOKEN'), deviceKey: Buffer.alloc(32, 7) }, 3);
    try {
        for (let i = 0; i < 5; i++) {
            const client = connect(relay.port, cert.ca); client.on('error', () => {}); await once(client, 'secureConnect');
            for (let retry = 0; retry < 100 && attempts <= i; retry++) await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(attempts, i + 1); const closed = once(client, 'close'); client.destroy(); await closed; await new Promise(resolve => setTimeout(resolve, 20));
        }
        const accepted = connect(relay.port, cert.ca); accepted.on('error', () => {}); await once(accepted, 'secureConnect'); accepted.write(message);
        assert.equal((await relay.metadata).clientName, 'Synthetic'); accepted.destroy();
    } finally { message.fill(0); await relay.close(); await new Promise(resolve => upstream.close(resolve)); cert.pfx.fill(0); }
});
