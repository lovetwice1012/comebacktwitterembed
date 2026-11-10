'use strict';
// Research fixture only. A disposable Edge profile uses a local TLS relay to
// its normal WNS endpoint. Neither payload nor credentials are logged/stored.
// No existing Edge profile, real X account, OS setting or user data is read.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { spawn, spawnSync } = require('node:child_process');
const { createHmac, createHash, createCipheriv, createPrivateKey, generateKeyPairSync, randomBytes, randomInt, X509Certificate } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const webpush = require('web-push');
const CDP = require('chrome-remote-interface');
const { ClassicLevel } = require('classic-level');
const { firstFixtureNotification, fixtureBindResponses } = require('./edge-wns-fixture-framing.cjs');
const { workerSource, acceptedCase } = require('./edge-fixture-notification.cjs');
const { replaceSyntheticKey } = require('./edge-fixture-device.cjs');
const { syntheticReconnectSignature } = require('./edge-fixture-signature.cjs');
const { createSyntheticRewriteStream } = require('./edge-fixture-rewrite.cjs');
const { selectSyntheticHandshake, describeSyntheticHandshake, syntheticHandshakeRelations, syntheticClientMetadata, independentSyntheticReconnect } = require('./edge-fixture-independent.cjs');
const { readSyntheticProductConstants } = require('./edge-fixture-product.cjs');
const { syntheticChallengeResponse } = require('./edge-fixture-challenge.cjs');
const { matchingSyntheticRecordFields, selectSyntheticEdgeRecord, rewriteSyntheticOrigin } = require('./edge-fixture-record.cjs');
const { selectXRecord, clearRecord } = require('../../src/automation/edge-wns-record');
const { compareSyntheticRouting, syntheticRecipientProof, syntheticChannelStability } = require('./edge-fixture-routing.cjs');
const { createSyntheticDurableReceiver } = require('./edge-fixture-durable.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
async function sendFixture(subscription, message) {
    const request = webpush.generateRequestDetails(subscription, message, { TTL: 60, contentEncoding: 'aes128gcm' });
    const endpoint = new URL(request.endpoint);
    if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.notify\.windows\.com$/i.test(endpoint.hostname)) throw new Error('PROBE_ENDPOINT_INVALID');
    await new Promise((resolve, reject) => {
        const req = https.request(endpoint, { method: 'POST', headers: request.headers, timeout: 15000 }, response => {
            response.resume(); response.once('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error('PROBE_PUSH_FAILED')));
        });
        req.once('error', () => reject(new Error('PROBE_PUSH_FAILED')));
        req.once('timeout', () => req.destroy()); req.end(request.body);
    });
    return Buffer.from(request.body);
}
function cmac(key, message) {
    if (![16, 32].includes(key.length)) return null;
    const encrypt = block => { const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null); cipher.setAutoPadding(false); return Buffer.concat([cipher.update(block), cipher.final()]); };
    const double = block => { const out = Buffer.alloc(16); let carry = 0; for (let i = 15; i >= 0; i--) { const n = block[i]; out[i] = ((n << 1) & 255) | carry; carry = n >>> 7; } if (carry) out[15] ^= 0x87; return out; };
    const first = double(encrypt(Buffer.alloc(16))), second = double(first), full = message.length > 0 && message.length % 16 === 0;
    const blocks = Math.max(1, Math.ceil(message.length / 16)), last = Buffer.alloc(16);
    const tail = message.subarray((blocks - 1) * 16); tail.copy(last); if (!full) last[tail.length] = 0x80;
    const subkey = full ? first : second; for (let i = 0; i < 16; i++) last[i] ^= subkey[i];
    let state = Buffer.alloc(16);
    for (let index = 0; index < blocks - 1; index++) { const block = Buffer.from(message.subarray(index * 16, index * 16 + 16)); for (let i = 0; i < 16; i++) block[i] ^= state[i]; state = encrypt(block); }
    for (let i = 0; i < 16; i++) last[i] ^= state[i];
    return encrypt(last);
}
function protoBytes(buffer, wanted) {
    let pos = 0;
    const read = () => { let n = 0n; for (let i = 0; i < 10; i++) { if (pos >= buffer.length) throw new Error(); const b = buffer[pos++]; n |= BigInt(b & 127) << BigInt(i * 7); if (!(b & 128)) return n; } throw new Error(); };
    const result = {};
    while (pos < buffer.length) {
        const h = read(), n = Number(h >> 3n), wire = Number(h & 7n);
        if (wire === 0) read();
        else if (wire === 2) { const length = Number(read()); if (!Number.isSafeInteger(length) || length > buffer.length - pos) throw new Error();
            if (wanted.includes(n)) result[n] = Buffer.from(buffer.subarray(pos, pos + length)); pos += length; }
        else if (wire === 1 || wire === 5) pos += wire === 1 ? 8 : 4;
        else throw new Error();
        if (pos > buffer.length) throw new Error();
    }
    return result;
}
const python = `from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime,timedelta,timezone
import ipaddress,json
k=rsa.generate_private_key(public_exponent=65537,key_size=2048)
n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'127.0.0.1')])
c=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc)-timedelta(days=1)).not_valid_after(datetime.now(timezone.utc)+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(k,hashes.SHA256())
print(json.dumps({'key':k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()).decode(),'cert':c.public_bytes(serialization.Encoding.PEM).decode()}))`;
async function main() {
    const featureArgs = process.env.EDGE_PROBE_SYSTEM_DEFAULT === '1' ? [] : ['--disable-features=msPushWinrt'];
    const noRelay = process.env.EDGE_PROBE_NO_RELAY === '1';
    if (noRelay && featureArgs.length) throw new Error('PROBE_MODE_INVALID');
    const testWrongKey = process.env.EDGE_PROBE_TEST_WRONG_KEY === '1';
    const testRewrite = process.env.EDGE_PROBE_REWRITE_SIGNATURE === '1';
    const testIndependent = process.env.EDGE_PROBE_INDEPENDENT_RECONNECT === '1';
    const testTwoSites = process.env.EDGE_PROBE_TWO_SITES === '1';
    const testXSelector = process.env.EDGE_PROBE_X_SELECTOR === '1';
    const testTlsIsolation = process.env.EDGE_PROBE_TLS_ISOLATION === '1';
    const testBindShape = process.env.EDGE_PROBE_BIND_SHAPE === '1';
    const testSkipChallenge = process.env.EDGE_PROBE_SKIP_CHALLENGE === '1';
    const testSession = process.env.EDGE_PROBE_SESSION === '1';
    const testSessionDb = process.env.EDGE_PROBE_SESSION_DB === '1';
    const testGateway = process.env.EDGE_PROBE_GATEWAY === '1';
    if (testXSelector && (!testTwoSites || process.env.NODE_ENV !== 'test')) throw new Error('PROBE_MODE_INVALID');
    if (testTlsIsolation && (noRelay || process.env.NODE_ENV !== 'test')) throw new Error('PROBE_MODE_INVALID');
    if (testBindShape && (!testIndependent || process.env.NODE_ENV !== 'test')) throw new Error('PROBE_MODE_INVALID');
    if (testSkipChallenge && (!testIndependent || process.env.NODE_ENV !== 'test'
        || process.env.EDGE_PROBE_GENERATED_HANDSHAKE === '1' && process.env.EDGE_PROBE_CLIENT_METADATA !== '1' && !process.env.EDGE_PROBE_SYNTHETIC_CHANNEL
        || process.env.EDGE_PROBE_DURABLE === '1' && process.env.EDGE_PROBE_DURABLE_GATEWAY !== '1')) throw new Error('PROBE_MODE_INVALID');
    if (testSession && (!testIndependent || !testTwoSites || process.env.NODE_ENV !== 'test'
        || process.env.EDGE_PROBE_GENERATED_HANDSHAKE !== '1' || process.env.EDGE_PROBE_CLIENT_METADATA !== '1'
        || process.env.EDGE_PROBE_DURABLE === '1' || process.env.EDGE_PROBE_ROTATION === '1')) throw new Error('PROBE_MODE_INVALID');
    if (testSessionDb && (!testSession || Number(process.env.AUTOMATION_TEST_DB_PORT) !== 33621)) throw new Error('PROBE_MODE_INVALID');
    if (testGateway && !testSessionDb) throw new Error('PROBE_MODE_INVALID');
    const testOffline = process.env.EDGE_PROBE_OFFLINE === '1';
    const testDurable = process.env.EDGE_PROBE_DURABLE === '1';
    const testDurableFailure = process.env.EDGE_PROBE_DURABLE_FAIL_INSERT === '1';
    const testProcessCrash = process.env.EDGE_PROBE_DURABLE_PROCESS_CRASH === '1';
    const testTokenState = process.env.EDGE_PROBE_DURABLE_TOKEN_STATE === '1';
    const testProductionState = process.env.EDGE_PROBE_DURABLE_PRODUCTION_STATE === '1';
    const testDurableGateway = process.env.EDGE_PROBE_DURABLE_GATEWAY === '1';
    if (testWrongKey && (noRelay || process.env.EDGE_PROBE_RECONNECT !== '1' || process.env.EDGE_PROBE_COPY_PROFILE !== '1'
        || process.env.EDGE_PROBE_MINIMAL_PROFILE !== '1' || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1'
        || (process.env.EDGE_PROBE_OMIT_COMPONENT || '').split(',').includes('push-store'))) throw new Error('PROBE_MODE_INVALID');
    if (testRewrite && (testWrongKey || noRelay || process.env.EDGE_PROBE_RECONNECT !== '1' || process.env.EDGE_PROBE_COPY_PROFILE !== '1'
        || process.env.EDGE_PROBE_MINIMAL_PROFILE !== '1' || process.env.EDGE_PROBE_KEEP_SOCKET === '1'
        || (process.env.EDGE_PROBE_OMIT_COMPONENT || '').split(',').includes('push-store'))) throw new Error('PROBE_MODE_INVALID');
    if (testIndependent && (testRewrite || testWrongKey || noRelay && (!testSkipChallenge || process.env.EDGE_PROBE_GENERATED_HANDSHAKE !== '1'
        || !process.env.EDGE_PROBE_SYNTHETIC_CHANNEL || process.env.EDGE_PROBE_CLIENT_METADATA === '1' || testTwoSites)
        || process.env.EDGE_PROBE_RECONNECT !== '1'
        || process.env.EDGE_PROBE_COPY_PROFILE !== '1' || process.env.EDGE_PROBE_MINIMAL_PROFILE !== '1'
        || process.env.EDGE_PROBE_KEEP_SOCKET === '1' || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1'
        || (process.env.EDGE_PROBE_OMIT_COMPONENT || '').split(',').includes('push-store')))
        throw new Error('PROBE_MODE_INVALID');
    if (testTwoSites && (testRewrite || testWrongKey || noRelay || process.env.EDGE_PROBE_KEEP_SOCKET === '1'
        || !testIndependent && process.env.EDGE_PROBE_RECONNECT === '1')) throw new Error('PROBE_MODE_INVALID');
    if (testOffline && (!testIndependent || testTwoSites || process.env.EDGE_PROBE_ROTATION !== '1'
        || process.env.EDGE_PROBE_GENERATED_HANDSHAKE !== '1' || process.env.EDGE_PROBE_ACK_FOLLOWUP === '1'
        || process.env.EDGE_PROBE_USE_STALE_TOKEN === '1')) throw new Error('PROBE_MODE_INVALID');
    if (testDurable && (!testIndependent || !testTwoSites || process.env.NODE_ENV !== 'test' || Number(process.env.AUTOMATION_TEST_DB_PORT) !== 33621
        || process.env.EDGE_PROBE_GENERATED_HANDSHAKE !== '1' || process.env.EDGE_PROBE_ROTATION === '1' || process.env.EDGE_PROBE_ACK_FOLLOWUP === '1'))
        throw new Error('PROBE_MODE_INVALID');
    if (testDurableFailure && !testDurable) throw new Error('PROBE_MODE_INVALID');
    if (testProcessCrash && (!testDurable || testDurableFailure)) throw new Error('PROBE_MODE_INVALID');
    if (testTokenState && !testProcessCrash) throw new Error('PROBE_MODE_INVALID');
    if (testProductionState && !testTokenState) throw new Error('PROBE_MODE_INVALID');
    if (testDurableGateway && !testProductionState) throw new Error('PROBE_MODE_INVALID');
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-wns-probe-'));
    let browser, cdp, pageServer, relay, untrustedServer, durableDb, browserReceived = false, copiedProfileResult = null, detachedConnectionResult = null, independentResult = null, durableResult = null, routingResult = null, handshakeShape = null, handshakeRelations = null, bindShape = null, relationDeviceRecord = null, relationSiteRecord = null, independentWebPush = null, independentChannel = null, productConstants = null, capturedCipherDecrypted = null, appServerKeyMatches = null, deviceFields, expectedCipher, otherCipher, expectedNextCipher, otherNextCipher, tlsIsolationVerified = false; const sockets = new Set(), events = [], exchangeShapes = [];
    const browserEvents = { initial: 0, second: 0, third: 0, fourth: 0, copy: 0, other: 0 };
    let probeStage = 'setup', previousServerNonce = null; const nativePfx = [];
    try {
        if (testIndependent && !testSkipChallenge || process.env.EDGE_PROBE_COMPARE_CHALLENGE === '1') productConstants = await readSyntheticProductConstants();
        const createCertificate = () => {
            if (process.env.EDGE_PROBE_NATIVE_CERT !== '1') {
                const output = spawnSync('python', ['-c', python], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
                if (output.status !== 0) throw new Error('PROBE_CERT_FAILED');
                const config = JSON.parse(output.stdout); return { config, certificate: config.cert };
            }
            if (process.env.NODE_ENV !== 'test' || process.platform !== 'win32') throw new Error('PROBE_MODE_INVALID');
            const helper = path.resolve(__dirname, '../../client/angelic-setup/EdgeEphemeralCertificate.ps1').replace(/'/g, "''");
            const command = `$ErrorActionPreference='Stop'; . '${helper}'; $c=New-XEdgeEphemeralCertificate; try { [ordered]@{pfx=[Convert]::ToBase64String($c.pfx);password=$c.password;certificate=[Convert]::ToBase64String($c.certificate)}|ConvertTo-Json -Compress } finally { [Array]::Clear($c.pfx,0,$c.pfx.Length);[Array]::Clear($c.certificate,0,$c.certificate.Length) }`;
            const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                { encoding: 'utf8', windowsHide: true, timeout: 10000 });
            if (output.status !== 0) throw new Error('PROBE_CERT_FAILED');
            const parsed = JSON.parse(output.stdout), pfx = Buffer.from(parsed.pfx, 'base64'); nativePfx.push(pfx);
            return { config: { pfx, passphrase: parsed.password }, certificate: Buffer.from(parsed.certificate, 'base64') };
        };
        const cert = createCertificate(), tlsConfig = cert.config;
        const relaySpki = createHash('sha256').update(new X509Certificate(cert.certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
        if (testTlsIsolation) {
            const otherCert = createCertificate();
            let unexpectedRequests = 0;
            untrustedServer = https.createServer(otherCert.config, (_req, res) => { unexpectedRequests++; res.end('synthetic'); });
            untrustedServer.unexpectedRequests = () => unexpectedRequests;
            await new Promise(resolve => untrustedServer.listen(0, '127.0.0.1', resolve));
        }
        relay = tls.createServer({ ...tlsConfig, ALPNProtocols: ['h2', 'http/1.1'] }, incoming => {
            incoming.pause();
            sockets.add(incoming); incoming.once('close', () => sockets.delete(incoming));
            const upstream = tls.connect({ host: 'client.wns.windows.com', port: 443, servername: 'client.wns.windows.com',
                rejectUnauthorized: true, ALPNProtocols: incoming.alpnProtocol ? [incoming.alpnProtocol] : ['http/1.1'] });
            sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
            const event = { clientAlpn: incoming.alpnProtocol || null, upstreamAlpn: null, sentChunks: 0, receivedChunks: 0,
                sentBytes: 0, receivedBytes: 0, firstSend: null }; events.push(event);
            const sent = [], received = [];
            event.fixtureBindResponses = () => fixtureBindResponses(received);
            event.fixtureSentFrames = () => selectSyntheticHandshake(sent);
            event.fixtureRelations = frames => syntheticHandshakeRelations(frames, received, deviceFields);
            event.fixtureRouting = (first, second, firstRecord, secondRecord) => compareSyntheticRouting(received, first, second, firstRecord, secondRecord);
            event.fixtureRecipient = (first, second, channel) => syntheticRecipientProof(received, first, second, channel);
            event.fixtureChannelStability = (first, next, other, otherNext) => syntheticChannelStability(received, first, next, other, otherNext);
            event.upstreamOpen = () => !upstream.destroyed;
            event.closeFixtureConnection = () => upstream.destroy();
            event.containsFixtureCipher = () => {
                if (!expectedCipher) return false;
                const captured = Buffer.concat(received), found = captured.includes(expectedCipher); captured.fill(0); return found;
            };
            event.acknowledgeSyntheticSecond = async () => {
                // Experimental local fixture only. Parse identifiers in memory
                // from the existing connection; never output their values.
                const find = (chunks, verb, wantedIndex) => {
                    const data = Buffer.concat(chunks); let pos = 0, found = 0;
                    try {
                        while (pos < data.length) {
                            const end = data.indexOf('\r\n', pos); if (end < pos || end - pos > 512) return null;
                            const parts = data.subarray(pos, end).toString('ascii').split(' '), sizeText = parts.at(-1);
                            if (!/^\d{1,6}$/.test(sizeText)) return null;
                            const begin = end + 2, finish = begin + Number(sizeText); if (finish > data.length) return null;
                            if (parts[0] === verb && parts.includes('WNS\\NOTIF') && found++ === wantedIndex) {
                                const split = data.indexOf('\r\n\r\n', begin); if (split < begin || split + 4 > finish) return null;
                                const headers = new Map(data.subarray(begin, split).toString('ascii').split('\r\n').map(line => {
                                    const separator = line.indexOf(':'); return separator < 1 ? ['', ''] : [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
                                }));
                                return { parts, headers };
                            }
                            pos = finish;
                        }
                        return null;
                    } finally { data.fill(0); }
                };
                const firstAck = find(sent, 'ACK', 0), secondNotification = find(received, 'NFY', 1);
                const sequence = firstAck?.parts[1], channel = secondNotification?.parts[3];
                const correlation = firstAck?.headers.get('ms-cv'), messageId = secondNotification?.headers.get('msg-id');
                const safe = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
                if (!/^\d{1,8}$/.test(sequence || '') || !/^[0-9a-f]{1,16}$/i.test(channel || '') || !safe(correlation) || !safe(messageId)) throw new Error('PROBE_ACK_SHAPE_INVALID');
                const headers = Buffer.from(`MS-CV: ${correlation}\r\nMsg-Id: ${messageId}\r\n\r\n`, 'ascii');
                const wire = Buffer.concat([Buffer.from(`ACK ${Number(sequence) + 1} WNS\\NOTIF ${channel} ${headers.length}\r\n`, 'ascii'), headers]);
                try { await new Promise((resolve, reject) => upstream.write(wire, error => error ? reject(new Error('PROBE_ACK_WRITE_FAILED')) : resolve())); }
                finally { wire.fill(0); headers.fill(0); }
            };
            event.fixtureAcknowledgementAnalysis = () => {
                // Derive only equality relationships and header names from
                // this local fixture. Never emit any identifiers or values.
                const scan = (chunks, wanted) => {
                    const data = Buffer.concat(chunks); let pos = 0;
                    try {
                        while (pos < data.length) {
                            const end = data.indexOf('\r\n', pos); if (end < pos || end - pos > 512) return null;
                            const parts = data.subarray(pos, end).toString('ascii').split(' '), length = Number(parts.at(-1)), begin = end + 2, finish = begin + length;
                            if (!Number.isSafeInteger(length) || length < 0 || length > 262144 || finish > data.length) return null;
                            if (parts[0] === wanted && (wanted === 'CNT' || parts.includes('WNS\\NOTIF'))) {
                                const separator = data.indexOf('\r\n\r\n', begin); if (separator < begin || separator + 4 > finish) return null;
                                const lines = data.subarray(begin, separator).toString('ascii').split('\r\n');
                                const headers = lines.map(line => { const index = line.indexOf(':'); return index < 1 ? null : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()]; }).filter(Boolean);
                                return { parts, headers, bodyLength: finish - separator - 4 };
                            }
                            pos = finish;
                        }
                        return null;
                    } finally { data.fill(0); }
                };
                const notification = scan(received, 'NFY'), ack = scan(sent, 'ACK'), connect = scan(sent, 'CNT');
                if (!notification || !ack) return null;
                const safeHeaderName = name => /^[a-z][a-z-]{0,40}$/.test(name) ? name : 'other';
                return { notificationParts: notification.parts.length, acknowledgementParts: ack.parts.length, acknowledgementBodyBytes: ack.bodyLength,
                    notificationSequenceNumeric: /^\d+$/.test(notification.parts[1]), acknowledgementSequenceNumeric: /^\d+$/.test(ack.parts[1]),
                    sequenceDifference: /^\d{1,9}$/.test(notification.parts[1]) && /^\d{1,9}$/.test(ack.parts[1]) ? Number(ack.parts[1]) - Number(notification.parts[1]) : null,
                    equalPartPositions: ack.parts.flatMap((value, left) => notification.parts.flatMap((other, right) => value === other && left !== 0 && right !== 0 ? [[left, right]] : [])),
                    acknowledgementHeaders: ack.headers.map(([name]) => safeHeaderName(name)),
                    matchingHeaderNames: ack.headers.filter(([name, value]) => notification.headers.some(([otherName, otherValue]) => name === otherName && value === otherValue)).map(([name]) => safeHeaderName(name)),
                    correlationMatchesNotification: ack.headers.some(([name, value]) => name === 'ms-cv' && notification.headers.some(([otherName, otherValue]) => otherName === name && otherValue === value)),
                    correlationMatchesConnect: ack.headers.some(([name, value]) => name === 'ms-cv' && connect?.headers.some(([otherName, otherValue]) => otherName === name && otherValue === value)) };
            };
            event.fixtureCipher = (index = 0) => {
                if (!expectedCipher) return null;
                // Parse the WNS frame without using the known ciphertext as a
                // delimiter, then compare only this synthetic test payload.
                const captured = firstFixtureNotification(received, index);
                if (!captured?.equals(expectedCipher)) { captured?.fill(0); return null; }
                return captured;
            };
            event.fixtureLayout = () => {
                if (!expectedCipher) return null;
                const combined = Buffer.concat(received), offset = combined.indexOf(expectedCipher);
                const start = offset < 0 ? -1 : combined.lastIndexOf(Buffer.from('NFY '), offset);
                if (start < 0) { combined.fill(0); return null; }
                const prefix = combined.subarray(start, offset).toString('latin1');
                const allowed = new Set(['context', 'content-type', 'content-length', 'content-encoding', 'encryption', 'crypto-key',
                    'x-wns-type', 'x-wns-id', 'x-wns-tag', 'ms-cv']);
                const headerNames = [...prefix.matchAll(/(?:^|\r\n)([A-Za-z][A-Za-z0-9-]{0,63}):/g)]
                    .map(match => match[1].toLowerCase()).filter(name => allowed.has(name));
                const separator = combined.indexOf(Buffer.from('\r\n\r\n'), start);
                const layout = { cipherOffset: offset - start, cipherBytes: expectedCipher.length,
                    firstHeaderEnd: separator >= start && separator < offset ? separator + 4 - start : null,
                    headerNames: [...new Set(headerNames)] };
                combined.fill(0); return layout;
            };
            incoming.on('data', chunk => { event.sentChunks++; event.sentBytes += chunk.length;
                if (event.sentBytes <= 262144) sent.push(Buffer.from(chunk));
                if (event.firstSend === null) event.firstSend = chunk.subarray(0, 14).toString('ascii').startsWith('PRI * HTTP/2.0') ? 'http2'
                    : /^(GET|POST|PUT|CONNECT) /.test(chunk.subarray(0, 12).toString('ascii')) ? 'http1' : 'binary'; });
            upstream.on('data', chunk => { event.receivedChunks++; event.receivedBytes += chunk.length; if (event.receivedBytes <= 262144) received.push(Buffer.from(chunk)); });
            event.describe = () => {
                const tags = ['wns', 'connect', 'ver', 'client', 'name', 'agent', 'os', 'osVer', 'proc', 'lcid', 'device', 'provision', 'reconnect-token', 'nonce', 'signature', 'challenge', 'appId', 'response', 'apppublickey', 'domain', 'channel', 'appkey', 'properties', 'crl', 'entry', 'id'];
                const commands = ['CON\\DEVICE', 'CON\\WNS', 'WNS\\CHALLENGE', 'WNS\\CHANNEL', 'WNS\\NOTIF', 'WNS\\CRL'];
                let cross = null;
                if (deviceFields?.[3]) {
                    const sentText = Buffer.concat(sent).toString('latin1'), receivedText = Buffer.concat(received).toString('latin1');
                    const values = (text, tag) => [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map(match => match[1]);
                    const nonces = [...values(sentText, 'nonce').map(value => ({ side: 'sent', value })),
                        ...values(receivedText, 'nonce').map(value => ({ side: 'received', value }))];
                    const signatures = values(sentText, 'signature');
                    const keyText = deviceFields[3].toString('utf8'), keys = { text: Buffer.from(keyText), base64: Buffer.from(keyText, 'base64') };
                    const token = deviceFields[2]?.toString('utf8') || '';
                    const matches = [];
                    for (const [index, nonce] of nonces.entries()) {
                        const variants = { text: Buffer.from(nonce.value), hex: Buffer.from(nonce.value, 'hex'), base64: Buffer.from(nonce.value, 'base64'),
                            upper: Buffer.from(nonce.value.toUpperCase()), lower: Buffer.from(nonce.value.toLowerCase()), utf16: Buffer.from(nonce.value, 'utf16le'),
                            tokenThenNonce: Buffer.from(token + nonce.value), nonceThenToken: Buffer.from(nonce.value + token) };
                        for (const [keyName, key] of Object.entries(keys)) for (const [variant, data] of Object.entries(variants)) {
                            for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
                                const digest = createHmac(algorithm, key).update(data).digest();
                                for (const size of new Set([16, digest.length])) for (const signature of signatures)
                                    if (digest.subarray(0, size).toString('base64') === signature) matches.push(`${nonce.side}:${index}:${keyName}:${variant}:${algorithm}:${size}`);
                                digest.fill(0);
                            }
                        }
                        for (const data of Object.values(variants)) data.fill(0);
                    }
                    const pairedNonceMatches = [];
                    const clientNonce = values(sentText, 'nonce')[0], serverNonces = values(receivedText, 'nonce');
                    const pairedNonceCompared = Boolean(previousServerNonce && clientNonce && signatures.length);
                    if (pairedNonceCompared) {
                        const encodings = value => ({ text: Buffer.from(value), hex: Buffer.from(value, 'hex'), utf16: Buffer.from(value, 'utf16le') });
                        const left = encodings(previousServerNonce), right = encodings(clientNonce);
                        for (const [leftName, leftBytes] of Object.entries(left)) for (const [rightName, rightBytes] of Object.entries(right)) {
                            for (const separator of ['', ':', '|', '\0']) for (const reverse of [false, true]) {
                                const data = Buffer.concat(reverse ? [rightBytes, Buffer.from(separator), leftBytes] : [leftBytes, Buffer.from(separator), rightBytes]);
                                for (const [keyName, key] of Object.entries(keys)) for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
                                    const digest = createHmac(algorithm, key).update(data).digest();
                                    if (signatures.includes(digest.subarray(0, 16).toString('base64')))
                                        pairedNonceMatches.push(`${leftName}:${rightName}:${separator ? 'separator' : 'none'}:${reverse ? 'reverse' : 'forward'}:${keyName}:${algorithm}`);
                                    digest.fill(0);
                                }
                                data.fill(0);
                            }
                        }
                        for (const data of [...Object.values(left), ...Object.values(right)]) data.fill(0);
                    }
                    if (serverNonces.length) previousServerNonce = serverNonces.at(-1);
                    for (const key of Object.values(keys)) key.fill(0);
                    let challengeCandidateMatches = null, productIdMatches = null;
                    if (productConstants) {
                        const appIds = values(sentText, 'appId'), responses = values(sentText, 'response');
                        if (appIds.length === 1 && responses.length === 1 && serverNonces.length === 1) {
                            productIdMatches = Buffer.from(appIds[0], 'ascii').equals(productConstants.id);
                            const candidate = syntheticChallengeResponse(serverNonces[0], productConstants.key, productConstants.id);
                            try { challengeCandidateMatches = candidate.toString('hex').toLowerCase() === responses[0].toLowerCase(); }
                            finally { candidate.fill(0); }
                        }
                    }
                    cross = { nonceCounts: { sent: values(sentText, 'nonce').length, received: values(receivedText, 'nonce').length }, signatureCount: signatures.length,
                        hmacMatches: matches, pairedNonceCompared, pairedNonceMatches, challengeCandidateMatches, productIdMatches };
                }
                const describe = chunks => { const b = Buffer.concat(chunks), text = b.toString('latin1');
                    const frames = chunks.map(chunk => { const end = chunk.indexOf('\r\n');
                        const header = end >= 0 && end < 512 ? chunk.subarray(0, end).toString('latin1').split(/\s+/).filter(Boolean) : [];
                        const headerShape = header.map(part => commands.includes(part) || /^WNS\/\d(?:\.\d)?$/.test(part) || /^[A-Z]{3}$/.test(part) ? part
                            : /^[0-9]+$/.test(part) ? `decimal(${part.length})` : `other(${part.length})`);
                        const declared = header.length && /^[0-9]+$/.test(header.at(-1)) ? Number(header.at(-1)) : null;
                        return { bytes: chunk.length, headerShape,
                        declaredMinusRemaining: declared !== null && Number.isSafeInteger(declared) && end >= 0 ? declared - (chunk.length - end - 2) : null,
                        first32LeMinusSize: chunk.length >= 4 && Math.abs(chunk.readUInt32LE(0) - chunk.length) <= 64 ? chunk.readUInt32LE(0) - chunk.length : null,
                        first32BeMinusSize: chunk.length >= 4 && Math.abs(chunk.readUInt32BE(0) - chunk.length) <= 64 ? chunk.readUInt32BE(0) - chunk.length : null,
                        xmlOffset: chunk.indexOf('<'), commandOffsets: commands.map(name => chunk.indexOf(name)).filter(offset => offset >= 0),
                        tags: tags.filter(tag => chunk.includes(Buffer.from(`<${tag}>`)) || chunk.includes(Buffer.from(`<${tag} `))) }; });
                    const result = { tags: tags.filter(tag => text.includes(`<${tag}>`) || text.includes(`<${tag} `)), commands: commands.filter(name => text.includes(name)), frames,
                        fixtureCipherRaw: Boolean(expectedCipher && b.includes(expectedCipher)),
                        fixtureCipherBase64: Boolean(expectedCipher && text.includes(expectedCipher.toString('base64'))) };
                    if (deviceFields) {
                        const tag = name => { const match = text.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return match ? match[1] : null; };
                        const token = tag('reconnect-token'), nonce = tag('nonce'), signature = tag('signature');
                        result.deviceTokenMatches = Boolean(token && deviceFields[2] && token === deviceFields[2].toString('utf8'));
                        const storedText = deviceFields[3]?.toString('utf8') || '', storedDecoded = Buffer.from(storedText, 'base64');
                        result.containsStoredKeyText = Boolean(storedText && text.includes(storedText));
                        result.containsStoredKeyBytes = storedDecoded.length > 0 && b.includes(storedDecoded);
                        storedDecoded.fill(0);
                        if (nonce && signature && deviceFields[3]) {
                            const stored = deviceFields[3].toString('utf8');
                            result.cryptoShape = { storedKeyBytes: deviceFields[3].length, storedKeyBase64: /^[A-Za-z0-9+/]+={0,2}$/.test(stored),
                                nonceLength: nonce.length, nonceBase64: /^[A-Za-z0-9+/]+={0,2}$/.test(nonce), nonceHex: /^[0-9a-f]+$/i.test(nonce),
                                signatureLength: signature.length, signatureBase64: /^[A-Za-z0-9+/]+={0,2}$/.test(signature), signatureHex: /^[0-9a-f]+$/i.test(signature) };
                            const decodedKey = Buffer.from(stored, 'base64');
                            const syntheticSignature = syntheticReconnectSignature(decodedKey, token, nonce);
                            result.inferredSignatureMatches = syntheticSignature.toString('base64') === signature;
                            syntheticSignature.fill(0);
                            // Test a single inferred format on synthetic data only.
                            // No key, token, nonce, digest or signature is logged.
                            const candidateInput = Buffer.from((token || '') + nonce, 'utf8');
                            const digest = createHmac('sha256', decodedKey).update(candidateInput).digest();
                            const versioned = Buffer.concat([Buffer.from([1]), digest.subarray(0, 16)]);
                            result.versionedTokenNonceHmac = versioned.toString('base64') === signature;
                            candidateInput.fill(0); digest.fill(0); versioned.fill(0);
                            result.versionedHmacMatches = [];
                            for (const [keyLabel, keyBytes] of [['decoded', decodedKey], ['text', Buffer.from(stored, 'utf8')]]) {
                                for (const [messageLabel, message] of [['token-nonce', (token || '') + nonce], ['nonce-token', nonce + (token || '')]]) {
                                    for (const algorithm of ['sha256', 'sha1', 'sha512']) {
                                        const mac = createHmac(algorithm, keyBytes).update(message, 'utf8').digest();
                                        for (const [partLabel, part] of [['first', mac.subarray(0, 16)], ['last', mac.subarray(-16)]]) {
                                            for (const version of [0, 1, 2, 49]) for (const placement of ['prefix', 'suffix']) {
                                                const encoded = placement === 'prefix' ? Buffer.concat([Buffer.from([version]), part]) : Buffer.concat([part, Buffer.from([version])]);
                                                if (encoded.toString('base64') === signature) result.versionedHmacMatches.push(`${keyLabel}:${messageLabel}:${algorithm}:${partLabel}:${placement}:${version}`);
                                                encoded.fill(0);
                                            }
                                        }
                                        mac.fill(0);
                                    }
                                }
                                if (keyLabel === 'text') keyBytes.fill(0);
                            }
                            const keys = { storedText: Buffer.from(stored), storedUtf16: Buffer.from(stored, 'utf16le'), storedBase64: decodedKey,
                                first16: Buffer.from(decodedKey.subarray(0, 16)), last16: Buffer.from(decodedKey.subarray(-16)),
                                md5: createHash('md5').update(decodedKey).digest(), sha256: createHash('sha256').update(decodedKey).digest() };
                            const nonceGuid = Buffer.from(nonce, 'hex');
                            if (nonceGuid.length === 16) { nonceGuid.subarray(0, 4).reverse(); nonceGuid.subarray(4, 6).reverse(); nonceGuid.subarray(6, 8).reverse(); }
                            const uuid = nonce.length === 32 ? `${nonce.slice(0, 8)}-${nonce.slice(8, 12)}-${nonce.slice(12, 16)}-${nonce.slice(16, 20)}-${nonce.slice(20)}` : nonce;
                            const data = { nonceText: Buffer.from(nonce), nonceBase64: Buffer.from(nonce, 'base64'), nonceHex: Buffer.from(nonce, 'hex'),
                                nonceGuid, nonceUtf16: Buffer.from(nonce, 'utf16le'), uuid: Buffer.from(uuid), uuidUpper: Buffer.from(uuid.toUpperCase()),
                                tokenText: Buffer.from(token || ''), tokenThenNonce: Buffer.from((token || '') + nonce), nonceThenToken: Buffer.from(nonce + (token || '')),
                                tokenColonNonce: Buffer.from((token || '') + ':' + nonce), nonceColonToken: Buffer.from(nonce + ':' + (token || '')) };
                            data.tokenBase64ThenNonceHex = Buffer.concat([Buffer.from(token || '', 'base64'), Buffer.from(nonce, 'hex')]);
                            data.nonceHexThenTokenBase64 = Buffer.concat([Buffer.from(nonce, 'hex'), Buffer.from(token || '', 'base64')]);
                            data.tokenThenNonceUtf16 = Buffer.from((token || '') + nonce, 'utf16le');
                            data.nonceThenTokenUtf16 = Buffer.from(nonce + (token || ''), 'utf16le');
                            data.nonceTextNull = Buffer.concat([data.nonceText, Buffer.from([0])]);
                            data.nonceUtf16Null = Buffer.concat([data.nonceUtf16, Buffer.from([0, 0])]);
                            data.tokenNullNonce = Buffer.concat([data.tokenText, Buffer.from([0]), data.nonceText]);
                            data.nonceNullToken = Buffer.concat([data.nonceText, Buffer.from([0]), data.tokenText]);
                            result.hmacMatches = [];
                            for (const [keyName, key] of Object.entries(keys)) for (const [dataName, payload] of Object.entries(data)) {
                                for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
                                    const digest = createHmac(algorithm, key).update(payload).digest();
                                    for (const size of [digest.length, 16]) {
                                        const candidate = digest.subarray(0, size);
                                        if ([candidate.toString('base64'), candidate.toString('base64url'), candidate.toString('hex'), candidate.toString('hex').toUpperCase()].includes(signature))
                                            result.hmacMatches.push(`${keyName}:${dataName}:${algorithm}:${size}`);
                                    }
                                    digest.fill(0);
                                }
                            }
                            result.otherMatches = [];
                            for (const [keyName, key] of Object.entries(keys)) for (const [dataName, payload] of Object.entries(data)) {
                                for (const [order, value] of [['keyThenData', Buffer.concat([key, payload])], ['dataThenKey', Buffer.concat([payload, key])]]) {
                                    const digest = createHash('md5').update(value).digest();
                                    if (digest.toString('base64') === signature) result.otherMatches.push(`${keyName}:${dataName}:md5:${order}`);
                                    value.fill(0); digest.fill(0);
                                }
                                for (const [suffix, candidateKey] of [['full', key], ['first16', key.subarray(0, 16)], ['last16', key.subarray(-16)]]) {
                                    const digest = cmac(candidateKey, payload);
                                    if (digest?.toString('base64') === signature) result.otherMatches.push(`${keyName}:${dataName}:cmac:${suffix}`);
                                    digest?.fill(0);
                                    if ([16, 32].includes(candidateKey.length) && payload.length === 16) {
                                        const cipher = createCipheriv(`aes-${candidateKey.length * 8}-ecb`, candidateKey, null); cipher.setAutoPadding(false);
                                        const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
                                        if (encrypted.toString('base64') === signature) result.otherMatches.push(`${keyName}:${dataName}:aes-ecb:${suffix}`);
                                        encrypted.fill(0);
                                    }
                                }
                            }
                            const tokenBuffers = { text: Buffer.from(token || ''), base64: Buffer.from(token || '', 'base64') };
                            for (const [keyName, key] of Object.entries(keys)) for (const [tokenName, tokenBytes] of Object.entries(tokenBuffers)) {
                                for (const [nonceName, nonceBytes] of [['text', data.nonceText], ['hex', data.nonceHex], ['guid', data.nonceGuid]]) {
                                    for (const [label, parts] of [['tokenKeyNonce', [tokenBytes, key, nonceBytes]], ['nonceKeyToken', [nonceBytes, key, tokenBytes]]]) {
                                        const joined = Buffer.concat(parts), digest = createHash('md5').update(joined).digest();
                                        if (digest.toString('base64') === signature) result.otherMatches.push(`${keyName}:${tokenName}:${nonceName}:md5:${label}`);
                                        joined.fill(0); digest.fill(0);
                                    }
                                }
                            }
                            for (const value of Object.values(tokenBuffers)) value.fill(0);
                            for (const value of [...Object.values(keys), ...Object.values(data)]) value.fill(0);
                        }
                    }
                    b.fill(0); for (const chunk of chunks) chunk.fill(0); return result; };
                return { sent: describe(sent), received: describe(received), ...(cross ? { cross } : {}) };
            };
            incoming.on('error', () => { if (process.env.EDGE_PROBE_KEEP_SOCKET !== '1') upstream.destroy(); });
            incoming.on('close', () => { if (process.env.EDGE_PROBE_KEEP_SOCKET === '1') { upstream.unpipe(incoming); upstream.resume(); } });
            upstream.on('error', () => incoming.destroy());
            upstream.once('secureConnect', () => { event.upstreamAlpn = upstream.alpnProtocol || null;
                if (testRewrite && events.length === 2) {
                    if (!deviceFields?.[2] || !deviceFields?.[3]) { incoming.destroy(); upstream.destroy(); return; }
                    const nonce = String(randomInt(1, 10)) + Array.from({ length: 31 }, () => String(randomInt(0, 10))).join('');
                    const rewriter = createSyntheticRewriteStream({ key: Buffer.from(deviceFields[3].toString('ascii'), 'base64'),
                        token: deviceFields[2].toString('utf8'), nonce, onRewrite: () => { event.signatureRewritten = true; } });
                    rewriter.on('error', () => { incoming.destroy(); upstream.destroy(); });
                    incoming.pipe(rewriter).pipe(upstream);
                } else incoming.pipe(upstream, { end: process.env.EDGE_PROBE_KEEP_SOCKET !== '1' });
                upstream.pipe(incoming); });
        });
        await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
        const vapid = webpush.generateVAPIDKeys(); webpush.setVapidDetails('mailto:test@example.com', vapid.publicKey, vapid.privateKey);
        pageServer = http.createServer((req, res) => {
            if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(workerSource); }
            else if (acceptedCase(req.url, req.method)) { const kind = acceptedCase(req.url, req.method); browserEvents[kind]++; browserReceived = true; res.writeHead(204); res.end(); }
            else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<script>window.key=${JSON.stringify(vapid.publicKey)}</script>`); }
        });
        await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${pageServer.address().port}`, profile = path.join(root, 'profile');
        // Trust only this ephemeral relay key. Ordinary X HTTPS connections
        // retain normal certificate verification in the dedicated profile.
        const endpointArgs = noRelay ? [] : [`--ignore-certificate-errors-spki-list=${relaySpki}`, `--edge-wns-push-server-url=https://127.0.0.1:${relay.address().port}`];
        browser = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...featureArgs,
            ...endpointArgs,
            '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
        let port;
        for (let i = 0; i < 120 && !port; i++) {
            try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); }
            if (browser.exitCode !== null) throw new Error('PROBE_BROWSER_EXITED');
        }
        if (!port) throw new Error('PROBE_BROWSER_TIMEOUT');
        cdp = await CDP({ port }); await cdp.Browser.grantPermissions({ origin, permissions: ['notifications'] });
        await cdp.Page.enable();
        if (testTlsIsolation) {
            const rejected = await cdp.Page.navigate({ url: `https://127.0.0.1:${untrustedServer.address().port}/` });
            await wait(300);
            if (!/^net::ERR_CERT_/.test(rejected.errorText || '') || untrustedServer.unexpectedRequests() !== 0) throw new Error('PROBE_TLS_ISOLATION_FAILED');
            tlsIsolationVerified = true;
        }
        const loaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
        await cdp.Page.navigate({ url: origin }); await loaded;
        let timer;
        const result = await Promise.race([cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
          try {const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
          const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.key});
          const k=s.options?.applicationServerKey;const appKey=k?btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''):null;
          return {ok:true,subscription:s.toJSON(),appKey};}
          catch(e){return {ok:false,name:e.name};}})()` }),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); })]).finally(() => clearTimeout(timer));
        const value = result?.result?.value || { ok: false, name: 'Timeout' };
        if (process.env.EDGE_PROBE_APP_KEY === '1' && (!value.ok || value.appKey !== vapid.publicKey)) throw new Error('PROBE_APP_KEY_MISMATCH');
        let otherSubscription, otherOrigin;
        if (value.ok) {
            expectedCipher = await sendFixture(value.subscription, 'synthetic-wns-probe');
            for (let i = 0; i < 80 && !browserReceived; i++) await wait(100);
        }
        if (testTwoSites) {
            if (!value.ok || !browserEvents.initial) throw new Error('PROBE_TWO_SITE_INITIAL_FAILED');
            otherOrigin = `http://localhost:${pageServer.address().port}`;
            await cdp.Browser.grantPermissions({ origin: otherOrigin, permissions: ['notifications'] });
            const otherLoaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
            await cdp.Page.navigate({ url: otherOrigin }); await otherLoaded;
            const other = await cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
                const registration=await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
                const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.key}); return subscription.toJSON(); })()` });
            if (other.exceptionDetails || !other.result?.value?.endpoint) throw new Error('PROBE_TWO_SITE_SUBSCRIBE_FAILED');
            otherSubscription = other.result.value;
            otherCipher = await sendFixture(otherSubscription, 'synthetic-other-site');
            for (let i = 0; i < 80 && !browserEvents.other; i++) await wait(100);
            if (!browserEvents.other) throw new Error('PROBE_TWO_SITE_RECEIVE_FAILED');
            expectedNextCipher = await sendFixture(value.subscription, 'synthetic-wns-probe');
            for (let i = 0; i < 80 && browserEvents.initial < 2; i++) await wait(100);
            if (browserEvents.initial < 2) throw new Error('PROBE_TWO_SITE_RECEIVE_FAILED');
            otherNextCipher = await sendFixture(otherSubscription, 'synthetic-other-site');
            for (let i = 0; i < 80 && browserEvents.other < 2; i++) await wait(100);
            if (browserEvents.other < 2) throw new Error('PROBE_TWO_SITE_RECEIVE_FAILED');
            await cdp.Browser.close().catch(() => {}); await cdp.close().catch(() => {}); cdp = null;
            if (browser.exitCode === null) await new Promise(resolve => browser.once('exit', resolve));
            const store = new ClassicLevel(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'),
                { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
            let firstRecord, otherRecord, syntheticDeviceRecord; const unknownRecords = [];
            const counts = { device: 0, target: 0, other: 0, unknown: 0 };
            try {
                await store.open();
                for await (const [_key, stored] of store.iterator({ limit: 128 })) {
                    const belongs = (site, subscription) => stored.includes(Buffer.from(site))
                        && stored.includes(Buffer.from(subscription.keys.p256dh, 'base64url')) && stored.includes(Buffer.from(subscription.keys.auth, 'base64url'));
                    if (belongs(origin, value.subscription)) { if (firstRecord) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS'); firstRecord = Buffer.from(stored); }
                    if (belongs(otherOrigin, otherSubscription)) { if (otherRecord) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS'); otherRecord = Buffer.from(stored); }
                    if (_key.toString('utf8').toLowerCase().includes('device')) {
                        counts.device++; if (process.env.EDGE_PROBE_ENUMERATE === '1') syntheticDeviceRecord = Buffer.from(stored);
                    }
                    else if (belongs(origin, value.subscription)) counts.target++;
                    else if (belongs(otherOrigin, otherSubscription)) counts.other++;
                    else {
                        counts.unknown++;
                        if (process.env.EDGE_PROBE_ENUMERATE === '1') {
                            unknownRecords.push(Buffer.from(stored));
                            const name = _key.toString('utf8').toLowerCase();
                            if (counts.unknownCommonPrefix === undefined) counts.unknownCommonPrefix = name;
                            else {
                                let index = 0; while (index < counts.unknownCommonPrefix.length && index < name.length && counts.unknownCommonPrefix[index] === name[index]) index++;
                                counts.unknownCommonPrefix = counts.unknownCommonPrefix.slice(0, index);
                            }
                            const words = ['version', 'registration', 'push', 'channel', 'entry', 'metadata', 'application', 'subscription', 'record', 'token', 'key', 'message', 'mapping', 'timestamp', 'metric', 'report', 'sample', 'status', 'event'];
                            counts.unknownShapes ||= [];
                            counts.unknownShapes.push({ keyLength: _key.length, valueLength: stored.length,
                                knownWords: words.filter(word => name.includes(word)), pushOffset: name.indexOf('push'), subscriptionOffset: name.indexOf('subscription'),
                                prefixDigits: /^push_subscription_\d{6}-/.test(name),
                                keyShape: name.replace(/[a-z0-9]/g, 'x').replace(/[^x:/_.-]/g, '?'), hasSyntheticOrigin: name.includes(origin.toLowerCase()) || name.includes(otherOrigin.toLowerCase()) });
                        }
                    }
                }
                if (!firstRecord || !otherRecord || events.length !== 1) throw new Error('PROBE_TWO_SITE_RECORD_FAILED');
                routingResult = events[0].fixtureRouting(expectedCipher, otherCipher, firstRecord, otherRecord);
                if (process.env.EDGE_PROBE_ENUMERATE === '1') {
                    // Only a shared literal prefix is reported, never a record key.
                    counts.unknownCommonPrefixLength = (counts.unknownCommonPrefix || '').length;
                    counts.unknownCommonPrefix = /^push[_a-z.\-]{1,28}$/.test(counts.unknownCommonPrefix || '') ? counts.unknownCommonPrefix : null;
                    routingResult.recordCounts = counts;
                }
                const selected = selectSyntheticEdgeRecord([firstRecord, otherRecord], `${origin}/`);
                try {
                    if (testXSelector) {
                        const rewritten = rewriteSyntheticOrigin(firstRecord, `${origin}/`);
                        const expected = { endpoint: value.subscription.endpoint, publicKey: Buffer.from(value.subscription.keys.p256dh, 'base64url'),
                            auth: Buffer.from(value.subscription.keys.auth, 'base64url'), applicationServerKey: Buffer.from(vapid.publicKey, 'base64url') };
                        let checked;
                        try {
                            checked = selectXRecord([otherRecord, rewritten], expected);
                            if (require('../../src/automation/edge-wns-record').countOtherSiteRecords([otherRecord, rewritten]) !== 1)
                                throw new Error('PROBE_X_SELECTOR_MISMATCH');
                            if (process.env.EDGE_PROBE_ENUMERATE === '1') {
                                const partitioned = require('../../src/automation/edge-wns-record').partitionStoreRecords([syntheticDeviceRecord, rewritten, otherRecord, ...unknownRecords]);
                                counts.partitionedSites = partitioned.siteRecords.length;
                                counts.partitionedUnknown = partitioned.unknownCount;
                                if (counts.partitionedSites !== 2 || counts.partitionedUnknown !== unknownRecords.length) throw new Error('PROBE_X_SELECTOR_MISMATCH');
                                counts.unknownWithSiteOrigin = 0;
                                counts.unknownMatchingSiteInteger = 0;
                                for (const candidate of unknownRecords) {
                                    try { if (require('../../src/automation/edge-wns-record').countOtherSiteRecords([rewritten, candidate]) === 1) counts.unknownWithSiteOrigin++; }
                                    catch { /* Classify only; never expose candidate content. */ }
                                    if (candidate.length === 8) {
                                        const values = [candidate.readBigUInt64LE(), candidate.readBigUInt64BE()].filter(value => value > 0n);
                                        if (values.some(value => [firstRecord, otherRecord].some(record => matchingSyntheticRecordFields(record, value.toString(16)).length)))
                                            counts.unknownMatchingSiteInteger++;
                                    }
                                }
                            }
                            if (!checked.channel.equals(selected.channel) || !checked.privateKey.equals(selected.privateKey)
                                || !checked.publicKey.equals(selected.publicKey) || !checked.auth.equals(selected.auth)) throw new Error('PROBE_X_SELECTOR_MISMATCH');
                            routingResult.xSelectorMatchesSyntheticBrowser = true;
                        } finally { clearRecord(checked); rewritten.fill(0); for (const key of ['publicKey', 'auth', 'applicationServerKey']) expected[key].fill(0); }
                    }
                    if (testIndependent) independentChannel = Buffer.from(selected.channel);
                    const recipient = events[0].fixtureRecipient(expectedCipher, otherCipher, selected.channel);
                    const nextRecipient = events[0].fixtureRecipient(expectedNextCipher, otherNextCipher, selected.channel);
                    const stability = events[0].fixtureChannelStability(expectedCipher, expectedNextCipher, otherCipher, otherNextCipher);
                    if (!recipient.targetAccepted || recipient.otherAccepted || !nextRecipient.targetAccepted || nextRecipient.otherAccepted
                        || !stability.targetChannelStable || !stability.otherChannelStable || !stability.sitesHaveDistinctChannels) throw new Error('PROBE_TWO_SITE_ROUTING_FAILED');
                    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                    const plaintext = decryptEce(expectedCipher, { encoding: 'aes128gcm' }, { public_key: [...selected.publicKey],
                        private_key: [...selected.privateKey], auth_secret: [...selected.auth] });
                    try { routingResult = { ...routingResult, ...recipient, ...stability, targetNextAccepted: nextRecipient.targetAccepted,
                        otherNextAccepted: nextRecipient.otherAccepted, targetDecrypted: plaintext.equals(Buffer.from('synthetic-wns-probe')), otherDecryptAttempts: 0 }; }
                    finally { plaintext.fill(0); }
                    if (!routingResult.targetDecrypted) throw new Error('PROBE_TWO_SITE_DECRYPT_FAILED');
                } finally { for (const name of ['channel', 'publicKey', 'auth', 'privateKey', 'applicationServerKey']) selected[name].fill(0); }
            } finally { firstRecord?.fill(0); otherRecord?.fill(0); syntheticDeviceRecord?.fill(0); for (const item of unknownRecords) item.fill(0); await store.close().catch(() => {}); }
        }
        await wait(1000);
        if (value.ok && process.env.EDGE_PROBE_KEEP_SOCKET === '1') {
            if (process.env.EDGE_PROBE_RECONNECT === '1') throw new Error('PROBE_MODE_INVALID');
            if (cdp) { await cdp.Browser.close().catch(() => {}); await cdp.close().catch(() => {}); cdp = null; }
            if (browser.exitCode === null) await new Promise(resolve => browser.once('exit', resolve));
            const browserExited = browser.exitCode !== null;
            const initial = events[0], aliveAfterBrowserExit = initial?.upstreamOpen() === true;
            expectedCipher = await sendFixture(value.subscription, 'synthetic-after-browser-exit');
            let receivedWithoutBrowser = false;
            for (let i = 0; i < 100 && !receivedWithoutBrowser && initial?.upstreamOpen(); i++) {
                receivedWithoutBrowser = initial.containsFixtureCipher(); if (!receivedWithoutBrowser) await wait(100);
            }
            let decryptedWithoutBrowser = false;
            if (receivedWithoutBrowser) {
                const db = new ClassicLevel(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'),
                    { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
                let subscriptionFields;
                try {
                    await db.open();
                    for await (const [_key, stored] of db.iterator({ limit: 64 })) {
                        if (stored.includes(Buffer.from(origin)) && stored.includes(Buffer.from(value.subscription.keys.p256dh, 'base64url'))
                            && stored.includes(Buffer.from(value.subscription.keys.auth, 'base64url'))) {
                            if (subscriptionFields) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS');
                            subscriptionFields = protoBytes(stored, [6, 7]);
                        }
                    }
                } finally { await db.close().catch(() => {}); }
                if (!subscriptionFields?.[6] || !subscriptionFields?.[7]) throw new Error('PROBE_SUBSCRIPTION_MISSING');
                const captured = initial.fixtureCipher(1);
                if (!captured) throw new Error('PROBE_CIPHERTEXT_MISSING');
                try {
                    const jwk = createPrivateKey({ key: subscriptionFields[7], format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
                    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
                    if (!point.equals(Buffer.from(value.subscription.keys.p256dh, 'base64url'))
                        || !subscriptionFields[6].equals(Buffer.from(value.subscription.keys.auth, 'base64url'))) throw new Error('PROBE_KEY_MISMATCH');
                    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                    const plain = decryptEce(captured, { encoding: 'aes128gcm' }, { public_key: [...point],
                        private_key: [...Buffer.from(jwk.d, 'base64url')], auth_secret: [...subscriptionFields[6]] });
                    decryptedWithoutBrowser = plain.equals(Buffer.from('synthetic-after-browser-exit')); plain.fill(0);
                } finally { captured.fill(0); for (const field of Object.values(subscriptionFields)) field.fill(0); }
            }
            let syntheticAckWritten = false, laterNotificationReceived = false;
            if (receivedWithoutBrowser && (process.env.EDGE_PROBE_SYNTHETIC_ACK === '1' || process.env.EDGE_PROBE_THIRD_MESSAGE === '1')) {
                if (process.env.EDGE_PROBE_SYNTHETIC_ACK === '1') { await initial.acknowledgeSyntheticSecond(); syntheticAckWritten = true; }
                expectedCipher = await sendFixture(value.subscription, 'synthetic-after-node-ack');
                for (let i = 0; i < 100 && !laterNotificationReceived && initial.upstreamOpen(); i++) {
                    laterNotificationReceived = initial.containsFixtureCipher(); if (!laterNotificationReceived) await wait(100);
                }
            }
            let replayAfterReconnect = null;
            if (process.env.EDGE_PROBE_ACK_RECONNECT === '1' && laterNotificationReceived) {
                initial.closeFixtureConnection();
                await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
                browser = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...featureArgs,
                    ...endpointArgs,
                    '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
                let reopenedPort;
                for (let i = 0; i < 120 && !reopenedPort; i++) {
                    try { reopenedPort = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); }
                    if (browser.exitCode !== null) throw new Error('PROBE_BROWSER_EXITED');
                }
                if (!reopenedPort) throw new Error('PROBE_BROWSER_TIMEOUT');
                cdp = await CDP({ port: reopenedPort }); await cdp.Browser.grantPermissions({ origin, permissions: ['notifications'] });
                await cdp.Page.enable(); const reloaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
                await cdp.Page.navigate({ url: origin }); await reloaded;
                for (let i = 0; i < 100 && !browserEvents.second && !browserEvents.third; i++) await wait(100);
                const replaySecond = browserEvents.second > 0, replayThird = browserEvents.third > 0;
                let subscriptionTimer;
                const current = await Promise.race([cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
                    const r=await navigator.serviceWorker.ready;const s=await r.pushManager.getSubscription();return s?s.endpoint:null;})()` }),
                new Promise(resolve => { subscriptionTimer = setTimeout(() => resolve(null), 15000); })]).finally(() => clearTimeout(subscriptionTimer));
                if (!current) throw new Error('PROBE_SUBSCRIPTION_TIMEOUT');
                const sameSubscription = current.result?.value === value.subscription.endpoint;
                if (sameSubscription) {
                    await webpush.sendNotification(value.subscription, 'synthetic-after-reconnect', { TTL: 60 });
                    for (let i = 0; i < 100 && !browserEvents.fourth; i++) await wait(100);
                }
                replayAfterReconnect = { second: replaySecond, third: replayThird, sameSubscription, freshDelivery: browserEvents.fourth > 0 };
            }
            detachedConnectionResult = { browserExited, aliveAfterBrowserExit, receivedWithoutBrowser,
                decryptedWithoutBrowser, sameConnection: events.length === (replayAfterReconnect ? 2 : 1), acknowledgementSentByFixture: syntheticAckWritten, laterNotificationReceived, replayAfterReconnect };
        }
        if (value.ok && process.env.EDGE_PROBE_RECONNECT === '1') {
            if (cdp) { await cdp.Browser.close().catch(() => {}); await cdp.close().catch(() => {}); cdp = null; }
            if (browser.exitCode === null) await new Promise(resolve => browser.once('exit', resolve));
            probeStage = 'read-store';
            const db = new ClassicLevel(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'),
                { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
            let subscriptionFields, deviceKey, deviceRecord;
            try {
                await db.open();
                for await (const [key, stored] of db.iterator({ limit: 64 })) {
                    if (key.toString('utf8').toLowerCase().includes('device')) {
                        if (deviceFields) throw new Error('PROBE_DEVICE_AMBIGUOUS');
                        deviceFields = protoBytes(stored, Array.from({ length: 20 }, (_, index) => index + 1));
                        if (process.env.EDGE_PROBE_DEVICE_SELECTOR === '1') {
                            if (!testIndependent || process.env.NODE_ENV !== 'test') throw new Error('PROBE_MODE_INVALID');
                            const checked = require('../../src/automation/edge-wns-record').selectDeviceRecord(stored);
                            try {
                                if (!checked.reconnectToken.equals(deviceFields[2]) || checked.deviceKey.toString('base64') !== deviceFields[3].toString('ascii'))
                                    throw new Error('PROBE_DEVICE_INVALID');
                            } finally { checked.deviceKey.fill(0); checked.reconnectToken.fill(0); }
                        }
                        if (process.env.EDGE_PROBE_DESCRIBE_HANDSHAKE === '1') relationDeviceRecord = Buffer.from(stored);
                        if (testWrongKey) { deviceKey = Buffer.from(key); deviceRecord = Buffer.from(stored); }
                    } else if ((testIndependent || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1' || process.env.EDGE_PROBE_DESCRIBE_HANDSHAKE === '1') && stored.includes(Buffer.from(origin))
                        && stored.includes(Buffer.from(value.subscription.keys.p256dh, 'base64url'))
                        && stored.includes(Buffer.from(value.subscription.keys.auth, 'base64url'))) {
                        if (subscriptionFields || relationSiteRecord) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS');
                        if (process.env.EDGE_PROBE_DESCRIBE_HANDSHAKE === '1') relationSiteRecord = Buffer.from(stored);
                        if (testIndependent || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1') subscriptionFields = protoBytes(stored, [1, 6, 7, 16]);
                    }
                }
                if (testWrongKey) {
                    if (!deviceKey || !deviceRecord || !deviceFields?.[2] || !deviceFields?.[3]) throw new Error('PROBE_DEVICE_MISSING');
                    const altered = replaceSyntheticKey(deviceRecord, deviceFields[3]);
                    try {
                        const verify = protoBytes(altered.record, [2, 3]);
                        if (!verify[2]?.equals(deviceFields[2]) || !verify[3]?.equals(altered.key)) throw new Error('PROBE_DEVICE_INVALID');
                        await db.put(deviceKey, altered.record);
                        deviceFields[3].fill(0); deviceFields[3] = Buffer.from(altered.key);
                        for (const item of Object.values(verify)) item.fill(0);
                    } finally { altered.key.fill(0); altered.record.fill(0); deviceKey.fill(0); deviceRecord.fill(0); }
                }
            } finally { await db.close().catch(() => {}); }
            if (!deviceFields?.[2] || !deviceFields?.[3]) throw new Error('PROBE_DEVICE_MISSING');
            if (testIndependent) {
                if (!subscriptionFields?.[6] || !subscriptionFields?.[7] || !subscriptionFields?.[16]) throw new Error('PROBE_SUBSCRIPTION_MISSING');
                try {
                    if (testOffline) {
                        const channel = subscriptionFields[1];
                        if (!channel?.length || channel.length > 256 || channel.some(byte => byte < 0x21 || byte > 0x7e)) throw new Error('PROBE_SUBSCRIPTION_MISSING');
                        independentChannel = Buffer.from(channel);
                    }
                    const jwk = createPrivateKey({ key: subscriptionFields[7], format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
                    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
                    if (!publicKey.equals(Buffer.from(value.subscription.keys.p256dh, 'base64url'))
                        || !subscriptionFields[6].equals(Buffer.from(value.subscription.keys.auth, 'base64url'))
                        || !subscriptionFields[16].equals(Buffer.from(vapid.publicKey, 'base64url'))) throw new Error('PROBE_KEY_MISMATCH');
                    independentWebPush = { publicKey, privateKey: Buffer.from(jwk.d, 'base64url'), auth: Buffer.from(subscriptionFields[6]) };
                } finally { for (const field of Object.values(subscriptionFields)) field.fill(0); }
            }
            if (process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1') {
                probeStage = 'decrypt-received';
                if (!subscriptionFields?.[6] || !subscriptionFields?.[7] || !subscriptionFields?.[16]) throw new Error('PROBE_SUBSCRIPTION_MISSING');
                const captured = events[0]?.fixtureCipher();
                if (!captured) throw new Error('PROBE_CIPHERTEXT_MISSING');
                try {
                    const jwk = createPrivateKey({ key: subscriptionFields[7], format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
                    if (!subscriptionFields[6].equals(Buffer.from(value.subscription.keys.auth, 'base64url'))) throw new Error('PROBE_AUTH_MISMATCH');
                    const publicPoint = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
                    if (!publicPoint.equals(Buffer.from(value.subscription.keys.p256dh, 'base64url'))) throw new Error('PROBE_PUBLIC_MISMATCH');
                    appServerKeyMatches = subscriptionFields[16].equals(Buffer.from(vapid.publicKey, 'base64url'));
                    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                    const plain = decryptEce(captured, { encoding: 'aes128gcm' }, { public_key: [...publicPoint],
                        private_key: [...Buffer.from(jwk.d, 'base64url')], auth_secret: [...subscriptionFields[6]] });
                    capturedCipherDecrypted = plain.equals(Buffer.from('synthetic-wns-probe')); plain.fill(0);
                } finally {
                    captured.fill(0); for (const field of Object.values(subscriptionFields)) field.fill(0);
                }
            }
            const copyProfile = process.env.EDGE_PROBE_COPY_PROFILE === '1';
            const reopenProfile = copyProfile ? path.join(root, 'synthetic-profile-copy') : profile;
            if (copyProfile && process.env.EDGE_PROBE_MINIMAL_PROFILE === '1') {
                await fs.mkdir(path.join(reopenProfile, 'Default'), { recursive: true });
                const components = { 'local-state': 'Local State', preferences: path.join('Default', 'Preferences'),
                    'service-worker': path.join('Default', 'Service Worker'), 'push-store': path.join('Default', 'EdgePushStorageWithConnectTokenAndKey') };
                const omit = (process.env.EDGE_PROBE_OMIT_COMPONENT || '').split(',').filter(Boolean);
                if (omit.some(name => !Object.hasOwn(components, name)) || new Set(omit).size !== omit.length) throw new Error('PROBE_COMPONENT_INVALID');
                for (const [name, relative] of Object.entries(components)) {
                    if (omit.includes(name)) continue;
                    const source = path.join(profile, relative), target = path.join(reopenProfile, relative);
                    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
                }
            } else if (copyProfile) await fs.cp(profile, reopenProfile, { recursive: true, errorOnExist: true, force: false });
            if (copyProfile) await fs.rm(path.join(reopenProfile, 'DevToolsActivePort'), { force: true });
            browser = spawn(edge, ['--headless=new', ...(copyProfile ? ['--remote-debugging-port=0'] : []), `--user-data-dir=${reopenProfile}`, ...featureArgs,
                ...endpointArgs,
                '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
            const originalCount = events.length;
            if (!noRelay) for (let i = 0; i < 120 && events.length <= originalCount; i++) await wait(100);
            await wait(3000);
            if (copyProfile) {
                let reopenedPort;
                for (let i = 0; i < 120 && !reopenedPort; i++) {
                    try { reopenedPort = Number((await fs.readFile(path.join(reopenProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); }
                    if (browser.exitCode !== null) throw new Error('PROBE_BROWSER_EXITED');
                }
                if (!reopenedPort) throw new Error('PROBE_BROWSER_TIMEOUT');
                cdp = await CDP({ port: reopenedPort }); await cdp.Browser.grantPermissions({ origin, permissions: ['notifications'] });
                await cdp.Page.enable(); const reloaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
                await cdp.Page.navigate({ url: origin }); await reloaded;
                let reopenTimer;
                const reopened = await Promise.race([cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
                    const r=await navigator.serviceWorker.ready; const s=await r.pushManager.getSubscription(); return s ? s.endpoint : null; })()` }),
                new Promise(resolve => { reopenTimer = setTimeout(() => resolve(null), 15000); })]).finally(() => clearTimeout(reopenTimer));
                if (!reopened) throw new Error('PROBE_SUBSCRIPTION_TIMEOUT');
                const sameSubscription = reopened.result?.value === value.subscription.endpoint;
                browserReceived = false;
                if (sameSubscription) {
                    await webpush.sendNotification(value.subscription, 'synthetic-wns-copy-probe', { TTL: 60 });
                    for (let i = 0; i < 80 && !browserReceived; i++) await wait(100);
                }
                copiedProfileResult = { minimal: process.env.EDGE_PROBE_MINIMAL_PROFILE === '1', omitted: process.env.EDGE_PROBE_OMIT_COMPONENT || null, sameSubscription, receivedAfterCopy: browserReceived };
            }
        }
        if (process.env.EDGE_PROBE_DESCRIBE_HANDSHAKE === '1') {
            if (events.length !== 2) throw new Error('PROBE_DIRECT_PREREQUISITE_FAILED');
            const frames = events[1].fixtureSentFrames();
            try {
                handshakeShape = describeSyntheticHandshake(frames); handshakeRelations = events[1].fixtureRelations(frames);
                const channel = syntheticClientMetadata(frames.bnd).channel;
                handshakeRelations.deviceRecordMatches = relationDeviceRecord ? matchingSyntheticRecordFields(relationDeviceRecord, channel) : null;
                handshakeRelations.siteRecordMatches = relationSiteRecord ? matchingSyntheticRecordFields(relationSiteRecord, channel) : null;
            }
            finally { for (const frame of Object.values(frames)) frame.fill(0); }
        }
        if (process.env.EDGE_PROBE_COMPARE_CHANNEL === '1') {
            if (events.length !== 2 || typeof process.send !== 'function' || !/^[0-9a-f]{64}$/.test(process.env.EDGE_PROBE_COMPARE_SALT || ''))
                throw new Error('PROBE_MODE_INVALID');
            const frames = events[1].fixtureSentFrames(), salt = Buffer.from(process.env.EDGE_PROBE_COMPARE_SALT, 'hex');
            try {
                const metadata = syntheticClientMetadata(frames.bnd);
                const fingerprint = createHmac('sha256', salt).update(metadata.channel, 'ascii').digest('hex');
                const protocolFingerprint = createHmac('sha256', salt).update(`protocol:${metadata.protocolVersion}`, 'ascii').digest('hex');
                await new Promise((resolve, reject) => process.send({ channelFingerprint: fingerprint, protocolFingerprint }, error => error ? reject(new Error('PROBE_IPC_FAILED')) : resolve()));
            } finally { salt.fill(0); for (const frame of Object.values(frames)) frame.fill(0); }
        }
        let snapshotIoVerified = false;
        if (testIndependent) {
            if ((!noRelay && events.length !== 2) || (noRelay && events.length !== 0) || !copiedProfileResult?.sameSubscription || !copiedProfileResult?.receivedAfterCopy || !deviceFields?.[2] || !deviceFields?.[3] || !independentWebPush)
                throw new Error('PROBE_DIRECT_PREREQUISITE_FAILED');
            await cdp.Browser.close().catch(() => {}); await cdp.close().catch(() => {}); cdp = null;
            if (browser.exitCode === null) await new Promise(resolve => browser.once('exit', resolve));
            const generatedHandshake = process.env.EDGE_PROBE_GENERATED_HANDSHAKE === '1';
            let clientMetadata;
            if (generatedHandshake && process.env.EDGE_PROBE_CLIENT_METADATA === '1') {
                const captured = events[1].fixtureSentFrames();
                try { clientMetadata = syntheticClientMetadata(captured.bnd); }
                finally { for (const frame of Object.values(captured)) frame.fill(0); }
                const override = process.env.EDGE_PROBE_METADATA_OVERRIDE;
                if (override === 'channel') clientMetadata.channel = clientMetadata.channel === '100' ? '101' : '100';
                else if (override === 'name') clientMetadata.clientName = 'Synthetic client';
                else if (override === 'version') clientMetadata.clientVersion = '1.2.3.4';
                else if (override === 'protocol') clientMetadata.protocolVersion = clientMetadata.protocolVersion === '1.0' ? '1.1' : '1.0';
                else if (override) throw new Error('PROBE_MODE_INVALID');
            }
            if (generatedHandshake && process.env.EDGE_PROBE_SYNTHETIC_CHANNEL) {
                const channel = process.env.EDGE_PROBE_SYNTHETIC_CHANNEL;
                const protocolVersion = process.env.EDGE_PROBE_SYNTHETIC_PROTOCOL;
                if (process.env.EDGE_PROBE_CLIENT_METADATA === '1' || !/^[1-9]\d{2}$/.test(channel) || !/^\d\.\d$/.test(protocolVersion || ''))
                    throw new Error('PROBE_MODE_INVALID');
                clientMetadata = { channel, protocolVersion, clientName: 'Synthetic client', clientVersion: '1.2.3.4' };
            }
            const frames = generatedHandshake ? null : events[1].fixtureSentFrames(), key = Buffer.from(deviceFields[3].toString('ascii'), 'base64');
            if (process.env.EDGE_PROBE_SNAPSHOT_IO === '1') {
                if (!testSession || !testTwoSites || !testXSelector || !testSkipChallenge || !clientMetadata) throw new Error('PROBE_MODE_INVALID');
                const snapshotToken = randomBytes(16).toString('hex'), snapshotPath = path.join(root, `edge-snapshot-${snapshotToken}`);
                const snapshotDir = path.join(snapshotPath, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
                await fs.mkdir(path.dirname(snapshotDir), { recursive: true });
                await fs.cp(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'), snapshotDir, { recursive: true, errorOnExist: true, force: false });
                await fs.writeFile(path.join(snapshotPath, 'snapshot-owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-snapshot-v1', token: snapshotToken }), { flag: 'wx' });
                // Rewrite only the disposable localhost target's origin in the
                // copied DB so the fixed-X selector can be tested end to end.
                const copied = new ClassicLevel(snapshotDir, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
                let rewriteKey, rewriteValue;
                try {
                    await copied.open();
                    for await (const [candidateKey, stored] of copied.iterator({ limit: 128 })) {
                        if (stored.includes(Buffer.from(origin)) && stored.includes(Buffer.from(value.subscription.keys.p256dh, 'base64url'))
                            && stored.includes(Buffer.from(value.subscription.keys.auth, 'base64url'))) {
                            if (rewriteKey) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS');
                            rewriteKey = Buffer.from(candidateKey); rewriteValue = rewriteSyntheticOrigin(stored, `${origin}/`);
                        }
                    }
                    if (!rewriteKey) throw new Error('PROBE_SUBSCRIPTION_MISSING');
                    await copied.put(rewriteKey, rewriteValue);
                } finally { rewriteKey?.fill(0); rewriteValue?.fill(0); await copied.close().catch(() => {}); }
                const expected = { endpoint: value.subscription.endpoint, publicKey: Buffer.from(value.subscription.keys.p256dh, 'base64url'),
                    auth: Buffer.from(value.subscription.keys.auth, 'base64url'), applicationServerKey: Buffer.from(vapid.publicKey, 'base64url') };
                try {
                    const result = await require('../../src/automation/edge-wns-snapshot-io').readEdgeSnapshot({ snapshotPath, token: snapshotToken, expected,
                        browserVersion: '157.0.0.0', agent: { os: 'Windows 10', osVersion: '10.0.00000', architecture: 'x86_64', locale: 'en' }, client: clientMetadata,
                        dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }) });
                    if (result.file.push.deviceKey !== key.toString('base64url') || result.file.push.siteChannel !== independentChannel.toString('ascii')
                        || result.otherSubscriptionCount !== 1 || result.unclassifiedRecordCount < 1 || !result.otherNotificationsPossible) throw new Error('PROBE_TRANSFER_INVALID');
                    snapshotIoVerified = true;
                } finally { for (const name of ['publicKey', 'auth', 'applicationServerKey']) expected[name].fill(0); }
            }
            if (process.env.EDGE_PROBE_TRANSFER === '1') {
                if (!testSession || !testTwoSites || !testSkipChallenge || !clientMetadata || !independentChannel) throw new Error('PROBE_MODE_INVALID');
                const { normalizeEdgeTransfer } = require('../../src/automation/edge-wns-transfer');
                const publicKey = independentWebPush.publicKey;
                // Localhost fixture values only; the X scope exercises the intake contract.
                const normalized = normalizeEdgeTransfer({ format: 'x-notification-subscription', version: 3,
                    provenance: { kind: 'edge-wns', adapterVersion: '1.0.0', browserVersion: '157.0.0.0', readMethod: 'edge-wns-snapshot' },
                    push: { scope: 'https://x.com/', siteChannel: independentChannel.toString('ascii'), deviceKey: key.toString('base64url'),
                        reconnectToken: deviceFields[2].toString('ascii'), agent: { os: 'Windows 10', osVersion: '10.0.00000', architecture: 'x86_64', locale: 'en' },
                        client: clientMetadata, p256dhPublicKey: publicKey.toString('base64url'), authenticationSecret: independentWebPush.auth.toString('base64url'),
                        p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: publicKey.subarray(1, 33).toString('base64url'),
                            y: publicKey.subarray(33).toString('base64url'), d: independentWebPush.privateKey.toString('base64url') },
                        applicationServerKey: vapid.publicKey } });
                if (normalized.version !== 3) throw new Error('PROBE_TRANSFER_INVALID');
            }
            let rotatedToken, firstCipher, offlineCipher, durableCipher, durableReceiver, durableStore, durableLease, durableSubscription, durableInboxId, targetAcks = 0, targetDecrypts = 0;
            if (testDurable) {
                const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
                const { insertSubscription } = require('../../scripts/test/helpers/x-push-fixture.cjs');
                const { createXPushStore } = require('../../src/automation/x-push-store');
                durableDb = await createTestDatabase(33621);
                // Placeholder subscription supplies only the existing owner and
                // lease fence; the ciphertext uses the disposable Edge key.
                durableSubscription = await insertSubscription(durableDb);
                if (testProductionState) await durableDb.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [durableSubscription.subscriptionId]);
                const storeDb = testDurableFailure ? { ...durableDb, withDatabaseTransaction: work => durableDb.withDatabaseTransaction(query => work(async (sql, params) => {
                    const result = await query(sql, params);
                    if (sql.startsWith('INSERT INTO automation_x_push_inbox')) throw new Error('synthetic-db-failure');
                    return result;
                })) } : durableDb;
                durableStore = createXPushStore(storeDb, { leaseMs: 30000 });
                if (!testProcessCrash) {
                    durableLease = await durableStore.claim({ ...durableSubscription, workerId: 'synthetic-wns-first' });
                    durableReceiver = createSyntheticDurableReceiver({ scope: `${origin}/`, store: durableStore, lease: durableLease,
                        channel: independentChannel, authorize: async () => {}, sendAck: async () => { targetAcks++; },
                        beforeAck: async saved => { durableInboxId = saved.id; throw Object.assign(new Error('PROBE_SYNTHETIC_STOP'), { code: 'PROBE_SYNTHETIC_STOP' }); } });
                }
            }
            const direct = (token, label, captureToken, ackAndFollowup, observePrior) => independentSyntheticReconnect({ frames, key, token, productConstants,
                generatedPrelude: process.env.EDGE_PROBE_GENERATED_PRELUDE === '1', generatedHandshake, clientMetadata, ackAndFollowup,
                skipChallenge: testSkipChallenge,
                ackSingle: Boolean(captureToken && testOffline && process.env.EDGE_PROBE_OFFLINE_ACK === '1'),
                ackSettleMs: captureToken && testOffline && process.env.EDGE_PROBE_OFFLINE_ACK === '1' ? 1000 : 0,
                ...(captureToken ? { onRotatedToken: value => { rotatedToken?.fill(0); rotatedToken = Buffer.from(value); } } : {}),
                ...(testBindShape ? { onBindShape: value => { bindShape = value; } } : {}),
                ...(testBindShape ? { onExchangeShape: value => { exchangeShapes.push(value); } } : {}),
                ...(captureToken && testOffline ? { onTargetCiphertext: value => { firstCipher?.fill(0); firstCipher = Buffer.from(value); } } : {}),
                ...(testDurable ? { onTargetCiphertext: async (ciphertext, frame) => {
                    durableCipher = Buffer.from(ciphertext); await durableReceiver.receive(frame, 6);
                } } : {}),
                ...(observePrior ? { observePrior } : {}),
                ...(testOffline ? { expectedChannel: independentChannel } : {}),
                ...(testTwoSites ? { expectedChannel: independentChannel, sendOtherNotification: () => sendFixture(otherSubscription, 'synthetic-independent-other') } : {}),
                sendNotification: () => sendFixture(value.subscription, label),
                decryptNotification: async ciphertext => {
                    if (testDurable) targetDecrypts++;
                    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                    const plain = decryptEce(ciphertext, { encoding: 'aes128gcm' }, { public_key: [...independentWebPush.publicKey],
                        private_key: [...independentWebPush.privateKey], auth_secret: [...independentWebPush.auth] });
                    try { return plain.equals(Buffer.from(label)); } finally { plain.fill(0); }
                } });
            try {
                const testRotation = process.env.EDGE_PROBE_ROTATION === '1';
                if (testRotation && !generatedHandshake) throw new Error('PROBE_MODE_INVALID');
                if (testProcessCrash) {
                    let statePrivateKey;
                    if (testTokenState) {
                        statePrivateKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
                        if (!testProductionState) {
                            const { createSyntheticStateVault } = require('./edge-fixture-state-vault.cjs');
                            const { createSyntheticTokenStateStore } = require('./edge-fixture-state-store.cjs');
                            const state = createSyntheticTokenStateStore({ ...durableDb, fixturePort: 33621 }, { vault: createSyntheticStateVault(statePrivateKey) });
                            await state.initialize();
                        }
                    }
                    const entitlements = require('../../src/automation/entitlements');
                    await durableDb.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
                        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
                    const monitor = await durableDb.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
                        [durableSubscription.ownerUserId, JSON.stringify({ subscriptionId: durableSubscription.subscriptionId }), Date.now(), Date.now()]);
                    await durableDb.withDatabaseTransaction(query => entitlements.assignSlot(query, durableSubscription.ownerUserId, 'x', String(monitor.insertId)));
                    const { startSyntheticWorker } = require('./edge-fixture-process.cjs');
                    const input = { schema: durableDb.schema, dbPort: 33621, scope: `${origin}/`, subscriptionId: durableSubscription.subscriptionId,
                        ownerUserId: durableSubscription.ownerUserId, deviceKey: key.toString('base64'), token: deviceFields[2].toString('utf8'),
                        channel: independentChannel.toString('base64'), ...(testSkipChallenge ? { boundMode: true }
                            : { productKey: productConstants.key.toString('base64'), productId: productConstants.id.toString('base64') }),
                        publicKey: independentWebPush.publicKey.toString('base64'), privateKey: independentWebPush.privateKey.toString('base64'),
                        auth: independentWebPush.auth.toString('base64'), subscription: value.subscription, otherSubscription, vapid, clientMetadata,
                        ...(testTokenState ? { stateEnabled: true, statePrivateKey, productionState: testProductionState, useGateway: testDurableGateway } : {}) };
                    let firstWorker, successorWorker, processFailure;
                    try {
                        firstWorker = startSyntheticWorker({ ...input, worker: 'first' });
                        const committed = await firstWorker.wait('committed');
                        if (!/^[1-9]\d{0,19}$/.test(String(committed.inboxId || '')) || !Number.isInteger(committed.pid) || committed.pid === process.pid)
                            throw new Error('PROBE_WORKER_RECEIPT_INVALID');
                        const rows = await durableDb.queryDatabase('SELECT lease_token,subscription_revision,lease_expires_at_ms FROM automation_x_push_receivers WHERE subscription_id=?', [durableSubscription.subscriptionId]);
                        if (rows.length !== 1 || Date.now() >= Number(rows[0].lease_expires_at_ms)) throw new Error('PROBE_DURABLE_LEASE_FAILED');
                        const stale = { subscriptionId: durableSubscription.subscriptionId, ownerUserId: durableSubscription.ownerUserId,
                            revision: Number(rows[0].subscription_revision), token: rows[0].lease_token };
                        if (await durableStore.claim({ ...durableSubscription, workerId: 'synthetic-wns-contender' })) throw new Error('PROBE_DURABLE_LEASE_FAILED');
                        await firstWorker.terminate();
                        const retained = await durableStore.getInbox({ ...durableSubscription, id: committed.inboxId });
                        if (!retained || retained.status !== 'received') throw new Error('PROBE_DURABLE_RECEIPT_FAILED');
                        for (let i = 0; i < 400 && Date.now() <= Number(rows[0].lease_expires_at_ms); i++) await wait(100);
                        if (Date.now() <= Number(rows[0].lease_expires_at_ms)) throw new Error('PROBE_DURABLE_LEASE_TIMEOUT');
                        successorWorker = startSyntheticWorker({ ...input, worker: 'successor', inboxId: committed.inboxId });
                        const recovered = await successorWorker.wait('recovered'); await successorWorker.waitExit();
                        let oldLeaseRejected = false;
                        try { await durableStore.assertLease(stale); } catch (error) { if (error.code === 'X_PUSH_LEASE_LOST') oldLeaseRejected = true; else throw error; }
                        const expectedCount = testTokenState ? 2 : 1;
                        if (!oldLeaseRejected || !Number.isInteger(recovered.pid) || recovered.pid === process.pid || recovered.pid === committed.pid
                            || recovered.inboxCount !== expectedCount || recovered.jobCount !== expectedCount
                            || testTokenState && (!recovered.reconnected || recovered.stateGeneration !== 2)) throw new Error('PROBE_DURABLE_ROUTE_FAILED');
                        independentResult = { killedAfterCommitBeforeTargetAck: true };
                        durableResult = { realWnsCipherCommitted: true, separateWorkerProcesses: true, actualLeaseExpiry: true,
                            staleLeaseRejected: true, successorDecrypted: true, foreignPersisted: false, inboxCount: recovered.inboxCount, jobCount: recovered.jobCount,
                            tokenStateSaved: testTokenState, productionState: testProductionState, gateway: testDurableGateway,
                            successorReconnected: recovered.reconnected, tokenGeneration: recovered.stateGeneration };
                    } catch (error) { processFailure = error; }
                    const cleanup = await Promise.allSettled([firstWorker, successorWorker].filter(Boolean).map(worker => worker.cleanup()));
                    if (cleanup.some(result => result.status === 'rejected')) {
                        if (processFailure) process.stderr.write('PROBE_WORKER_CLEANUP_FAILED\n');
                        else processFailure = new Error('PROBE_WORKER_CLEANUP_FAILED');
                    }
                    if (processFailure) throw processFailure;
                } else if (testSession) {
                    probeStage = 'session';
                    const { createEdgeWnsSession } = require('../../src/automation/edge-wns-session');
                    const { createEdgeWnsTransport } = require('../../src/automation/edge-wns-transport');
                    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                    let lease = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789', revision: 1 };
                    let expected, borrowed, persisted = 0, dbStore, vault, identity, tokenHash, released = false;
                    if (testSessionDb) {
                        const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
                        const { insertSubscription } = require('../../scripts/test/helpers/x-push-fixture.cjs');
                        const { createXPushStore } = require('../../src/automation/x-push-store');
                        const { createWnsTokenWorkerVault } = require('../../src/automation/x-setup-transfer');
                        durableDb = await createTestDatabase(33621);
                        identity = await insertSubscription(durableDb);
                        await durableDb.queryDatabase("UPDATE automation_x_subscriptions SET browser_kind='edge' WHERE id=?", [identity.subscriptionId]);
                        dbStore = createXPushStore(durableDb); lease = await dbStore.claim({ ...identity, workerId: 'synthetic-session' });
                        if (!lease) throw new Error('PROBE_SESSION_LEASE_INVALID');
                        vault = createWnsTokenWorkerVault({ activeKeyId: 'synthetic1', privateKeys: { synthetic1: generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey } });
                    }
                    const store = { async assertLease(current, options) { if (dbStore) return dbStore.assertLease(current, options); await options.authorize(); },
                        async readWnsTokenState(current, options) { return dbStore.readWnsTokenState(current, options); },
                        async saveWnsTokenState(current, options) { borrowed = options.token; tokenHash = createHash('sha256').update(options.token).digest('hex'); return dbStore.saveWnsTokenState(current, options); },
                        async getInbox(input) { return dbStore.getInbox(input); },
                        async recordFrame(current, entry, options) {
                            const saved = dbStore ? await dbStore.recordFrame(current, entry, options) : (await options.authorize(), { ...lease, ...entry, id: '1', duplicate: false });
                            const encrypted = Buffer.from(entry.data, 'base64url'); let plain;
                            try {
                                if (!expected || !encrypted.equals(expected)) throw new Error('PROBE_SESSION_CIPHER_INVALID');
                                plain = decryptEce(encrypted, { encoding: 'aes128gcm' }, { public_key: [...independentWebPush.publicKey],
                                    private_key: [...independentWebPush.privateKey], auth_secret: [...independentWebPush.auth] });
                                if (!plain.equals(Buffer.from('synthetic-session-target'))) throw new Error('PROBE_SESSION_DECRYPT_INVALID');
                                persisted++; return saved;
                            } finally { encrypted.fill(0); plain?.fill(0); }
                        } };
                    const initialToken = Buffer.from(deviceFields[2]);
                    const agent = { os: 'Windows 10', osVersion: '10.0.00000', architecture: 'x86_64', locale: 'en' };
                    const session = testGateway ? null : createEdgeWnsSession({ transport: createEdgeWnsTransport(), store, lease, siteChannel: independentChannel,
                        authorize: async () => {}, saveRotatedToken: async token => {
                            borrowed = token; tokenHash = createHash('sha256').update(token).digest('hex');
                            if (dbStore) await dbStore.saveWnsTokenState(lease, { vault, token, expectedGeneration: 0, authorize: async () => {} });
                        }, agent, client: clientMetadata, deviceKey: key, reconnectToken: initialToken,
                        ...(testSkipChallenge ? { authenticationMode: 'bound' } : { productKey: productConstants.key, productId: productConstants.id }) });
                    try {
                        if (testGateway) {
                            const { runEdgeWnsGateway } = require('../../src/automation/edge-wns-gateway');
                            const controller = new AbortController(); let received = 0;
                            const timer = setTimeout(() => controller.abort(), 30000);
                            try {
                                await runEdgeWnsGateway({ store, lease, vault, authorize: async () => {}, signal: controller.signal,
                                    credentials: { agent, client: clientMetadata, deviceKey: key, reconnectToken: initialToken,
                                        ...(testSkipChallenge ? { authenticationMode: 'bound' } : { productKey: productConstants.key, productId: productConstants.id }), siteChannel: independentChannel },
                                    onReady: async () => {
                                        const other = await sendFixture(otherSubscription, 'synthetic-session-other'); other.fill(0);
                                        expected = await sendFixture(value.subscription, 'synthetic-session-target');
                                    }, onReceived: async () => { received++; controller.abort(); } });
                                if (received !== 1 || persisted !== 1) throw new Error('PROBE_SESSION_ROUTE_INVALID');
                                if (!borrowed?.length || !borrowed.every(byte => byte === 0)) throw new Error('PROBE_SESSION_TOKEN_INVALID');
                            } finally { clearTimeout(timer); }
                        } else {
                            await session.start();
                            if (!borrowed?.length || !borrowed.every(byte => byte === 0)) throw new Error('PROBE_SESSION_TOKEN_INVALID');
                            const other = await sendFixture(otherSubscription, 'synthetic-session-other'); other.fill(0);
                            const foreign = await session.next(15000);
                            if (durableDb && Number((await durableDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n) !== 0)
                                throw new Error('PROBE_SESSION_FOREIGN_STORED');
                            expected = await sendFixture(value.subscription, 'synthetic-session-target');
                            const target = await session.next(15000);
                            if (foreign.state !== 'discarded' || target.state !== 'persisted' || persisted !== 1) throw new Error('PROBE_SESSION_ROUTE_INVALID');
                        }
                        if (dbStore) {
                            session?.close(); await dbStore.release(lease); released = true;
                            const successor = await dbStore.claim({ ...identity, workerId: 'synthetic-session-successor' });
                            if (!successor) throw new Error('PROBE_SESSION_LEASE_INVALID');
                            try {
                                const recovered = await dbStore.readWnsTokenState(successor, { vault, authorize: async () => {} });
                                try {
                                    if (!recovered || recovered.generation !== 1 || createHash('sha256').update(recovered.token).digest('hex') !== tokenHash)
                                        throw new Error('PROBE_SESSION_STATE_INVALID');
                                } finally { recovered?.token.fill(0); }
                                if (Number((await durableDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n) !== 1)
                                    throw new Error('PROBE_SESSION_ROUTE_INVALID');
                            } finally { await dbStore.release(successor); }
                        }
                        independentResult = { sessionReady: true, tokenCleared: true, foreignDiscarded: true, targetReceived: true,
                            productionStoreRecovered: Boolean(dbStore), gateway: testGateway };
                    } finally {
                        expected?.fill(0); initialToken.fill(0); session?.close();
                        if (dbStore && !released) await dbStore.release(lease).catch(() => {});
                    }
                } else {
                const label = testDurable ? JSON.stringify({ notificationType: 'tweet', author: { id: '12345', handle: 'synthetic' },
                    url: 'https://x.com/synthetic/status/1234567890123456789', text: 'synthetic-durable-event' }) : 'synthetic-independent-first';
                try { independentResult = await direct(deviceFields[2].toString('utf8'), label, testRotation, process.env.EDGE_PROBE_ACK_FOLLOWUP === '1'); }
                catch (error) {
                    if (testDurableFailure && error?.code === 'X_PUSH_STORE_UNAVAILABLE') independentResult = { stoppedOnStorageFailure: true };
                    else if (testDurable && !testDurableFailure && error?.code === 'PROBE_SYNTHETIC_STOP') independentResult = { stoppedAfterCommitBeforeTargetAck: true };
                    else throw error;
                }
                if (testDurableFailure) {
                    const inboxCount = Number((await durableDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n);
                    if (!durableCipher || durableInboxId || targetAcks !== 0 || targetDecrypts !== 0 || inboxCount !== 0) throw new Error('PROBE_DURABLE_ROLLBACK_FAILED');
                    durableResult = { realWnsCipherReceived: true, injectedSqlFailure: true, targetAckSent: false, targetDecrypts, inboxCount };
                } else if (testDurable) {
                    if (!durableInboxId || !durableCipher || targetAcks !== 0) throw new Error('PROBE_DURABLE_PREREQUISITE_FAILED');
                    const retained = await durableStore.getInbox({ ...durableSubscription, id: durableInboxId });
                    if (!retained || retained.data !== durableCipher.toString('base64url')) throw new Error('PROBE_DURABLE_RECEIPT_FAILED');
                    for (let i = 0; i < 400 && Date.now() <= durableLease.expiresAtMs; i++) await wait(100);
                    if (Date.now() <= durableLease.expiresAtMs) throw new Error('PROBE_DURABLE_LEASE_TIMEOUT');
                    const successor = await durableStore.claim({ ...durableSubscription, workerId: 'synthetic-wns-successor' });
                    if (!successor) throw new Error('PROBE_DURABLE_LEASE_FAILED');
                    let oldLeaseRejected = false;
                    try { await durableStore.assertLease(durableLease); } catch (error) { if (error.code === 'X_PUSH_LEASE_LOST') oldLeaseRejected = true; else throw error; }
                    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                    const ciphertext = Buffer.from(retained.data, 'base64url');
                    let payload;
                    try {
                        const plain = decryptEce(ciphertext, { encoding: 'aes128gcm' }, { public_key: [...independentWebPush.publicKey],
                            private_key: [...independentWebPush.privateKey], auth_secret: [...independentWebPush.auth] });
                        try { if (!plain.equals(Buffer.from(label))) throw new Error('PROBE_DURABLE_DECRYPT_FAILED'); payload = JSON.parse(plain.toString('utf8')); }
                        finally { plain.fill(0); }
                    } finally { ciphertext.fill(0); }
                    const entitlements = require('../../src/automation/entitlements');
                    await durableDb.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, { userId: '666666666666666666', isAdmin: true },
                        { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
                    const monitor = await durableDb.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'12345','synthetic','fixture',1,'ready','free',?,'bound',1,?,?)",
                        [durableSubscription.ownerUserId, JSON.stringify({ subscriptionId: durableSubscription.subscriptionId }), Date.now(), Date.now()]);
                    await durableDb.withDatabaseTransaction(query => entitlements.assignSlot(query, durableSubscription.ownerUserId, 'x', String(monitor.insertId)));
                    const queue = require('../../src/automation/queue').createQueue(durableDb, {}, { rolloutMode: 'public' });
                    const router = require('../../src/automation/x-event-router').createXEventRouter(durableDb, queue);
                    const routed = await router.routeReceived({ lease: successor, inbox: retained, payload, processingMode: 'batch' });
                    if (routed.state !== 'routed') throw new Error('PROBE_DURABLE_ROUTE_FAILED');
                    await durableStore.markRouted(successor, durableInboxId);
                    const inboxCount = Number((await durableDb.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox'))[0].n);
                    const jobCount = Number((await durableDb.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n);
                    if (!oldLeaseRejected || inboxCount !== 1 || jobCount !== 1) throw new Error('PROBE_DURABLE_ROUTE_FAILED');
                    durableResult = { realWnsCipherCommitted: true, targetAckSent: false, foreignPersisted: false, actualLeaseExpiry: true,
                        staleLeaseRejected: true, successorDecrypted: true, inboxCount, jobCount };
                }
                if (testRotation) {
                    if (!rotatedToken || !independentResult.notificationReceived) throw new Error('PROBE_ROTATION_PREREQUISITE_FAILED');
                    const useOldToken = process.env.EDGE_PROBE_USE_STALE_TOKEN === '1';
                    if (testOffline) {
                        if (!firstCipher) throw new Error('PROBE_OFFLINE_PREREQUISITE_FAILED');
                        for (let i = 0; i < 50 && events.some(event => event.upstreamOpen()); i++) await wait(100);
                        if (events.some(event => event.upstreamOpen())) throw new Error('PROBE_OFFLINE_PREREQUISITE_FAILED');
                        await wait(1000);
                        offlineCipher = await sendFixture(value.subscription, 'synthetic-offline');
                    }
                    const configuredWindow = process.env.EDGE_PROBE_OBSERVE_MS === undefined ? 10000 : Number(process.env.EDGE_PROBE_OBSERVE_MS);
                    if (testOffline && (process.env.NODE_ENV !== 'test' || !Number.isInteger(configuredWindow) || configuredWindow < 100 || configuredWindow > 30000)) throw new Error('PROBE_MODE_INVALID');
                    const observation = testOffline ? { offlineCipher, priorCipher: firstCipher, windowMs: configuredWindow } : undefined;
                    try { independentResult.rotation = { reusedPreviousToken: useOldToken, ...await direct(useOldToken ? deviceFields[2].toString('utf8') : rotatedToken.toString('ascii'), 'synthetic-independent-next', false, false, observation) }; }
                    catch (error) { independentResult.rotation = { errorCode: /^PROBE_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROBE_ROTATION_FAILED' }; }
                }
                }
            } finally { rotatedToken?.fill(0); firstCipher?.fill(0); offlineCipher?.fill(0); durableCipher?.fill(0); key.fill(0); if (frames) for (const frame of Object.values(frames)) frame.fill(0); }
        }
        const shapes = events.map(event => ({ clientAlpn: event.clientAlpn, upstreamAlpn: event.upstreamAlpn,
            sentChunks: event.sentChunks, receivedChunks: event.receivedChunks, sentBytes: event.sentBytes, receivedBytes: event.receivedBytes,
            firstSend: event.firstSend, ...(event.signatureRewritten === undefined ? {} : { signatureRewritten: event.signatureRewritten }),
            fixtureLayout: event.fixtureLayout(), bindResponses: event.fixtureBindResponses(),
            acknowledgementAnalysis: event.fixtureAcknowledgementAnalysis(), shape: event.describe() }));
        if (deviceFields) for (const value of Object.values(deviceFields)) value.fill(0);
        const builtInStorePresent = await fs.stat(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey')).then(() => true, error => {
            if (error.code === 'ENOENT') return false; throw error;
        });
        if (process.env.EDGE_PROBE_REPORT_DIRECT_IPC === '1') {
            if (!testIndependent || typeof process.send !== 'function') throw new Error('PROBE_MODE_INVALID');
            await new Promise((resolve, reject) => process.send({ independentResult, noRelayVerified: noRelay && events.length === 0 && endpointArgs.length === 0 }, error => error ? reject(new Error('PROBE_IPC_FAILED')) : resolve()));
        }
        console.log(JSON.stringify({ syntheticProfile: true, snapshotIoVerified, testWrongKey, testRewrite, testIndependent, testTwoSites, testDurable, tlsIsolationVerified, winrtFeatureOverride: featureArgs.length > 0, endpointOverride: !noRelay, builtInStorePresent, relayConnections: events.length, events: shapes, initialNotificationReceived: browserEvents.initial > 0, browserReceived, copiedProfileResult, detachedConnectionResult, independentResult, durableResult, routingResult, handshakeShape, handshakeRelations, bindShape, exchangeShapes, capturedCipherDecrypted, appServerKeyMatches,
            subscription: value.ok ? { ok: true, host: new URL(value.subscription.endpoint).hostname } : value }));
    } catch (error) {
        const safeCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : null;
        console.error('PROBE_STAGE', probeStage, /^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : safeCode || error?.name || 'Error');
        throw error;
    } finally {
        if (durableDb) try { await durableDb.close(); } catch { process.stderr.write('PROBE_DB_CLEANUP_FAILED\n'); process.exitCode = 1; }
        if (independentWebPush) for (const secret of Object.values(independentWebPush)) secret.fill(0);
        independentChannel?.fill(0);
        if (productConstants) for (const secret of Object.values(productConstants)) secret.fill(0);
        for (const value of nativePfx) value.fill(0);
        relationDeviceRecord?.fill(0); relationSiteRecord?.fill(0);
        expectedCipher?.fill(0); otherCipher?.fill(0); expectedNextCipher?.fill(0); otherNextCipher?.fill(0);
        await cdp?.close().catch(() => {});
        if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
        for (const socket of sockets) socket.destroy();
        if (relay) await new Promise(resolve => relay.close(resolve));
        if (untrustedServer) await new Promise(resolve => untrustedServer.close(resolve));
        if (pageServer) await new Promise(resolve => pageServer.close(resolve));
        const actual = await fs.realpath(root), stat = await fs.lstat(root);
        if (stat.isSymbolicLink() || path.dirname(actual).toLowerCase() !== temp.toLowerCase()
            || !/^cbte-edge-wns-probe-[A-Za-z0-9]+$/.test(path.basename(actual))) { process.stderr.write('PROBE_CLEANUP_UNSAFE\n'); process.exitCode = 1; }
        else await fs.rm(actual, { recursive: true });
    }
}
main().catch(error => { console.error(/^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PROBE_FAILED'); process.exitCode = 1; });
