'use strict';

// Disposable CI subscription only. This intentionally uses an in-memory
// receipt store; it is not the durable production worker or a delivery test.
const tls = require('node:tls');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const webpush = require('web-push');
const { createFrameDecoder } = require('../../src/automation/chrome-mcs-framing');
const { createChromeMcsSession } = require('../../src/automation/chrome-mcs-session');
const { loginResponse } = require('../../src/automation/chrome-mcs-protobuf');
const { classifyPushError } = require('./chrome-mac-push-error.cjs');
const { createChromeMcsStoreAdapter } = require('../../src/automation/chrome-mcs-store-adapter');

async function receiveSyntheticMacPush({ subscription, vapid, deviceId, securityToken, appId, category, encryption, browserVersion, port = 443, database }) {
    if (port !== 443 && port !== 5228) throw new Error('FIXTURE_MCS_PORT_INVALID');
    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
    const marker = randomBytes(16).toString('hex'), pending = new Set();
    webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
    const socket = tls.connect({ host: 'mtalk.google.com', port, servername: 'mtalk.google.com', timeout: 15000 });
    const decoder = createFrameDecoder(); let timer, queue = Promise.resolve(), received = false, sent = false, stage = 'login', loginDetail = 'none', commitBeforeAck = false;
    const decrypt = (data, headers) => decryptEce(data, headers, {
        public_key: [...Buffer.from(subscription.keys.p256dh, 'base64url')],
        private_key: [...Buffer.from(encryption.privateKey.d, 'base64url')],
        auth_secret: [...Buffer.from(subscription.keys.auth, 'base64url')],
    });
    const memoryStore = { pending: async () => [...pending], commit: async message => { pending.add(message.persistentId); return message; },
        confirm: async ids => { for (const id of ids) pending.delete(id); } };
    const receiptStore = database ? createChromeMcsStoreAdapter({ store: database.store, lease: database.lease, authorize: async () => {},
        decrypt: frame => decrypt(Buffer.from(frame.data, 'base64url'), frame.headers) }) : memoryStore;
    const session = createChromeMcsSession({ credentials: { deviceId, securityToken, clientVersion: browserVersion },
        route: { expectedCategory: category, expectedAppId: appId, expectedSender: encryption.authorizedEntity },
        send: async data => {
            if (database && data[0] === 7) {
                const rows = await database.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_push_inbox WHERE subscription_id=? AND status=?', [database.lease.subscriptionId, 'received']);
                const pendingRows = await database.db.queryDatabase('SELECT COUNT(*) n FROM automation_x_mcs_pending WHERE subscription_id=?', [database.lease.subscriptionId]);
                if (Number(rows[0].n) !== 1 || Number(pendingRows[0].n) !== 1) throw new Error('FIXTURE_MCS_ACK_BEFORE_COMMIT');
                commitBeforeAck = true;
            }
            await new Promise((resolve, reject) => socket.write(data, error => error ? reject(new Error('FIXTURE_MCS_WRITE_FAILED')) : resolve()));
        },
        store: receiptStore,
        onReceipt: async message => {
            stage = 'decrypt';
            const decoded = database ? decrypt(Buffer.from(message.data, 'base64url'), message.headers)
                : decrypt(message.encrypted.data, message.encrypted.headers);
            received = decoded.toString('utf8') === marker;
        } });
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('FIXTURE_MCS_TIMEOUT')), 60000);
            socket.once('error', () => reject(new Error('FIXTURE_MCS_CONNECTION_FAILED')));
            socket.once('timeout', () => reject(new Error('FIXTURE_MCS_CONNECTION_TIMEOUT')));
            socket.once('secureConnect', () => { session.start().catch(() => reject(new Error('FIXTURE_MCS_LOGIN_FAILED'))); });
            socket.on('data', chunk => {
                queue = queue.then(async () => {
                    for (const frame of decoder.push(chunk)) {
                        if (stage === 'login') {
                            loginDetail = `tag${frame.tag}`;
                            if (frame.tag === 3) {
                                try { const reply = loginResponse(frame.payload); loginDetail += reply.accepted ? '_accepted' : `_error${reply.code}`; }
                                catch { loginDetail += '_invalid'; }
                            }
                        }
                        const result = await session.receive(frame);
                        if (result.state === 'listening' && !sent) {
                            sent = true; stage = 'send';
                            try { await webpush.sendNotification(subscription, marker, { TTL: 60, timeout: 15000 }); }
                            catch (error) { throw new Error(`FIXTURE_MCS_SEND_FAILED_${classifyPushError(error)}`); }
                            stage = 'receive';
                        }
                        if (result.state === 'received' && received) { resolve(); return; }
                    }
                }).catch(error => {
                    const code = typeof error?.code === 'string' && /^X_CHROME_[A-Z_]+$/.test(error.code) ? error.code
                        : typeof error?.message === 'string' && /^FIXTURE_MCS_SEND_FAILED_(?:[0-9]{3}|UNKNOWN)_(?:UNREGISTERED|INVALID_TOKEN|EXPIRED|NOT_FOUND|OTHER)$/.test(error.message) ? error.message : 'UNKNOWN';
                    reject(new Error(`FIXTURE_MCS_PROCESSING_FAILED_${stage}_${code}_${loginDetail}`));
                });
            });
        });
        if (database && !commitBeforeAck) throw new Error('FIXTURE_MCS_ACK_NOT_OBSERVED');
    } finally { clearTimeout(timer); session.close(); socket.destroy(); }
}
module.exports = { receiveSyntheticMacPush };
