'use strict';

// Localhost-only, short-lived relay for an isolated calibration profile. The
// caller must supply an OS-backed peer check tied to its own browser process.
// It must never be used with a person's normal browser profile.
const tls = require('node:tls');
const { Transform } = require('node:stream');
const { createFrameDecoder } = require('./edge-wns-framing');
const { parseEdgeClientMetadata } = require('./edge-wns-client-metadata');
const { parseEdgeAgentMetadata } = require('./edge-wns-agent-metadata');
const fail = code => Object.assign(new Error(code), { code });
async function createEdgeCalibrationRelay({ pfx, passphrase, authorizePeer, connectUpstream = undefined, timeoutMs = 10000, captureAgent = false }) {
    if (!Buffer.isBuffer(pfx) || !pfx.length || pfx.length > 65536 || typeof passphrase !== 'string' || !passphrase.length || passphrase.length > 256
        || typeof authorizePeer !== 'function' || connectUpstream !== undefined && typeof connectUpstream !== 'function'
        || typeof captureAgent !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw fail('X_EDGE_CALIBRATION_CONFIG_INVALID');
    const clients = new Set(), upstreams = new Set(); let closed = false, pending = 0, active = false, completed = false, resolveMetadata, rejectMetadata;
    const metadata = new Promise((resolve, reject) => { resolveMetadata = resolve; rejectMetadata = reject; }); metadata.catch(() => {});
    function finishError(code) { if (!completed) { completed = true; rejectMetadata(fail(code)); } }
    const pfxCopy = Buffer.from(pfx); let server;
    try {
        server = tls.createServer({ pfx: pfxCopy, passphrase, handshakeTimeout: timeoutMs, ALPNProtocols: ['h2', 'http/1.1'] }, incoming => {
            incoming.pause(); clients.add(incoming); incoming.once('close', () => clients.delete(incoming)); incoming.on('error', () => incoming.destroy());
            if (closed || pending >= 4 || active || incoming.remoteAddress !== '127.0.0.1' || !Number.isInteger(incoming.remotePort)) { incoming.destroy(); return; }
            pending++;
            const serverPort = server.address()?.port, clientPort = incoming.remotePort;
            let timer;
            const authTimeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
            let onClose;
            const disconnected = new Promise(resolve => { onClose = () => resolve(false); incoming.once('close', onClose); });
            Promise.race([Promise.resolve().then(() => authorizePeer({ clientPort, serverPort })).catch(() => false), authTimeout, disconnected]).then(allowed => {
                incoming.removeListener('close', onClose);
                clearTimeout(timer); pending--;
                if (allowed !== true || closed || active || incoming.destroyed) { incoming.destroy(); return; }
                active = true;
                let upstream;
                try {
                    upstream = connectUpstream ? connectUpstream() : tls.connect({ host: 'client.wns.windows.com', port: 443,
                        servername: 'client.wns.windows.com', rejectUnauthorized: true, ALPNProtocols: incoming.alpnProtocol ? [incoming.alpnProtocol] : ['http/1.1'] });
                    if (!upstream || typeof upstream.on !== 'function' || typeof upstream.destroy !== 'function') throw new Error();
                } catch { active = false; incoming.destroy(); finishError('X_EDGE_CALIBRATION_CONNECT_FAILED'); return; }
                upstreams.add(upstream); upstream.once('close', () => { upstreams.delete(upstream); active = false; });
                const decoder = createFrameDecoder(); let parsed = false, connect;
                const inspect = new Transform({ transform(chunk, _encoding, done) {
                    if (parsed) { done(null, chunk); return; }
                    let frames, found;
                    try {
                        frames = decoder.push(chunk);
                        for (const frame of frames) {
                            if (captureAgent && frame.subarray(0, 4).toString('ascii') === 'CNT ') {
                                if (connect || found) throw new Error();
                                connect = parseEdgeAgentMetadata(frame);
                            }
                            if (frame.subarray(0, 4).toString('ascii') === 'BND ') {
                                if (completed || found || captureAgent && !connect) throw new Error();
                                found = parseEdgeClientMetadata(frame);
                            }
                        }
                        if (found) { parsed = true; completed = true; try { decoder.finish(); } catch {} resolveMetadata(captureAgent ? { ...connect, client: found } : found); }
                        done(null, chunk);
                    } catch { done(fail('X_EDGE_CALIBRATION_PROTOCOL_INVALID')); }
                    finally { if (frames) for (const frame of frames) frame.fill(0); }
                } });
                inspect.on('error', () => { finishError('X_EDGE_CALIBRATION_PROTOCOL_INVALID'); incoming.destroy(); upstream.destroy(); });
                incoming.once('close', () => { try { decoder.finish(); } catch {} upstream.destroy(); });
                upstream.once('error', () => { finishError('X_EDGE_CALIBRATION_CONNECT_FAILED'); incoming.destroy(); });
                upstream.once('secureConnect', () => { if (closed || incoming.destroyed) { upstream.destroy(); return; } incoming.pipe(inspect).pipe(upstream); upstream.pipe(incoming); });
            }).catch(() => { incoming.removeListener('close', onClose); clearTimeout(timer); pending--; incoming.destroy(); });
        });
    } finally { pfxCopy.fill(0); }
    server.maxConnections = 8;
    server.on('tlsClientError', () => {});
    server.on('error', () => finishError('X_EDGE_CALIBRATION_LISTEN_FAILED'));
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()); }); }
    catch { finishError('X_EDGE_CALIBRATION_LISTEN_FAILED'); throw fail('X_EDGE_CALIBRATION_LISTEN_FAILED'); }
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') { server.close(); finishError('X_EDGE_CALIBRATION_LISTEN_FAILED'); throw fail('X_EDGE_CALIBRATION_LISTEN_FAILED'); }
    return Object.freeze({ port: address.port, metadata, async close() {
        if (closed) return; closed = true; finishError('X_EDGE_CALIBRATION_STOPPED');
        for (const socket of clients) socket.destroy(); for (const socket of upstreams) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    } });
}
module.exports = { createEdgeCalibrationRelay };
