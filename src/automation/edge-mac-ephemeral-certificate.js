'use strict';

// Short-lived local-only TLS identity for a disposable Edge calibration.
// Nothing is written to disk or installed into a system certificate store.
const { randomBytes, X509Certificate } = require('node:crypto');
const tls = require('node:tls');
const forge = require('node-forge');
const fail = () => Object.assign(new Error('X_EDGE_CALIBRATION_CERT_FAILED'), { code: 'X_EDGE_CALIBRATION_CERT_FAILED' });

async function withMacEdgeEphemeralCertificate(work) {
    if (typeof work !== 'function') throw fail();
    let pfx, certificate, ready = false;
    try {
        // Forge uses Node's native key generation when available. The keys
        // exist only in this process and the generated PFX buffer is cleared.
        const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
        const cert = forge.pki.createCertificate(); cert.publicKey = keys.publicKey;
        const serial = randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1;
        cert.serialNumber = serial.toString('hex'); serial.fill(0);
        const now = Date.now(); cert.validity.notBefore = new Date(now - 60000); cert.validity.notAfter = new Date(now + 600000);
        const name = [{ name: 'commonName', value: 'localhost' }]; cert.setSubject(name); cert.setIssuer(name);
        cert.setExtensions([
            { name: 'basicConstraints', cA: false, critical: true },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
            { name: 'extKeyUsage', serverAuth: true },
            { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
        ]);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        certificate = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
        const x509 = new X509Certificate(certificate);
        if (!x509.checkHost('localhost') || !x509.checkIP('127.0.0.1') || !x509.verify(x509.publicKey)) throw fail();
        const passphrase = randomBytes(32).toString('base64url');
        pfx = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase,
            { algorithm: 'aes256', count: 2048 })).getBytes(), 'binary');
        tls.createSecureContext({ pfx, passphrase });
        ready = true;
        return await work({ pfx, passphrase, certificate });
    } catch (error) { if (!ready) throw fail(); throw error; }
    finally { pfx?.fill(0); certificate?.fill(0); }
}
module.exports = { withMacEdgeEphemeralCertificate };
