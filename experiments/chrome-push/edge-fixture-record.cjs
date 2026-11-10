'use strict';
// Synthetic loopback records only. WNS authentication and real Edge profiles
// are not supported; never use this research selector as a production parser.
const { createPrivateKey, ECDH } = require('node:crypto');
const { TextDecoder } = require('node:util');
const decoder = new TextDecoder('utf-8', { fatal: true });
const invalid = () => Object.assign(new Error('EDGE_FIXTURE_RECORD_INVALID'), { code: 'EDGE_FIXTURE_RECORD_INVALID' });
function fields(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 65536) throw invalid();
    let offset = 0; const result = [];
    function varint() {
        let value = 0n;
        for (let i = 0; i < 10; i++) {
            if (offset >= buffer.length) throw invalid();
            const b = buffer[offset++]; if (i === 9 && b > 1) throw invalid();
            value |= BigInt(b & 127) << BigInt(i * 7);
            if (!(b & 128)) { if (i && b === 0) throw invalid(); return value; }
        }
        throw invalid();
    }
    while (offset < buffer.length) {
        if (result.length >= 256) throw invalid();
        const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n);
        if (!Number.isSafeInteger(number) || number < 1 || number > 0x1fffffff) throw invalid();
        let value;
        if (wire === 0) value = varint();
        else if (wire === 2) { const length = varint(); if (length > BigInt(buffer.length - offset)) throw invalid();
            value = buffer.subarray(offset, offset + Number(length)); offset += Number(length); }
        else if (wire === 1 || wire === 5) { const length = wire === 1 ? 8 : 4; if (offset + length > buffer.length) throw invalid(); value = buffer.subarray(offset, offset + length); offset += length; }
        else throw invalid();
        result.push({ number, wire, value });
    }
    return result;
}
function one(list, number, wire) {
    const matches = list.filter(field => field.number === number);
    if (matches.length !== 1 || matches[0].wire !== wire) throw invalid();
    return matches[0].value;
}
function string(value) { try { return decoder.decode(value); } catch { throw invalid(); } }
function selectSyntheticEdgeRecord(records, expectedScope) {
    // Never accept a real site or X; this code is deliberately research-only.
    if (typeof expectedScope !== 'string' || !/^http:\/\/(?:localhost|127\.0\.0\.1):[1-9][0-9]{0,4}\/$/.test(expectedScope)
        || !Array.isArray(records) || records.length > 128) throw invalid();
    try { if (new URL(expectedScope).href !== expectedScope) throw invalid(); } catch { throw invalid(); }
    let selected;
    try {
    for (const raw of records) {
        if (!Buffer.isBuffer(raw) || raw.length > 65536) throw invalid();
        let parsed;
        try { parsed = fields(raw); } catch { if (raw.includes(Buffer.from(expectedScope))) throw invalid(); continue; }
        const metadata = parsed.filter(field => field.number === 8);
        let origins = [];
        try {
            for (const item of metadata) {
                if (item.wire !== 2) throw invalid();
                const pair = fields(item.value), name = string(one(pair, 1, 2));
                if (name === 'origin') origins.push(string(one(pair, 2, 2)));
            }
        } catch { if (raw.includes(Buffer.from(expectedScope))) throw invalid(); continue; }
        if (!origins.includes(expectedScope)) continue;
        if (origins.length !== 1 || selected) throw invalid();
        const channel = one(parsed, 1, 2), endpoint = string(one(parsed, 3, 2)), auth = one(parsed, 6, 2), privateDer = one(parsed, 7, 2), appKey = one(parsed, 16, 2);
        let url, jwk;
        try { url = new URL(endpoint); jwk = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }); } catch { throw invalid(); }
        if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.notify\.windows\.com$/i.test(url.hostname) || url.username || url.password || url.port || url.hash
            || !channel.length || channel.length > 256 || channel.some(byte => byte < 0x21 || byte > 0x7e)
            || auth.length !== 16 || appKey.length !== 65 || appKey[0] !== 4 || jwk.kty !== 'EC' || jwk.crv !== 'P-256'
            || Buffer.from(jwk.x, 'base64url').length !== 32 || Buffer.from(jwk.y, 'base64url').length !== 32 || Buffer.from(jwk.d, 'base64url').length !== 32) throw invalid();
        try { ECDH.convertKey(appKey, 'prime256v1', undefined, undefined, 'uncompressed'); } catch { throw invalid(); }
        selected = { scope: expectedScope, endpoint, channel: Buffer.from(channel), publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]),
            auth: Buffer.from(auth), privateKey: Buffer.from(jwk.d, 'base64url'), applicationServerKey: Buffer.from(appKey) };
    }
    if (!selected) throw invalid();
    return selected;
    } catch (error) {
        if (selected) for (const key of ['channel', 'publicKey', 'auth', 'privateKey', 'applicationServerKey']) selected[key].fill(0);
        throw error;
    }
}
// Return field numbers only; never expose the record or candidate value.
function matchingSyntheticRecordFields(record, candidate) {
    if (typeof candidate !== 'string' || !/^[0-9a-f]{1,16}$/i.test(candidate)) throw invalid();
    const lhs = [BigInt(`0x${candidate}`), ...(/^\d+$/.test(candidate) ? [BigInt(candidate)] : [])];
    return fields(record).filter(item => {
        if (item.wire === 0) return lhs.some(value => value === item.value);
        if (item.wire !== 2 || item.value.length > 32) return false;
        const text = item.value.toString('ascii');
        if (!/^[0-9a-f]{1,32}$/i.test(text)) return false;
        const rhs = [BigInt(`0x${text}`), ...(/^\d+$/.test(text) ? [BigInt(text)] : [])];
        return lhs.some(value => rhs.some(other => value === other));
    }).map(item => ({ field: item.number, wire: item.wire }));
}
function matchingSyntheticTextFields(record, candidate) {
    if (typeof candidate !== 'string' || !/^[\x21-\x7e]{4,4096}$/.test(candidate)) throw invalid();
    const value = Buffer.from(candidate, 'ascii');
    try { return fields(record).filter(item => item.wire === 2 && item.value.includes(value))
        .map(item => ({ field: item.number, relation: item.value.equals(value) ? 'exact' : 'contains' })); }
    finally { value.fill(0); }
}
module.exports = { selectSyntheticEdgeRecord, matchingSyntheticRecordFields, matchingSyntheticTextFields };
