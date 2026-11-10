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
const { createHmac, createHash, createCipheriv, createPrivateKey } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const webpush = require('web-push');
const CDP = require('chrome-remote-interface');
const { ClassicLevel } = require('classic-level');
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
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-wns-probe-'));
    let browser, cdp, pageServer, relay, browserReceived = false, copiedProfileResult = null, capturedCipherDecrypted = null, appServerKeyMatches = null, deviceFields, expectedCipher; const sockets = new Set(), events = [];
    let probeStage = 'setup';
    try {
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
            event.fixtureCipher = () => {
                if (!expectedCipher) return null;
                const combined = Buffer.concat(received), offset = combined.indexOf(expectedCipher);
                const captured = offset < 0 ? null : Buffer.from(combined.subarray(offset, offset + expectedCipher.length));
                combined.fill(0); return captured;
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
                    for (const key of Object.values(keys)) key.fill(0);
                    cross = { nonceCounts: { sent: values(sentText, 'nonce').length, received: values(receivedText, 'nonce').length }, signatureCount: signatures.length, hmacMatches: matches };
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
            incoming.on('error', () => upstream.destroy()); upstream.on('error', () => incoming.destroy());
            upstream.once('secureConnect', () => { event.upstreamAlpn = upstream.alpnProtocol || null; incoming.pipe(upstream); upstream.pipe(incoming); });
        });
        await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
        const vapid = webpush.generateVAPIDKeys(); webpush.setVapidDetails('mailto:test@example.com', vapid.publicKey, vapid.privateKey);
        pageServer = http.createServer((req, res) => {
            if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end("self.addEventListener('push',e=>e.waitUntil(Promise.all([fetch('/seen',{method:'POST'}),self.registration.showNotification('fixture')]))) "); }
            else if (req.url === '/seen' && req.method === 'POST') { browserReceived = true; res.writeHead(204); res.end(); }
            else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<script>window.key=${JSON.stringify(vapid.publicKey)}</script>`); }
        });
        await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${pageServer.address().port}`, profile = path.join(root, 'profile');
        browser = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--disable-features=msPushWinrt',
            '--ignore-certificate-errors', `--edge-wns-push-server-url=https://127.0.0.1:${relay.address().port}`,
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
        if (value.ok && process.env.EDGE_PROBE_RECONNECT === '1') {
            await cdp.Browser.close().catch(() => {}); await cdp.close().catch(() => {}); cdp = null;
            if (browser.exitCode === null) await new Promise(resolve => browser.once('exit', resolve));
            probeStage = 'read-store';
            const db = new ClassicLevel(path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'),
                { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
            let subscriptionFields;
            try {
                await db.open();
                for await (const [key, stored] of db.iterator({ limit: 64 })) {
                    if (key.toString('utf8').toLowerCase().includes('device')) {
                        if (deviceFields) throw new Error('PROBE_DEVICE_AMBIGUOUS');
                        deviceFields = protoBytes(stored, [2, 3]);
                    } else if (process.env.EDGE_PROBE_DECRYPT_RECEIVED === '1' && stored.includes(Buffer.from(origin))
                        && stored.includes(Buffer.from(value.subscription.keys.p256dh, 'base64url'))
                        && stored.includes(Buffer.from(value.subscription.keys.auth, 'base64url'))) {
                        if (subscriptionFields) throw new Error('PROBE_SUBSCRIPTION_AMBIGUOUS');
                        subscriptionFields = protoBytes(stored, [6, 7, 16]);
                    }
                }
            } finally { await db.close().catch(() => {}); }
            if (!deviceFields?.[2] || !deviceFields?.[3]) throw new Error('PROBE_DEVICE_MISSING');
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
            browser = spawn(edge, ['--headless=new', ...(copyProfile ? ['--remote-debugging-port=0'] : []), `--user-data-dir=${reopenProfile}`, '--disable-features=msPushWinrt',
                '--ignore-certificate-errors', `--edge-wns-push-server-url=https://127.0.0.1:${relay.address().port}`,
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
        const shapes = events.map(event => { const { describe, fixtureCipher, ...metadata } = event; return { ...metadata, shape: describe() }; });
        if (deviceFields) for (const value of Object.values(deviceFields)) value.fill(0);
        console.log(JSON.stringify({ syntheticProfile: true, relayConnections: events.length, events: shapes, browserReceived, copiedProfileResult, capturedCipherDecrypted, appServerKeyMatches,
            subscription: value.ok ? { ok: true, host: new URL(value.subscription.endpoint).hostname } : value }));
    } catch (error) {
        console.error('PROBE_STAGE', probeStage, /^PROBE_[A-Z_]+$/.test(error?.message || '') ? error.message : error?.name || 'Error');
        throw error;
    } finally {
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
