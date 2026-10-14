'use strict';

const { createECDH, generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createTransferPublicSealer, createTransferPrivateWorkerVault, identifyTransfer } = require('../../../src/automation/x-setup-transfer');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const sealer = createTransferPublicSealer({ activeKeyId: 'synthetic1', publicKeys: { synthetic1: publicKey } });
const vault = createTransferPrivateWorkerVault({ activeKeyId: 'synthetic1', privateKeys: { synthetic1: privateKey } });
const ownerUserId = '222222222222222222';
function fixture() {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const point = ecdh.getPublicKey(undefined, 'uncompressed');
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0a1', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: randomUUID(), channelID: randomUUID(), pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-ONLY', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: point.toString('base64url'), authenticationSecret: randomBytes(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'), d: ecdh.getPrivateKey().toString('base64url'), ext: true, key_ops: ['deriveBits'] } } };
}
async function insertSubscription(db, file = fixture(), owner = ownerUserId) {
    const subscriptionId = randomUUID(), revision = 1;
    const identity = identifyTransfer(file), envelope = sealer.seal(file, { subscriptionId, ownerUserId: owner, revision });
    await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,0,0)',
        [subscriptionId, owner, identity.uaidHash, identity.channelHash, identity.contentHash, JSON.stringify(envelope), envelope.keyId, file.provenance.browserVersion, revision]);
    return { subscriptionId, ownerUserId: owner, file, envelope };
}
class FakeSocket extends EventEmitter {
    constructor(server) {
        super(); this.readyState = 0; this.sent = []; this.server = server;
        queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); } });
    }
    send(data, _options, complete) {
        const message = JSON.parse(data); this.sent.push(message); complete();
        this.server(message, this);
    }
    reply(value) { this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), false); }
    ping(data, mask, complete) { complete(); this.emit('pong', data); }
    pong(data, mask, complete) { complete(); }
    pause() {}
    resume() {}
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code); }
    terminate() { this.close(1006); }
}
async function encrypted(file, payload, legacy = false) {
    const { encryptFixture } = await import('../../../packages/angelic-angel/tests/fixtures/crypto-fixture-builder.mjs');
    return encryptFixture({ public_key: [...Buffer.from(file.push.p256dhPublicKey, 'base64url')], private_key: [...Buffer.from(file.push.p256dhPrivateKey.d, 'base64url')], auth_secret: [...Buffer.from(file.push.authenticationSecret, 'base64url')] }, JSON.stringify(payload), { legacy });
}
function notification(file, version, wire) { return { messageType: 'notification', channelID: file.push.channelID, version, data: wire.data, headers: wire.headers }; }
module.exports = { ownerUserId, fixture, insertSubscription, FakeSocket, encrypted, notification, vault };
