'use strict';

// Disposable synthetic subscriptions only. The caller supplies the marker
// sent before this connection; this helper never sends another notification.
const tls = require('node:tls');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFrameDecoder } = require('../../src/automation/chrome-mcs-framing');
const { createChromeMcsSession } = require('../../src/automation/chrome-mcs-session');

async function receiveExpectedSyntheticPush({ subscription, deviceId, securityToken, appId, category, encryption, browserVersion, marker }) {
    if (typeof marker !== 'string' || !/^fixture-[a-f0-9]{32}$/.test(marker)) throw new Error('FIXTURE_MARKER_INVALID');
    const { decryptEce } = await import(pathToFileURL(path.resolve(__dirname, '../../packages/angelic-angel/dist/crypto.js')).href);
    const pending = new Set(); let matched = false, listening = false, queue = Promise.resolve(), timer, stage = 'login';
    const socket = tls.connect({ host: 'mtalk.google.com', port: 443, servername: 'mtalk.google.com', timeout: 15000 });
    const decoder = createFrameDecoder();
    const session = createChromeMcsSession({ credentials: { deviceId, securityToken, clientVersion: browserVersion },
        route: { expectedCategory: category, expectedAppId: appId, expectedSender: encryption.authorizedEntity },
        send: async frame => new Promise((resolve, reject) => socket.write(frame, error => error ? reject(new Error('FIXTURE_MCS_WRITE_FAILED')) : resolve())),
        store: { pending: async () => [...pending], commit: async message => { pending.add(message.persistentId); return message; },
            confirm: async ids => { for (const id of ids) pending.delete(id); } },
        onReceipt: async message => {
            stage = 'decrypt';
            const keys = {
                public_key: [...Buffer.from(subscription.keys.p256dh, 'base64url')],
                private_key: [...Buffer.from(encryption.privateKey.d, 'base64url')],
                auth_secret: [...Buffer.from(subscription.keys.auth, 'base64url')],
            }; let decoded;
            try { decoded = decryptEce(message.encrypted.data, message.encrypted.headers, keys); matched = decoded.toString('utf8') === marker; }
            finally { Object.values(keys).forEach(value => value.fill(0)); decoded?.fill(0); }
        } });
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('FIXTURE_MCS_EXPECTED_TIMEOUT')), 60000);
            socket.once('error', () => reject(new Error('FIXTURE_MCS_CONNECTION_FAILED')));
            socket.once('timeout', () => reject(new Error('FIXTURE_MCS_CONNECTION_TIMEOUT')));
            socket.once('close', () => reject(new Error('FIXTURE_MCS_CONNECTION_CLOSED')));
            socket.once('secureConnect', () => { session.start().catch(() => reject(new Error('FIXTURE_MCS_LOGIN_FAILED'))); });
            socket.on('data', chunk => {
                queue = queue.then(async () => {
                    for (const frame of decoder.push(chunk)) {
                        const result = await session.receive(frame);
                        if (result.state === 'listening') { listening = true; stage = 'receive'; }
                        if (result.state === 'received' && matched) { resolve(); return; }
                    }
                }).catch(error => reject(new Error(error?.code === 'X_CHROME_SESSION_LOGIN_FAILED' ? 'FIXTURE_MCS_LOGIN_REJECTED'
                    : stage === 'decrypt' ? 'FIXTURE_MCS_DECRYPT_OR_RECEIPT_FAILED' : 'FIXTURE_MCS_PROCESSING_FAILED')));
            });
        });
        if (!listening || !matched) throw new Error('FIXTURE_MCS_RECEIPT_INVALID');
    } finally { clearTimeout(timer); session.close(); socket.destroy(); }
}
module.exports = { receiveExpectedSyntheticPush };
