'use strict';

// Select one X subscription from a bounded, caller-supplied snapshot. This
// parser neither opens browser profiles nor creates or uploads a transfer file.
const { createECDH, createPrivateKey, ECDH, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const decode = new TextDecoder('utf-8', { fatal: true });
const SCOPE = 'https://x.com/';
const fail = () => Object.assign(new Error('X_EDGE_WNS_RECORD_INVALID'), { code: 'X_EDGE_WNS_RECORD_INVALID' });
function fields(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 65536) throw fail();
    let offset = 0; const result = [];
    function varint() {
        let value = 0n;
        for (let i = 0; i < 10; i++) {
            if (offset >= buffer.length) throw fail();
            const byte = buffer[offset++]; if (i === 9 && byte > 1) throw fail();
            value |= BigInt(byte & 127) << BigInt(i * 7);
            if (!(byte & 128)) { if (i && byte === 0) throw fail(); return value; }
        }
        throw fail();
    }
    while (offset < buffer.length) {
        if (result.length >= 256) throw fail();
        const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n);
        if (!Number.isSafeInteger(number) || number < 1 || number > 0x1fffffff) throw fail();
        let value;
        if (wire === 0) value = varint();
        else if (wire === 2) {
            const size = varint(); if (size > BigInt(buffer.length - offset)) throw fail();
            value = buffer.subarray(offset, offset + Number(size)); offset += Number(size);
        } else if (wire === 1 || wire === 5) {
            const size = wire === 1 ? 8 : 4; if (offset + size > buffer.length) throw fail();
            value = buffer.subarray(offset, offset + size); offset += size;
        } else throw fail();
        result.push({ number, wire, value });
    }
    return result;
}
function one(list, number, wire) {
    const found = list.filter(field => field.number === number);
    if (found.length !== 1 || found[0].wire !== wire) throw fail();
    return found[0].value;
}
function text(value) { try { return decode.decode(value); } catch { throw fail(); } }
function same(a, b) { return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b); }
function endpoint(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) throw fail(); // eslint-disable-line no-control-regex
    let url;
    try { url = new URL(value); } catch { throw fail(); }
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.notify\.windows\.com$/i.test(url.hostname)
        || url.username || url.password || url.port || url.hash || url.href !== value) throw fail();
    return value;
}
function validExpected(expected) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || ![Object.prototype, null].includes(Object.getPrototypeOf(expected))) throw fail();
    const descriptors = Object.getOwnPropertyDescriptors(expected), keys = Reflect.ownKeys(descriptors);
    const names = ['endpoint', 'publicKey', 'auth', 'applicationServerKey'];
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw fail();
    endpoint(expected.endpoint);
    if (!Buffer.isBuffer(expected.publicKey) || expected.publicKey.length !== 65 || expected.publicKey[0] !== 4
        || !Buffer.isBuffer(expected.auth) || expected.auth.length !== 16 || !Buffer.isBuffer(expected.applicationServerKey)
        || expected.applicationServerKey.length !== 65 || expected.applicationServerKey[0] !== 4) throw fail();
    try { ECDH.convertKey(expected.publicKey, 'prime256v1', undefined, undefined, 'uncompressed');
        ECDH.convertKey(expected.applicationServerKey, 'prime256v1', undefined, undefined, 'uncompressed'); } catch { throw fail(); }
}
function clearRecord(record) {
    if (record) for (const name of ['channel', 'publicKey', 'auth', 'privateKey', 'applicationServerKey']) record[name]?.fill(0);
}
// Inspect only each record's origin metadata. If any site record cannot be
// classified, fail closed instead of understating the other-site count.
function countOtherSiteRecords(records) {
    if (!Array.isArray(records) || !records.length || records.length > 128) throw fail();
    let xCount = 0, otherCount = 0;
    try {
        for (const raw of records) {
            const parsed = fields(raw), origins = [];
            for (const item of parsed.filter(field => field.number === 8)) {
                if (item.wire !== 2) throw fail();
                const pair = fields(item.value), name = text(one(pair, 1, 2));
                if (name === 'origin') origins.push(text(one(pair, 2, 2)));
            }
            if (origins.length !== 1 || !origins[0] || origins[0].length > 4096 || /[\u0000-\u001f\u007f]/.test(origins[0])) throw fail(); // eslint-disable-line no-control-regex
            if (origins[0] === SCOPE) xCount++; else otherCount++;
        }
        if (xCount !== 1) throw fail();
        return otherCount;
    } catch { throw fail(); }
}
// Parse only an already-selected device record. Profile discovery, snapshot
// creation and identifying the unique device key belong to the caller.
function selectDeviceRecord(raw) {
    let key;
    try {
        const parsed = fields(raw), token = one(parsed, 2, 2), encoded = one(parsed, 3, 2);
        if (!token.length || token.length > 4096 || token.some(byte => byte < 0x21 || byte > 0x7e || [38, 60, 62].includes(byte))
            || encoded.length !== 44 || encoded.some(byte => byte > 0x7f)) throw fail();
        const textKey = encoded.toString('ascii');
        if (!/^[A-Za-z0-9+/]{43}=$/.test(textKey)) throw fail();
        key = Buffer.from(textKey, 'base64');
        if (key.length !== 32 || key.toString('base64') !== textKey) throw fail();
        return { reconnectToken: Buffer.from(token), deviceKey: Buffer.from(key) };
    } catch { throw fail(); } finally { key?.fill(0); }
}
function selectXRecord(records, expected) {
    validExpected(expected);
    if (!Array.isArray(records) || records.length > 128 || records.some(raw => !Buffer.isBuffer(raw) || raw.length > 65536)) throw fail();
    let selected;
    try {
        for (const raw of records) {
            let parsed;
            try { parsed = fields(raw); } catch { if (raw.includes(Buffer.from(SCOPE))) throw fail(); continue; }
            let origins = [];
            try {
                for (const item of parsed.filter(field => field.number === 8)) {
                    if (item.wire !== 2) throw fail();
                    const pair = fields(item.value), name = text(one(pair, 1, 2));
                    if (name === 'origin') origins.push(text(one(pair, 2, 2)));
                }
            } catch { if (raw.includes(Buffer.from(SCOPE))) throw fail(); continue; }
            if (!origins.includes(SCOPE)) continue;
            if (origins.length !== 1 || selected) throw fail();
            const channel = one(parsed, 1, 2), rawEndpoint = endpoint(text(one(parsed, 3, 2)));
            const auth = one(parsed, 6, 2), privateDer = one(parsed, 7, 2), app = one(parsed, 16, 2);
            if (!Buffer.isBuffer(channel) || !channel.length || channel.length > 256 || channel.some(byte => byte < 0x21 || byte > 0x7e)
                || !same(auth, expected.auth) || !same(app, expected.applicationServerKey) || rawEndpoint !== expected.endpoint) throw fail();
            let jwk, privateKey;
            try {
                jwk = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
                if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') throw fail();
                privateKey = Buffer.from(jwk.d, 'base64url');
                if (privateKey.length !== 32 || privateKey.toString('base64url') !== jwk.d) throw fail();
                const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(privateKey);
                const publicKey = ecdh.getPublicKey(undefined, 'uncompressed');
                if (!same(publicKey, expected.publicKey)) { publicKey.fill(0); throw fail(); }
                selected = { scope: SCOPE, endpoint: rawEndpoint, channel: Buffer.from(channel), publicKey,
                    auth: Buffer.from(auth), privateKey: Buffer.from(privateKey), applicationServerKey: Buffer.from(app) };
            } catch { throw fail(); } finally { privateKey?.fill(0); }
        }
        if (!selected) throw fail();
        return selected;
    } catch { clearRecord(selected); throw fail(); }
}
module.exports = { selectXRecord, selectDeviceRecord, countOtherSiteRecords, clearRecord };
