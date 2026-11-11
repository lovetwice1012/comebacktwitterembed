'use strict';

// Isolated v3 validator. This module does not enable intake or connect to WNS.
const { createECDH, createHash, ECDH, timingSafeEqual } = require('node:crypto');
const { connectFrame, bindFrame } = require('./edge-wns-protocol');
const invalid = () => Object.assign(new Error('X_EDGE_TRANSFER_INVALID'), { code: 'X_EDGE_TRANSFER_INVALID' });
function exact(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
}
function bytes(value, size) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(size * 4 / 3)) throw invalid();
    const result = Buffer.from(value, 'base64url');
    if (result.length !== size || result.toString('base64url') !== value) { result.fill(0); throw invalid(); }
    return result;
}
function normalizeEdgeTransfer(file) {
    const allocated = [];
    const take = (value, size) => { const result = bytes(value, size); allocated.push(result); return result; };
    let packet;
    try {
        exact(file, ['format', 'version', 'provenance', 'push']);
        if (file.format !== 'x-notification-subscription' || file.version !== 3) throw invalid();
        const provenance = file.provenance;
        exact(provenance, ['kind', 'adapterVersion', 'browserVersion', 'readMethod']);
        if (provenance.kind !== 'edge-wns' || provenance.adapterVersion !== '1.0.0'
            || provenance.readMethod !== 'edge-wns-snapshot' || typeof provenance.browserVersion !== 'string'
            || !/^[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/.test(provenance.browserVersion)) throw invalid();
        const p = file.push;
        const hasVersion = p && Object.hasOwn(p, 'connectVersion');
        exact(p, ['scope', 'siteChannel', 'deviceKey', 'reconnectToken', 'agent', 'client', 'p256dhPublicKey', 'authenticationSecret', 'p256dhPrivateKey', 'applicationServerKey', ...(hasVersion ? ['connectVersion'] : [])]);
        if (hasVersion && p.connectVersion !== '2') throw invalid();
        if (p.scope !== 'https://x.com/' || typeof p.siteChannel !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(p.siteChannel)
            || typeof p.reconnectToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(p.reconnectToken) || /[<>&]/.test(p.reconnectToken)) throw invalid();
        const device = take(p.deviceKey, 32), token = Buffer.from(p.reconnectToken, 'ascii'); allocated.push(token);
        const pub = take(p.p256dhPublicKey, 65); take(p.authenticationSecret, 16); const app = take(p.applicationServerKey, 65);
        exact(p.p256dhPrivateKey, ['kty', 'crv', 'x', 'y', 'd']);
        const jwk = p.p256dhPrivateKey;
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw invalid();
        const x = take(jwk.x, 32), y = take(jwk.y, 32), d = take(jwk.d, 32);
        const point = Buffer.concat([Buffer.from([4]), x, y]); allocated.push(point);
        const curve = createECDH('prime256v1'); curve.setPrivateKey(d);
        if (!timingSafeEqual(pub, point) || !timingSafeEqual(pub, curve.getPublicKey()) || app[0] !== 4) throw invalid();
        ECDH.convertKey(app, 'prime256v1', undefined, undefined, 'uncompressed');
        exact(p.agent, ['os', 'osVersion', 'architecture', 'locale']);
        exact(p.client, ['channel', 'protocolVersion', 'clientName', 'clientVersion']);
        packet = connectFrame(p.agent, 1); packet.fill(0);
        packet = bindFrame({ ...p.client, nonce: '1'.repeat(32), reconnectToken: token, deviceKey: device }, 3); packet.fill(0); packet = null;
        return { format: file.format, version: 3, provenance: { ...provenance }, push: {
            scope: p.scope, siteChannel: p.siteChannel, deviceKey: p.deviceKey, reconnectToken: p.reconnectToken,
            agent: { ...p.agent }, client: { ...p.client }, p256dhPublicKey: p.p256dhPublicKey,
            authenticationSecret: p.authenticationSecret, p256dhPrivateKey: { ...jwk }, applicationServerKey: p.applicationServerKey,
            ...(hasVersion ? { connectVersion: '2' } : {}) } };
    } catch { throw invalid(); } finally { packet?.fill(0); for (const item of allocated) item.fill(0); }
}
function identifyEdgeTransfer(file) {
    const { push } = normalizeEdgeTransfer(file);
    const hash = value => createHash('sha256').update(value).digest('hex');
    // The browser rotates the WNS reconnect token and updates client metadata.
    // Those changes must not turn the same cryptographic subscription into a
    // different identity or block a safe owner-confirmed refresh.
    const { reconnectToken: _token, agent: _agent, client: _client, connectVersion: _connectVersion, ...stable } = push;
    return { deviceHash: hash(`edge-device\0${push.deviceKey}`), channelHash: hash(`edge-channel\0${push.deviceKey}\0${push.siteChannel}`),
        contentHash: hash(JSON.stringify(stable)) };
}
module.exports = { normalizeEdgeTransfer, identifyEdgeTransfer };
