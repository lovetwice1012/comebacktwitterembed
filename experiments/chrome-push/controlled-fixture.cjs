'use strict';
// Research-only fixture: creates a disposable Chrome profile and an unrelated
// local test site. It never opens an existing Chrome profile or contacts X.
// Requires web-push and chrome-remote-interface available through NODE_PATH.
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { randomBytes, createDecipheriv, createPrivateKey } = require('node:crypto');
const tls = require('node:tls');
const { pathToFileURL } = require('node:url');
const webpush = require('web-push');
const CDP = require('chrome-remote-interface');
const WebSocket = require('ws');
const { ClassicLevel } = require('classic-level');
const { readEncryptionData } = require('../../src/automation/chrome-mcs-protobuf');
const { createFrameDecoder } = require('../../src/automation/chrome-mcs-framing');
const { createChromeMcsSession } = require('../../src/automation/chrome-mcs-session');
const { normalizeChromeTransfer } = require('../../src/automation/chrome-x-transfer');
const { buildChromeTransfer } = require('../../src/automation/chrome-snapshot-reader');
const { readChromeSnapshot } = require('../../src/automation/chrome-snapshot-io');
const { parseUniqueJson } = require('../../src/automation/strict-json');
// This HTTP debugger helper is restricted to the disposable synthetic profile
// above; the user-facing tool uses authenticated broker + anonymous pipe.
const { captureChromeSubscription, closeDedicatedChrome } = require('./fixture-cdp.cjs');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { captureFromBroker } = require('../../src/automation/chrome-broker-client');
const net = require('node:net');
const { createChromeMcsStoreAdapter } = require('../../src/automation/chrome-mcs-store-adapter');

const chrome = process.env.CHROME_TEST_BINARY || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function removeOwnedProfile(profile) {
    // Only remove the exact direct-child directory created by mkdtemp in this
    // invocation, after checking its resolved path and link status.
    const tempRoot = await fs.realpath(os.tmpdir());
    const resolved = await fs.realpath(profile);
    const stat = await fs.lstat(profile);
    if (stat.isSymbolicLink() || path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase()
        || !/^cbte-chrome-fixture-[A-Za-z0-9]+$/.test(path.basename(resolved))) throw new Error('FIXTURE_CLEANUP_UNSAFE');
    await fs.rm(resolved, { recursive: true });
}
async function main() {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-chrome-fixture-'));
    const vapid = webpush.generateVAPIDKeys();
    webpush.setVapidDetails('mailto:test@example.com', vapid.publicKey, vapid.privateKey);
    const marker = randomBytes(8).toString('hex');
    const directMarker = randomBytes(8).toString('hex');
    let received = false;
    const server = http.createServer((req, res) => {
        if (req.url === '/sw.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
            res.end(`self.addEventListener('push',e=>{e.waitUntil((async()=>{await self.registration.showNotification('Push test',{body:'Fixture'});const c=await clients.matchAll({includeUncontrolled:true});for(const x of c)x.postMessage('received')})())})`);
        } else if (req.url === '/result') { received = true; res.end('ok'); }
        else {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end(`<script>navigator.serviceWorker.addEventListener('message',()=>fetch('/result'));window.key=${JSON.stringify(vapid.publicKey)}</script>`);
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let cdp, testDb;
    try {
        let port;
        for (let i = 0; i < 100 && !port; i++) {
            try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await wait(100); }
        }
        if (!port) throw new Error('CHROME_START_TIMEOUT');
        cdp = await CDP({ port });
        const browserVersion = (await cdp.Browser.getVersion()).product.replace(/^Chrome\//, '');
        await cdp.Browser.grantPermissions({ origin, permissions: ['notifications'] });
        await cdp.Page.enable();
        const loaded = new Promise(resolve => cdp.Page.loadEventFired(resolve));
        await cdp.Page.navigate({ url: origin }); await loaded;
        const sub = await cdp.Runtime.evaluate({ awaitPromise: true, returnByValue: true, expression: `(async()=>{
          const reg=await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
          return (await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey: window.key})).toJSON(); })()` });
        if (sub.exceptionDetails || !sub.result.value?.endpoint) throw new Error('PUSH_SUBSCRIBE_FAILED');
        const captured = await captureChromeSubscription({ port, WebSocket, fixtureOrigin: origin });
        if (captured.endpoint !== sub.result.value.endpoint || captured.keys.p256dh !== sub.result.value.keys.p256dh
            || captured.keys.auth !== sub.result.value.keys.auth) throw new Error('PUSH_CAPTURE_MISMATCH');
        console.log(JSON.stringify({ chromeSubscriptionCaptureVerified: true }));
        await webpush.sendNotification(sub.result.value, marker, { TTL: 60 });
        for (let i = 0; i < 100 && !received; i++) await wait(100);
        if (!received) throw new Error('PUSH_DELIVERY_TIMEOUT');
        console.log(JSON.stringify({ createdIsolatedProfile: true, localPushReceived: true }));
        const browserPath = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[1].trim();
        await closeDedicatedChrome({ port, browserPath, WebSocket });
        if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
        // Restart the same synthetic profile using anonymous DevTools pipes.
        // A separate unauthenticated client must not gain debugger access.
        await fs.unlink(path.join(profile, 'DevToolsActivePort')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        const broker = await startChromeBroker({ chromePath: chrome, profilePath: profile, origin, extraArgs: ['--headless=new'] });
        try {
            const unauthorized = await new Promise((resolve, reject) => {
                const socket = net.connect({ host: '127.0.0.1', port: broker.port }); let response = '';
                socket.setTimeout(5000, () => socket.destroy(new Error('BROKER_ATTACK_TIMEOUT')));
                socket.on('connect', () => socket.write('GET /json/list HTTP/1.1\r\n\r\n'));
                socket.on('data', chunk => { response += chunk.toString(); }); socket.on('close', () => resolve(response)); socket.on('error', reject);
            });
            if (unauthorized) throw new Error('BROKER_UNAUTHORIZED_ACCESS');
            let privateCapture;
            for (let i = 0; i < 30 && !privateCapture; i++) {
                try { privateCapture = await captureFromBroker({ port: broker.port, token: broker.token }); }
                catch (error) { if (!/^X_CHROME_CAPTURE_(?:INVALID|NOT_FOUND)$/.test(String(error.code || ''))) throw error; await wait(200); }
            }
            if (!privateCapture || privateCapture.endpoint !== sub.result.value.endpoint
                || privateCapture.keys.p256dh !== sub.result.value.keys.p256dh || privateCapture.keys.auth !== sub.result.value.keys.auth)
                throw new Error('BROKER_CAPTURE_MISMATCH');
            try { await fs.stat(path.join(profile, 'DevToolsActivePort')); throw new Error('BROKER_DEBUG_PORT_EXPOSED'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            console.log(JSON.stringify({ privatePipeCaptureVerified: true, unauthorizedDebuggerBlocked: true }));
        } finally {
            await broker.stop();
            if (broker.chrome.exitCode === null) { broker.chrome.kill(); await new Promise(resolve => broker.chrome.once('exit', resolve)); }
        }
        const prefs = JSON.parse(await fs.readFile(path.join(profile, 'Default', 'Preferences'), 'utf8'));
        const map = prefs.gcm?.push_messaging_application_id_map;
        if (!map || typeof map !== 'object') throw new Error('APP_MAPPING_UNAVAILABLE');
        const appIds = Object.entries(map).filter(([, value]) => typeof value === 'string' && value.split('#')[0] === `${origin}/`).map(([id]) => id);
        if (appIds.length !== 1) throw new Error('APP_MAPPING_AMBIGUOUS');
        const db = new ClassicLevel(path.join(profile, 'Default', 'GCM Store', 'Encryption'), { keyEncoding: 'utf8', valueEncoding: 'buffer' });
        let encryption;
        try {
            let matches = 0;
            for await (const [key, value] of db.iterator()) {
                if (key !== appIds[0] && !key.startsWith(`${appIds[0]},`)) continue;
                encryption = readEncryptionData(value, { expectedAppId: appIds[0], expectedPublicKey: Buffer.from(sub.result.value.keys.p256dh, 'base64url'),
                    expectedAuthSecret: Buffer.from(sub.result.value.keys.auth, 'base64url') });
                matches++;
            }
            if (matches !== 1) throw new Error('ENCRYPTION_RECORD_AMBIGUOUS');
            console.log(JSON.stringify({ chromeSubscriptionKeyMatched: true }));
        } finally { await db.close(); }
        const storage = new ClassicLevel(path.join(profile, 'Default', 'GCM Store'), { keyEncoding: 'utf8', valueEncoding: 'buffer' });
        let deviceId, encryptedToken;
        try { deviceId = (await storage.get('device_aid_key')).toString('utf8'); encryptedToken = await storage.get('device_token_key'); }
        finally { await storage.close(); }
        const state = JSON.parse(await fs.readFile(path.join(profile, 'Local State'), 'utf8'));
        const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64');
        if (wrapped.subarray(0, 5).toString('ascii') !== 'DPAPI' || encryptedToken.subarray(0, 3).toString('ascii') !== 'v10')
            throw new Error('UNSUPPORTED_FIXTURE_KEY_FORMAT');
        const ps = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($o))";
        const encoded = Buffer.from(ps, 'utf16le').toString('base64');
        const key = Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { input: wrapped.subarray(5).toString('base64'), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim(), 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, encryptedToken.subarray(3, 15));
        decipher.setAuthTag(encryptedToken.subarray(-16));
        const securityToken = Buffer.concat([decipher.update(encryptedToken.subarray(15, -16)), decipher.final()]).toString('utf8');
        const fixtureProfileKey = Buffer.from(key);
        key.fill(0);
        // Only the test origin is substituted; no X account is used. This
        // checks Chrome-produced key and identifier formats against intake.
        normalizeChromeTransfer({ format: 'x-notification-subscription', version: 2,
            provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion, readMethod: 'chrome-gcm-snapshot' },
            push: { deviceId, securityToken, appId: appIds[0].replace(`wp:${origin}/#`, 'wp:https://x.com/#'),
                productCategory: prefs.gcm.product_category_for_subtypes, authorizedEntity: encryption.authorizedEntity,
                scope: 'https://x.com/', p256dhPublicKey: sub.result.value.keys.p256dh,
                authenticationSecret: sub.result.value.keys.auth, p256dhPrivateKey: encryption.privateKey } });
        console.log(JSON.stringify({ chromeTransferFormatMatched: true }));
        // Exercise the selection and key-binding reader against the keys and
        // endpoint that Chrome created. The synthetic origin is substituted
        // solely to satisfy the production X-only selector.
        const appForTest = appIds[0].replace(`wp:${origin}/#`, 'wp:https://x.com/#');
        const varint = n => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); };
        const field = (n, data) => { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); return Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]); };
        const der = createPrivateKey({ key: encryption.privateKey, format: 'jwk' }).export({ format: 'der', type: 'pkcs8' });
        const syntheticRecord = Buffer.concat([field(1, appForTest), field(3, Buffer.from(sub.result.value.keys.auth, 'base64url')),
            field(4, encryption.authorizedEntity), field(5, der)]);
        buildChromeTransfer({ preferences: { gcm: { product_category_for_subtypes: prefs.gcm.product_category_for_subtypes,
            push_messaging_application_id_map: { [appForTest]: 'https://x.com/#1#' } } },
        subscription: { ...sub.result.value, scope: 'https://x.com/' },
        records: [{ key: `${appForTest},${encryption.authorizedEntity}`, value: syntheticRecord }], deviceId, securityToken, browserVersion });
        console.log(JSON.stringify({ chromeSnapshotSelectionVerified: true }));
        const snapshotToken = randomBytes(16).toString('hex'), snapshot = path.join(profile, `chrome-snapshot-${snapshotToken}`);
        const snapshotStore = path.join(snapshot, 'Default', 'GCM Store'), snapshotEncryption = path.join(snapshotStore, 'Encryption');
        await fs.mkdir(snapshotEncryption, { recursive: true });
        await fs.writeFile(path.join(snapshot, 'snapshot-owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'chrome-snapshot-v1', token: snapshotToken }));
        await fs.writeFile(path.join(snapshot, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: state.os_crypt.encrypted_key } }));
        await fs.writeFile(path.join(snapshot, 'Default', 'Preferences'), JSON.stringify({ gcm: {
            product_category_for_subtypes: prefs.gcm.product_category_for_subtypes, push_messaging_application_id_map: { [appForTest]: 'https://x.com/#1#' } } }));
        for (const [dir, entries] of [[snapshotStore, [['device_aid_key', Buffer.from(deviceId)], ['device_token_key', encryptedToken]]],
            [snapshotEncryption, [[`${appForTest},${encryption.authorizedEntity}`, syntheticRecord]]]]) {
            const scratchDb = new ClassicLevel(dir, { keyEncoding: 'utf8', valueEncoding: 'buffer' });
            try { for (const [k, v] of entries) await scratchDb.put(k, v); } finally { await scratchDb.close(); }
        }
        try {
            await readChromeSnapshot({ snapshotPath: snapshot, token: snapshotToken,
                subscription: { ...sub.result.value, scope: 'https://x.com/' }, browserVersion,
                dbFactory: dir => new ClassicLevel(dir, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' }),
                unprotect: async () => Buffer.from(fixtureProfileKey), parseJson: text => parseUniqueJson(text, 64) });
        } finally { fixtureProfileKey.fill(0); }
        console.log(JSON.stringify({ chromeSnapshotLeveldbVerified: true }));
        if (process.env.CHROME_FIXTURE_GATEWAY === '1') {
            const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
            const { insertSubscription } = require('../../scripts/test/helpers/x-push-fixture.cjs');
            const { createXPushGateway } = require('../../src/automation/x-push-gateway');
            testDb = await createTestDatabase(Number(process.env.CHROME_FIXTURE_MYSQL_PORT));
            const subRecord = await insertSubscription(testDb);
            const browserFile = { version: 2, provenance: { browserVersion }, push: { deviceId, securityToken,
                appId: appIds[0], productCategory: prefs.gcm.product_category_for_subtypes,
                authorizedEntity: encryption.authorizedEntity, p256dhPublicKey: sub.result.value.keys.p256dh,
                authenticationSecret: sub.result.value.keys.auth, p256dhPrivateKey: encryption.privateKey } };
            // The vault override is fixture-only: the app ID belongs to our
            // local site, not X, and must never pass production intake.
            const gateway = createXPushGateway(testDb, { enabled: true, chromeEnabled: true, rolloutMode: 'public',
                privateWorkerVault: { open: () => browserFile }, requestTimeoutMs: 15000, leaseMs: 120000 });
            const controller = new AbortController(); let matched = false;
            const deadline = setTimeout(() => controller.abort(), 40000);
            try {
                await gateway.run({ ...subRecord, workerId: 'live-fcm-fixture', signal: controller.signal,
                    onSession: () => webpush.sendNotification(sub.result.value, JSON.stringify({ fixture: directMarker }), { TTL: 60 }),
                    onReceived: ({ payload }) => { if (payload.fixture === directMarker) { matched = true; controller.abort(); } } });
            } finally { clearTimeout(deadline); }
            if (!matched) throw new Error('MCS_GATEWAY_DELIVERY_TIMEOUT');
            const rows = await testDb.queryDatabase('SELECT status FROM automation_x_push_inbox');
            if (!rows.some(row => row.status === 'received')) throw new Error('MCS_GATEWAY_INBOX_MISSING');
            console.log(JSON.stringify({ chromeClosedFullGatewayDelivery: true, isolatedDatabase: true }));
            return;
        }
        const decoder = createFrameDecoder();
        const pending = new Set(); let directSeen = false, serverConfirmed = false;
        const dist = path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js');
        const crypto = await import(pathToFileURL(dist).href);
        const decrypt = frame => crypto.decryptEce(Buffer.from(frame.data, 'base64url'), frame.headers, {
            public_key: [...Buffer.from(sub.result.value.keys.p256dh, 'base64url')],
            private_key: [...Buffer.from(encryption.privateKey.d, 'base64url')],
            auth_secret: [...Buffer.from(sub.result.value.keys.auth, 'base64url')],
        });
        let sessionStore;
        if (process.env.CHROME_FIXTURE_MYSQL_PORT) {
            const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
            const { insertSubscription } = require('../../scripts/test/helpers/x-push-fixture.cjs');
            const { createXPushStore } = require('../../src/automation/x-push-store');
            testDb = await createTestDatabase(Number(process.env.CHROME_FIXTURE_MYSQL_PORT));
            for (const sql of require('../../src/automation/x-chrome-mcs-schema.sql').SCHEMA) await testDb.queryDatabase(sql);
            const subRecord = await insertSubscription(testDb);
            const pushStore = createXPushStore(testDb, { leaseMs: 300000 });
            const lease = await pushStore.claim({ ...subRecord, workerId: 'chrome-fixture' });
            const bridge = createChromeMcsStoreAdapter({ store: pushStore, lease, authorize: async () => {}, decrypt });
            sessionStore = { ...bridge, confirm: async ids => { await bridge.confirm(ids); serverConfirmed = true; } };
        } else sessionStore = {
            pending: async () => [...pending],
            commit: async message => {
                // A dedicated test file persists only the selected app's
                // ciphertext and replay identifier, and fsync precedes ACK.
                const handle = await fs.open(path.join(profile, 'fixture-receipts'), 'a');
                try { await handle.writeFile(JSON.stringify({ id: message.persistentId, data: message.rawData.toString('base64') }) + '\n'); await handle.sync(); }
                finally { await handle.close(); }
                pending.add(message.persistentId);
                return message;
            },
            confirm: async ids => { for (const id of ids) pending.delete(id); serverConfirmed = true; },
        };
        const socket = tls.connect({ host: 'mtalk.google.com', port: 443, servername: 'mtalk.google.com', timeout: 12000 });
        const session = createChromeMcsSession({ credentials: { deviceId, securityToken, clientVersion: browserVersion },
            route: { expectedCategory: prefs.gcm.product_category_for_subtypes, expectedAppId: appIds[0], expectedSender: encryption.authorizedEntity },
            send: wire => new Promise((resolve, reject) => socket.write(wire, err => err ? reject(err) : resolve())),
            store: sessionStore,
            onReceipt: async message => {
                const frame = typeof message.data === 'string' ? message : { data: message.encrypted.data.toString('base64url'), headers: message.encrypted.headers };
                const payload = decrypt(frame);
                if (payload.toString('utf8') === directMarker) directSeen = true;
            } });
        let settled = false, timer, queue = Promise.resolve();
        try {
            const direct = new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('MCS_TEST_TIMEOUT')), 25000);
                socket.on('error', () => reject(new Error('MCS_TEST_CONNECTION_FAILED')));
                socket.on('timeout', () => reject(new Error('MCS_TEST_TIMEOUT')));
                socket.on('secureConnect', () => { session.start().catch(reject); });
                socket.on('data', chunk => {
                    queue = queue.then(async () => {
                        for (const frame of decoder.push(chunk)) {
                            console.log(JSON.stringify({ mcsFrameTag: frame.tag }));
                            const result = await session.receive(frame);
                            if (result.state === 'listening') {
                                console.log(JSON.stringify({ chromeClosedMcsLogin: true }));
                                const sent = await webpush.sendNotification(sub.result.value, directMarker, { TTL: 60 });
                                console.log(JSON.stringify({ pushRequestStatus: sent.statusCode }));
                            } else if (result.state === 'received' && directSeen) {
                                await session.ping();
                            }
                            if (directSeen && serverConfirmed && (await sessionStore.pending()).length === 0) { settled = true; clearTimeout(timer); resolve(); }
                        }
                    }).catch(() => { clearTimeout(timer); reject(new Error('MCS_TEST_FRAME_FAILED')); });
                });
            });
            await direct;
            console.log(JSON.stringify({ chromeClosedDirectPushDecrypted: true, serverConfirmedAck: true, mariadb: Boolean(testDb) }));
        } finally { clearTimeout(timer); socket.destroy(); if (!settled) console.log(JSON.stringify({ chromeClosedDirectPushDecrypted: false })); }
    } finally {
        await cdp?.close().catch(() => {});
        if (child.exitCode === null) {
            child.kill();
            await new Promise(resolve => child.once('exit', resolve));
        }
        server.close();
        await testDb?.close();
        await removeOwnedProfile(profile);
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
