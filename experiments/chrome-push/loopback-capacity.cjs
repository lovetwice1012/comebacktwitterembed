'use strict';
// Optional local capacity probe. Both TLS endpoints run in this same process;
// results are not a production or FCM/DB throughput guarantee.
const tls = require('node:tls');
const { spawnSync } = require('node:child_process');
const { createChromeMcsTransport } = require('../../src/automation/chrome-mcs-transport');
const python = `from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime,timedelta,timezone
import json
k=rsa.generate_private_key(public_exponent=65537,key_size=2048)
n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
c=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc)-timedelta(days=1)).not_valid_after(datetime.now(timezone.utc)+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False).sign(k,hashes.SHA256())
print(json.dumps({'key':k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()).decode(),'cert':c.public_bytes(serialization.Encoding.PEM).decode()}))`;
async function main() {
    const count = Number(process.argv[2] || 1000);
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('INVALID_COUNT');
    const result = spawnSync('python', ['-c', python], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status !== 0) throw new Error('CERTIFICATE_FIXTURE_FAILED');
    const cert = JSON.parse(result.stdout), accepted = new Set(), transports = [];
    const server = tls.createServer(cert, socket => {
        accepted.add(socket); socket.on('close', () => accepted.delete(socket)); socket.on('error', () => {});
        socket.write(Buffer.from([41, 3, 0]));
    });
    await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0, backlog: 512 }, resolve));
    const startMemory = process.memoryUsage().rss, startTime = Date.now();
    try {
        for (let offset = 0; offset < count; offset += 50) {
            await Promise.all(Array.from({ length: Math.min(50, count - offset) }, async () => {
                const transport = createChromeMcsTransport({ timeoutMs: 30000,
                    createSocket: () => tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: cert.cert }) });
                transports.push(transport); await transport.connect();
                const response = await transport.read(30000);
                if (!response || response.tag !== 3) throw new Error('LOOPBACK_FRAME_FAILED');
            }));
        }
        console.log(JSON.stringify({ loopbackTlsConnections: transports.length, serverSockets: accepted.size, nodeProcesses: 1,
            elapsedMs: Date.now() - startTime, rssDeltaMiB: Math.round((process.memoryUsage().rss - startMemory) / 1048576),
            scope: 'same-process loopback TLS; no FCM, database or Discord' }));
    } finally {
        await Promise.allSettled(transports.map(transport => transport.close()));
        for (const socket of accepted) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
