'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { withMacEdgeEphemeralCertificate } = require('../../src/automation/edge-mac-ephemeral-certificate');

test('ephemeral calibration certificate is local, short-lived and works only when trusted', { timeout: 15000 }, async () => {
    let borrowedPfx, borrowedCertificate;
    await withMacEdgeEphemeralCertificate(async ({ pfx, passphrase, certificate }) => {
        borrowedPfx = pfx; borrowedCertificate = certificate;
        const cert = new X509Certificate(certificate), now = Date.now();
        assert(cert.checkHost('localhost')); assert(cert.checkIP('127.0.0.1')); assert(cert.verify(cert.publicKey));
        assert.equal(cert.ca, false); assert(Date.parse(cert.validFrom) <= now); assert(Date.parse(cert.validTo) > now);
        assert(Date.parse(cert.validTo) - now <= 601000);
        const server = tls.createServer({ pfx, passphrase }, socket => socket.end('fixture'));
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        try {
            const port = server.address().port;
            const data = await new Promise((resolve, reject) => {
                let text = ''; const client = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert.toString() });
                client.on('data', chunk => { text += chunk.toString(); }); client.once('error', reject); client.once('end', () => resolve(text));
            });
            assert.equal(data, 'fixture');
            await assert.rejects(new Promise((resolve, reject) => {
                const client = tls.connect({ host: '127.0.0.1', port, servername: 'localhost' });
                client.once('secureConnect', () => { client.destroy(); resolve(); }); client.once('error', reject);
            }), /self-signed/i);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
    assert(borrowedPfx.every(value => value === 0)); assert(borrowedCertificate.every(value => value === 0));
});
test('ephemeral certificate buffers are cleared when calibration fails', async () => {
    let borrowed;
    await assert.rejects(withMacEdgeEphemeralCertificate(async value => { borrowed = value.pfx; throw new Error('synthetic failure'); }), /synthetic failure/);
    assert(borrowed.every(value => value === 0));
});
