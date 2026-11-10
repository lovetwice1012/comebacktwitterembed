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
const { createHmac, createHash, createCipheriv, createPrivateKey, randomInt } = require('node:crypto');
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
const { matchingSyntheticRecordFields } = require('./edge-fixture-record.cjs');
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
    if (testWrongKey && (noRelay || process.env.EDGE_PROBE_RECONNECT !== '1' || process.env.EDGE_PROBE_COPY_PROFILE !== '1'
        || process.env.EDGE_PROBE_MINIMAL_PROFILE !== '1' || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1'
        || (process.env.EDGE_PROBE_OMIT_COMPONENT || '').split(',').includes('push-store'))) throw new Error('PROBE_MODE_INVALID');
    if (testRewrite && (testWrongKey || noRelay || process.env.EDGE_PROBE_RECONNECT !== '1' || process.env.EDGE_PROBE_COPY_PROFILE !== '1'
        || process.env.EDGE_PROBE_MINIMAL_PROFILE !== '1' || process.env.EDGE_PROBE_KEEP_SOCKET === '1'
        || (process.env.EDGE_PROBE_OMIT_COMPONENT || '').split(',').includes('push-store'))) throw new Error('PROBE_MODE_INVALID');
    if (testIndependent && (testRewrite || testWrongKey || noRelay || process.env.EDGE_PROBE_RECONNECT !== '1'
        || process.env.EDGE_PROBE_COPY_PROFILE !== '1' || process.env.EDGE_PROBE_MINIMAL_PROFILE !== '1'
        || process.env.EDGE_PROBE_KEEP_SOCKET === '1' || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1'
        || (process.env.EDGE_PROBE_OMIT_COMPONENT || '').split(',').includes('push-store')))
        throw new Error('PROBE_MODE_INVALID');
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-wns-probe-'));
    let browser, cdp, pageServer, relay, browserReceived = false, copiedProfileResult = null, detachedConnectionResult = null, independentResult = null, handshakeShape = null, handshakeRelations = null, relationDeviceRecord = null, relationSiteRecord = null, independentWebPush = null, productConstants = null, capturedCipherDecrypted = null, appServerKeyMatches = null, deviceFields, expectedCipher; const sockets = new Set(), events = [];
    const browserEvents = { initial: 0, second: 0, third: 0, fourth: 0, copy: 0 };
    let probeStage = 'setup', previousServerNonce = null;
    try {
        if (testIndependent || process.env.EDGE_PROBE_COMPARE_CHALLENGE === '1') productConstants = await readSyntheticProductConstants();
        const cert = spawnSync('python', ['-c', python], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        if (cert.status !== 0) throw new Error('PROBE_CERT_FAILED');
        const tlsConfig = JSON.parse(cert.stdout);
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
        const endpointArgs = noRelay ? [] : ['--ignore-certificate-errors', `--edge-wns-push-server-url=https://127.0.0.1:${relay.address().port}`];
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
        await cdp.Page.enable(); const loaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
        await cdp.Page.navigate({ url: origin }); await loaded;
        let timer;
        const result = await Promise.race([cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
          try {const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
          const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:window.key});return {ok:true,subscription:s.toJSON()};}
          catch(e){return {ok:false,name:e.name};}})()` }),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); })]).finally(() => clearTimeout(timer));
        const value = result?.result?.value || { ok: false, name: 'Timeout' };
        if (value.ok) {
            expectedCipher = await sendFixture(value.subscription, 'synthetic-wns-probe');
            for (let i = 0; i < 80 && !browserReceived; i++) await wait(100);
        }
        await wait(1000);
        if (value.ok && process.env.EDGE_PROBE_KEEP_SOCKET === '1') {
            if (process.env.EDGE_PROBE_RECONNECT === '1') throw new Error('PROBE_MODE_INVALID');
            await cdp.Browser.close().catch(() => {}); await cdp.close().catch(() => {}); cdp = null;
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
            await cdp.Browser.close().catch(() => {}); await cdp.close().catch(() => {}); cdp = null;
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
                        if (process.env.EDGE_PROBE_DESCRIBE_HANDSHAKE === '1') relationDeviceRecord = Buffer.from(stored);
                        if (testWrongKey) { deviceKey = Buffer.from(key); deviceRecord = Buffer.from(stored); }
                    } else if ((testIndependent || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1' || process.env.EDGE_PROBE_DESCRIBE_HANDSHAKE === '1') && stored.includes(Buffer.from(origin))
                        && stored.includes(Buffer.from(value.subscription.keys.p256dh, 'base64url'))
                        && stored.includes(Buffer.from(value.subscription.keys.auth, 'base64url'))) {
                        if (subscriptionFields || relationSiteRecord) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS');
                        if (process.env.EDGE_PROBE_DESCRIBE_HANDSHAKE === '1') relationSiteRecord = Buffer.from(stored);
                        if (testIndependent || process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1') subscriptionFields = protoBytes(stored, [6, 7, 16]);
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
            for (let i = 0; i < 120 && events.length <= originalCount; i++) await wait(100);
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
        if (testIndependent) {
            if (events.length !== 2 || !copiedProfileResult?.sameSubscription || !copiedProfileResult?.receivedAfterCopy || !deviceFields?.[2] || !deviceFields?.[3] || !independentWebPush)
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
            let rotatedToken;
            const direct = (token, label, captureToken, ackAndFollowup) => independentSyntheticReconnect({ frames, key, token, productConstants,
                generatedPrelude: process.env.EDGE_PROBE_GENERATED_PRELUDE === '1', generatedHandshake, clientMetadata, ackAndFollowup,
                ...(captureToken ? { onRotatedToken: value => { rotatedToken?.fill(0); rotatedToken = Buffer.from(value); } } : {}),
                sendNotification: () => sendFixture(value.subscription, label),
                decryptNotification: async ciphertext => {
                    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
                    const plain = decryptEce(ciphertext, { encoding: 'aes128gcm' }, { public_key: [...independentWebPush.publicKey],
                        private_key: [...independentWebPush.privateKey], auth_secret: [...independentWebPush.auth] });
                    try { return plain.equals(Buffer.from(label)); } finally { plain.fill(0); }
                } });
            try {
                const testRotation = process.env.EDGE_PROBE_ROTATION === '1';
                if (testRotation && !generatedHandshake) throw new Error('PROBE_MODE_INVALID');
                independentResult = await direct(deviceFields[2].toString('utf8'), 'synthetic-independent-first', testRotation,
                    process.env.EDGE_PROBE_ACK_FOLLOWUP === '1');
                if (testRotation) {
                    if (!rotatedToken || !independentResult.notificationReceived) throw new Error('PROBE_ROTATION_PREREQUISITE_FAILED');
                    const useOldToken = process.env.EDGE_PROBE_USE_STALE_TOKEN === '1';
                    try { independentResult.rotation = { reusedPreviousToken: useOldToken, ...await direct(useOldToken ? deviceFields[2].toString('utf8') : rotatedToken.toString('ascii'), 'synthetic-independent-next', false, false) }; }
                    catch (error) { independentResult.rotation = { errorCode: /^PROBE_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROBE_ROTATION_FAILED' }; }
                }
            } finally { rotatedToken?.fill(0); key.fill(0); if (frames) for (const frame of Object.values(frames)) frame.fill(0); }
        }
        const shapes = events.map(event => { const { describe, fixtureCipher, fixtureLayout, fixtureBindResponses, fixtureSentFrames, fixtureRelations, fixtureAcknowledgementAnalysis, upstreamOpen, containsFixtureCipher, acknowledgeSyntheticSecond, closeFixtureConnection, ...metadata } = event;
            return { ...metadata, fixtureLayout: fixtureLayout(), bindResponses: fixtureBindResponses(), acknowledgementAnalysis: fixtureAcknowledgementAnalysis(), shape: describe() }; });
        if (deviceFields) for (const value of Object.values(deviceFields)) value.fill(0);
        const builtInStorePresent = await fs.stat(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey')).then(() => true, error => {
            if (error.code === 'ENOENT') return false; throw error;
        });
        if (process.env.EDGE_PROBE_REPORT_DIRECT_IPC === '1') {
            if (!testIndependent || typeof process.send !== 'function') throw new Error('PROBE_MODE_INVALID');
            await new Promise((resolve, reject) => process.send({ independentResult }, error => error ? reject(new Error('PROBE_IPC_FAILED')) : resolve()));
        }
        console.log(JSON.stringify({ syntheticProfile: true, testWrongKey, testRewrite, testIndependent, winrtFeatureOverride: featureArgs.length > 0, endpointOverride: !noRelay, builtInStorePresent, relayConnections: events.length, events: shapes, initialNotificationReceived: browserEvents.initial > 0, browserReceived, copiedProfileResult, detachedConnectionResult, independentResult, handshakeShape, handshakeRelations, capturedCipherDecrypted, appServerKeyMatches,
            subscription: value.ok ? { ok: true, host: new URL(value.subscription.endpoint).hostname } : value }));
    } catch (error) {
        console.error('PROBE_STAGE', probeStage, /^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : error?.name || 'Error');
        throw error;
    } finally {
        if (independentWebPush) for (const secret of Object.values(independentWebPush)) secret.fill(0);
        if (productConstants) for (const secret of Object.values(productConstants)) secret.fill(0);
        relationDeviceRecord?.fill(0); relationSiteRecord?.fill(0);
        await cdp?.close().catch(() => {});
        if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
        for (const socket of sockets) socket.destroy();
        if (relay) await new Promise(resolve => relay.close(resolve));
        if (pageServer) await new Promise(resolve => pageServer.close(resolve));
        const actual = await fs.realpath(root), stat = await fs.lstat(root);
        if (stat.isSymbolicLink() || path.dirname(actual).toLowerCase() !== temp.toLowerCase()
            || !/^cbte-edge-wns-probe-[A-Za-z0-9]+$/.test(path.basename(actual))) { process.stderr.write('PROBE_CLEANUP_UNSAFE\n'); process.exitCode = 1; }
        else await fs.rm(actual, { recursive: true });
    }
}
main().catch(error => { console.error(/^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PROBE_FAILED'); process.exitCode = 1; });
