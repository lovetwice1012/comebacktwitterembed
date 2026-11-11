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

async function receiveSyntheticMacPush({ subscription, vapid, deviceId, securityToken, appId, category, encryption, browserVersion }) {
    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
    const marker = randomBytes(16).toString('hex'), pending = new Set();
    webpush.setVapidDetails('mailto:fixture@example.com', vapid.publicKey, vapid.privateKey);
    const socket = tls.connect({ host: 'mtalk.google.com', port: 443, servername: 'mtalk.google.com', timeout: 15000 });
    const decoder = createFrameDecoder(); let timer, queue = Promise.resolve(), received = false, sent = false;
    const session = createChromeMcsSession({ credentials: { deviceId, securityToken, clientVersion: browserVersion },
        route: { expectedCategory: category, expectedAppId: appId, expectedSender: encryption.authorizedEntity },
        send: data => new Promise((resolve, reject) => socket.write(data, error => error ? reject(new Error('FIXTURE_MCS_WRITE_FAILED')) : resolve())),
        store: { pending: async () => [...pending], commit: async message => { pending.add(message.persistentId); return message; },
            confirm: async ids => { for (const id of ids) pending.delete(id); } },
        onReceipt: async message => {
            const decoded = decryptEce(message.encrypted.data, message.encrypted.headers, {
                public_key: [...Buffer.from(subscription.keys.p256dh, 'base64url')],
                private_key: [...Buffer.from(encryption.privateKey.d, 'base64url')],
                auth_secret: [...Buffer.from(subscription.keys.auth, 'base64url')],
            });
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
                        const result = await session.receive(frame);
                        if (result.state === 'listening' && !sent) {
                            sent = true;
                            try { await webpush.sendNotification(subscription, marker, { TTL: 60 }); }
                            catch { throw new Error('FIXTURE_MCS_SEND_FAILED'); }
                        }
                        if (result.state === 'received' && received) { resolve(); return; }
                    }
                }).catch(() => reject(new Error('FIXTURE_MCS_PROCESSING_FAILED')));
            });
        });
    } finally { clearTimeout(timer); session.close(); socket.destroy(); }
}
module.exports = { receiveSyntheticMacPush };
