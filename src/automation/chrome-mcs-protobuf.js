'use strict';

// Narrow, bounded MCS protobuf helpers. The worker acknowledges a receipt
// only after its durable inbox and replay ID have committed together.
const { TextDecoder } = require('node:util');
const { createPrivateKey, createPublicKey, timingSafeEqual } = require('node:crypto');
const { DEFAULT_MAX_FRAME } = require('./chrome-mcs-framing');
const fault = () => Object.assign(new Error('X_CHROME_MCS_PROTO_INVALID'), { code: 'X_CHROME_MCS_PROTO_INVALID' });
const utf8 = new TextDecoder('utf-8', { fatal: true });
const U64_MAX = (1n << 64n) - 1n;

function varint(value) {
    let n = BigInt(value); if (n < 0n || n > U64_MAX) throw fault();
    const bytes = [];
    do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; bytes.push(b); } while (n);
    return Buffer.from(bytes);
}
function uint(field, value) { return Buffer.concat([varint(field * 8), varint(value)]); }
function bytes(field, value) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
}
function readVarint(buffer, offset) {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
        if (offset + i >= buffer.length) throw fault();
        const b = buffer[offset + i];
        if (i === 9 && b > 1) throw fault();
        n |= BigInt(b & 127) << BigInt(i * 7);
        if (!(b & 128)) return { value: n, next: offset + i + 1 };
    }
    throw fault();
}
function fields(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > DEFAULT_MAX_FRAME) throw fault();
    const result = []; let pos = 0;
    while (pos < buffer.length) {
        if (result.length >= 256) throw fault();
        const key = readVarint(buffer, pos); pos = key.next;
        const num = Number(key.value >> 3n), wire = Number(key.value & 7n);
        if (!Number.isSafeInteger(num) || num < 1 || num > 0x1fffffff) throw fault();
        let value;
        if (wire === 0) { const v = readVarint(buffer, pos); value = v.value; pos = v.next; }
        else if (wire === 2) {
            const len = readVarint(buffer, pos); pos = len.next;
            if (len.value > BigInt(buffer.length - pos)) throw fault();
            const end = pos + Number(len.value); value = buffer.subarray(pos, end); pos = end;
        } else if (wire === 1 || wire === 5) {
            const end = pos + (wire === 1 ? 8 : 4); if (end > buffer.length) throw fault();
            value = buffer.subarray(pos, end); pos = end;
        } else throw fault();
        result.push({ num, wire, value });
    }
    return result;
}
function one(list, num, wire, required = true) {
    const hits = list.filter(field => field.num === num);
    if (hits.length > 1 || (required && hits.length !== 1) || (hits.length && hits[0].wire !== wire)) throw fault();
    return hits[0]?.value;
}
function text(value, max = 2048) {
    if (!Buffer.isBuffer(value) || value.length > max) throw fault();
    try { return utf8.decode(value); } catch { throw fault(); }
}
function decimal(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) throw fault();
    const number = BigInt(value); if (number === 0n || number > U64_MAX) throw fault();
    return number;
}
function loginRequest({ deviceId, securityToken, clientVersion, receivedIds = [] }) {
    const id = decimal(deviceId); decimal(securityToken);
    if (typeof clientVersion !== 'string' || !/^[0-9.]{1,40}$/.test(clientVersion)
        || !Array.isArray(receivedIds) || receivedIds.length > 100) throw fault();
    const setting = Buffer.concat([bytes(1, 'new_vc'), bytes(2, '1')]);
    const result = [bytes(1, 'chrome-' + clientVersion), bytes(2, 'mcs.android.com'), bytes(3, deviceId),
        bytes(4, deviceId), bytes(5, securityToken), bytes(6, 'android-' + id.toString(16)), bytes(8, setting)];
    for (const entry of receivedIds) {
        if (typeof entry !== 'string' || !entry || Buffer.byteLength(entry) > 256) throw fault();
        result.push(bytes(10, entry));
    }
    result.push(uint(12, 0), uint(14, 1), uint(16, 2), uint(17, 1));
    return Buffer.concat(result);
}
function loginResponse(buffer) {
    const list = fields(buffer); text(one(list, 1, 2));
    const error = one(list, 3, 2, false);
    if (error) { // Never expose server-provided error strings in logs.
        const info = fields(error); const code = one(info, 1, 0);
        if (code > 0x7fffffffn) throw fault();
        if (code !== 0n) return { accepted: false, code: Number(code) };
    }
    const config = one(list, 7, 2, false);
    if (config) {
        const interval = one(fields(config), 3, 0, false);
        if (interval !== undefined && interval > 0n) {
            if (interval < 1000n || interval > 3600000n) throw fault();
            return { accepted: true, heartbeatIntervalMs: Number(interval) };
        }
    }
    return { accepted: true };
}
function dataMessage(buffer, { expectedCategory, expectedAppId, expectedSender }) {
    if (typeof expectedCategory !== 'string' || !expectedCategory || Buffer.byteLength(expectedCategory) > 256
        || typeof expectedAppId !== 'string' || !expectedAppId || Buffer.byteLength(expectedAppId) > 256
        || typeof expectedSender !== 'string' || !expectedSender || Buffer.byteLength(expectedSender) > 1024) throw fault();
    const list = fields(buffer);
    const category = text(one(list, 5, 2), 256);
    // Chromium only trusts the subtype when the fixed product category
    // matches the category used at registration. Never trust it elsewhere.
    if (category !== expectedCategory) return { matches: false };
    let subtype;
    for (const entry of list.filter(field => field.num === 7)) {
        if (entry.wire !== 2) throw fault();
        const pair = fields(entry.value), key = text(one(pair, 1, 2), 128);
        if (key === 'subtype') {
            if (subtype !== undefined) throw fault();
            subtype = text(one(pair, 2, 2), 256);
        }
    }
    // Never return, persist or log another app's data or metadata.
    if (subtype !== expectedAppId) return { matches: false };
    const from = text(one(list, 3, 2), 1024);
    if (from !== expectedSender) return { matches: false };
    const persistent = one(list, 9, 2, false);
    const raw = one(list, 21, 2, false);
    const headers = Object.create(null);
    let messageType;
    for (const entry of list.filter(field => field.num === 7)) {
        if (entry.wire !== 2) throw fault();
        const pair = fields(entry.value);
        const key = text(one(pair, 1, 2), 128), value = text(one(pair, 2, 2), 4096);
        if (key === 'message_type') {
            if (messageType !== undefined) throw fault();
            messageType = value;
        }
        if (['content-encoding', 'crypto-key', 'encryption', '_googRawData'].includes(key)) {
            if (Object.hasOwn(headers, key)) throw fault();
            headers[key] = value;
        }
    }
    // Deleted-message and send-error control events are not push payloads.
    // The worker must handle them explicitly rather than acknowledge them as X.
    if (messageType !== undefined && messageType !== 'gcm') throw fault();
    return { matches: true, from, persistentId: persistent ? text(persistent, 256) : null,
        rawData: raw ? Buffer.from(raw) : Buffer.alloc(0), headers };
}
// Chromium treats this reserved category as MCS control, not a website push.
// Only the fixed idle request is inspected; no unrelated app payload is read.
function inspectControlMessage(buffer) {
    const list = fields(buffer), category = text(one(list, 5, 2), 256);
    if (category !== 'com.google.android.gsf.gtalkservice') return null;
    let idle = false;
    for (const entry of list.filter(item => item.num === 7)) {
        if (entry.wire !== 2) throw fault();
        const pair = fields(entry.value), key = text(one(pair, 1, 2), 128);
        if (key === 'IdleNotification') idle = true;
    }
    return { idle };
}
function idleResponse(lastReceived, nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw fault();
    const appData = Buffer.concat([bytes(1, 'IdleNotification'), bytes(2, 'false')]);
    // Chromium's MCS sent field uses base::Time seconds since 1601-01-01.
    const sent = Math.floor(nowMs / 1000) + 11644473600;
    return Buffer.concat([bytes(3, 'gcm@android.com'), bytes(5, 'com.google.android.gsf.gtalkservice'), bytes(7, appData),
        uint(11, sequence(lastReceived)), uint(17, 0), uint(18, sent)]);
}
function encryptedPayload(message) {
    if (!message || message.matches !== true || !Buffer.isBuffer(message.rawData) || !message.headers) throw fault();
    const encoding = message.headers['content-encoding'];
    let data = message.rawData;
    if (!data.length && typeof message.headers._googRawData === 'string') {
        const raw = message.headers._googRawData;
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length > DEFAULT_MAX_FRAME) throw fault();
        data = Buffer.from(raw, 'base64');
        if (data.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) throw fault();
    }
    if (!data.length || data.length > DEFAULT_MAX_FRAME) throw fault();
    if (encoding === 'aes128gcm') return { data, headers: { encoding } };
    if ((encoding === undefined || encoding === 'aesgcm') && message.headers.encryption && message.headers['crypto-key'])
        return { data, headers: { encoding: 'aesgcm', encryption: message.headers.encryption, crypto_key: message.headers['crypto-key'] } };
    throw fault();
}
function selectiveAck(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) throw fault();
    const ack = Buffer.concat(ids.map(id => {
        if (typeof id !== 'string' || !id || Buffer.byteLength(id) > 256) throw fault();
        return bytes(1, id);
    }));
    const extension = Buffer.concat([uint(1, 12), bytes(2, ack)]);
    return Buffer.concat([uint(2, 1), bytes(3, ''), bytes(7, extension)]);
}
function sequence(value) {
    if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) throw fault();
    return value;
}
function streamAck(lastReceived) {
    const extension = Buffer.concat([uint(1, 13), bytes(2, '')]);
    return Buffer.concat([uint(2, 1), bytes(3, ''), bytes(7, extension), uint(10, sequence(lastReceived))]);
}
function heartbeatAck(lastReceived) { return uint(2, sequence(lastReceived)); }
function lastStreamReceived(tag, buffer) {
    const fieldByTag = { 0: 2, 1: 2, 3: 6, 7: 10, 8: 11 };
    if (!Object.hasOwn(fieldByTag, tag)) throw fault();
    const value = one(fields(buffer), fieldByTag[tag], 0, false);
    if (value === undefined || value === 0n) return 0;
    if (value > 0x7fffffffn) throw fault();
    return Number(value);
}

// Chromium EncryptionData protobuf: validate all key material against the
// subscription selected in the browser before returning any private material.
// Historical KeyPair records use a different format and intentionally fail
// closed until separately supported and tested.
function readEncryptionData(buffer, { expectedAppId, expectedPublicKey, expectedAuthSecret }) {
    if (typeof expectedAppId !== 'string' || !expectedAppId || !Buffer.isBuffer(expectedPublicKey)
        || expectedPublicKey.length !== 65 || !Buffer.isBuffer(expectedAuthSecret) || expectedAuthSecret.length !== 16) throw fault();
    const list = fields(buffer);
    if (list.some(item => item.num === 2)) throw fault();
    const appId = text(one(list, 1, 2), 256);
    if (appId !== expectedAppId) throw fault();
    const entityBytes = one(list, 4, 2, false);
    const authorizedEntity = entityBytes === undefined ? '' : text(entityBytes, 1024);
    const auth = one(list, 3, 2), der = one(list, 5, 2);
    if (auth.length !== 16 || !timingSafeEqual(auth, expectedAuthSecret) || der.length > 1024) throw fault();
    try {
        const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        const jwk = key.export({ format: 'jwk' });
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw fault();
        const pub = createPublicKey(key).export({ format: 'jwk' });
        const publicBytes = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
        if (publicBytes.length !== 65 || !timingSafeEqual(publicBytes, expectedPublicKey)) throw fault();
        return { authorizedEntity, privateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } };
    } catch { throw fault(); }
}

module.exports = { loginRequest, loginResponse, dataMessage, inspectControlMessage, idleResponse, encryptedPayload, selectiveAck, streamAck, heartbeatAck, lastStreamReceived, readEncryptionData };
