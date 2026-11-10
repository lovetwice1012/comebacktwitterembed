'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const tls = require('node:tls');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { X509Certificate, createHash } = require('node:crypto');
test('Windows creates fresh in-memory localhost TLS certificates without a certificate store', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const helper = path.resolve(__dirname, '../../client/angelic-setup/EdgeEphemeralCertificate.ps1');
    const quoted = value => `'${value.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'; . ${quoted(helper)}; $c=New-XEdgeEphemeralCertificate
try { $generated=New-Object Security.Cryptography.X509Certificates.X509Certificate2(,$c.certificate)
  $store=New-Object Security.Cryptography.X509Certificates.X509Store('My',[Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
  try { $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly); $installed=@($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,$generated.Thumbprint,$false)).Count -gt 0 }
  finally { $store.Close(); $generated.Dispose() }
  [ordered]@{pfx=[Convert]::ToBase64String($c.pfx);password=$c.password;certificate=[Convert]::ToBase64String($c.certificate);installed=$installed}|ConvertTo-Json -Compress }
finally { [Array]::Clear($c.pfx,0,$c.pfx.Length);[Array]::Clear($c.certificate,0,$c.certificate.Length) }`;
    const create = () => {
        const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.equal(run.status, 0, run.stderr); const value = JSON.parse(run.stdout);
        assert.equal(value.installed, false);
        return { pfx: Buffer.from(value.pfx, 'base64'), passphrase: value.password, cert: Buffer.from(value.certificate, 'base64') };
    };
    const first = create(), second = create();
    try {
        const certificate = new X509Certificate(first.cert), different = new X509Certificate(second.cert);
        assert(certificate.verify(certificate.publicKey)); assert(certificate.checkHost('localhost')); assert(certificate.checkIP('127.0.0.1'));
        const hash = cert => createHash('sha256').update(cert.publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
        assert.notEqual(hash(certificate), hash(different));
        const server = tls.createServer({ pfx: first.pfx, passphrase: first.passphrase }, socket => socket.end('fixture'));
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        try {
            const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: certificate.toString() });
            let received = ''; client.on('data', value => { received += value.toString('utf8'); }); await once(client, 'end'); assert.equal(received, 'fixture');
        } finally { await new Promise(resolve => server.close(resolve)); }
    } finally { first.pfx.fill(0); first.cert.fill(0); second.pfx.fill(0); second.cert.fill(0); }
});
