'use strict';

// Chrome's profile-bound GCM check-in. Credentials are only sent to the fixed
// Google endpoint over HTTPS and must never be included in errors or logs.
const https = require('node:https');
const { TextDecoder } = require('node:util');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX = 256 * 1024, DEFAULT_INTERVAL = 2 * 86400, MIN_INTERVAL = 12 * 3600, MAX_INTERVAL = 0xffffffff;
const U64_MAX = (1n << 64n) - 1n;
const fault = code => Object.assign(new Error(code), { code });
const invalid = () => fault('X_PUSH_CHECKIN_INVALID');
function integer(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) throw invalid();
    const n = BigInt(value); if (n > U64_MAX) throw invalid(); return n;
}
function varint(n) {
    n = BigInt(n); if (n < 0n || n > U64_MAX) throw invalid();
    const b = []; do { let v = Number(n & 127n); n >>= 7n; if (n) v |= 128; b.push(v); } while (n);
    return Buffer.from(b);
}
const number = (field, n) => Buffer.concat([varint(field * 8), varint(n)]);
function bytes(field, value) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]);
}
function fixed(field, n) {
    const value = Buffer.alloc(8); value.writeBigUInt64LE(n);
    return Buffer.concat([varint(field * 8 + 1), value]);
}
function encodeRequest({ deviceId, securityToken, browserVersion, platform = 'windows' }) {
    const id = integer(deviceId), token = integer(securityToken);
    if (typeof browserVersion !== 'string' || !/^[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/.test(browserVersion)) throw invalid();
    // Values are Chromium ChromeBuildProto.Platform, not the worker OS.
    // The caller must determine the source browser's platform explicitly.
    if (platform !== 'windows' && platform !== 'macos') throw invalid();
    const build = Buffer.concat([number(1, platform === 'macos' ? 2 : 1), bytes(2, browserVersion), number(3, 1)]);
    const checkin = Buffer.concat([number(12, 3), bytes(13, build)]);
    return Buffer.concat([number(2, id), bytes(4, checkin), fixed(13, token), number(14, 3), number(22, 0)]);
}
function readVarint(buf, pos) {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
        if (pos + i >= buf.length) throw invalid();
        const b = buf[pos + i]; if (i === 9 && b > 1) throw invalid();
        n |= BigInt(b & 127) << BigInt(i * 7);
        if (!(b & 128)) return { n, pos: pos + i + 1 };
    }
    throw invalid();
}
function fields(buf) {
    if (!Buffer.isBuffer(buf) || buf.length > MAX) throw invalid();
    const out = []; let pos = 0;
    while (pos < buf.length) {
        if (out.length >= 4096) throw invalid();
        let v = readVarint(buf, pos); pos = v.pos;
        const field = Number(v.n >> 3n), wire = Number(v.n & 7n);
        if (!Number.isSafeInteger(field) || field < 1 || field > 0x1fffffff) throw invalid();
        let value;
        if (wire === 0) { v = readVarint(buf, pos); pos = v.pos; value = v.n; }
        else if (wire === 2) {
            v = readVarint(buf, pos); pos = v.pos;
            if (v.n > BigInt(buf.length - pos)) throw invalid();
            const end = pos + Number(v.n); value = buf.subarray(pos, end); pos = end;
        } else if (wire === 1 || wire === 5) {
            const end = pos + (wire === 1 ? 8 : 4); if (end > buf.length) throw invalid();
            value = buf.subarray(pos, end); pos = end;
        } else throw invalid();
        out.push({ field, wire, value });
    }
    return out;
}
function single(list, field, wire, required = true) {
    const matches = list.filter(v => v.field === field);
    if (matches.length > 1 || (required && !matches.length) || (matches.length && matches[0].wire !== wire)) throw invalid();
    return matches[0]?.value;
}
function string(buf, max = 4096) {
    if (!Buffer.isBuffer(buf) || buf.length > max) throw invalid();
    try { return utf8.decode(buf); } catch { throw invalid(); }
}
function decodeResponse(buffer, credentials, previousInterval = DEFAULT_INTERVAL) {
    if (!Number.isSafeInteger(previousInterval) || previousInterval < MIN_INTERVAL || previousInterval > MAX_INTERVAL) throw invalid();
    const list = fields(buffer), stats = single(list, 1, 0);
    if (stats !== 0n && stats !== 1n) throw invalid();
    const id = single(list, 7, 1).readBigUInt64LE(), token = single(list, 8, 1).readBigUInt64LE();
    if (!id || !token) throw invalid();
    // A replacement would invalidate the already-imported subscription. Do
    // not overwrite it or register a new device without explicit user action.
    if (id !== integer(credentials.deviceId) || token !== integer(credentials.securityToken)) throw fault('X_PUSH_CHECKIN_ID_CHANGED');
    const diff = single(list, 9, 0, false);
    if (diff !== undefined && diff !== 0n && diff !== 1n) throw invalid();
    let interval = diff === 1n || diff === undefined ? previousInterval : DEFAULT_INTERVAL;
    let checkinUrl = 'https://android.clients.google.com/checkin', hostname = 'mtalk.google.com', port = '5228';
    // Chromium validates the protobuf but leaves all settings untouched when
    // settings_diff is absent. In a diff it applies delete_ keys in order.
    const deleted = list.filter(v => v.field === 10);
    if (deleted.some(v => v.wire !== 2)) throw invalid();
    for (const item of deleted) string(item.value);
    for (const item of list.filter(v => v.field === 5)) {
        if (item.wire !== 2) throw invalid();
        const setting = fields(item.value), name = string(single(setting, 1, 2)), value = string(single(setting, 2, 2));
        if (!name) throw invalid();
        if (diff === undefined) continue;
        if (diff === 1n && name.startsWith('delete_')) {
            switch (name.slice(7)) {
                case 'checkin_interval': interval = DEFAULT_INTERVAL; break;
                case 'checkin_url': checkinUrl = 'https://android.clients.google.com/checkin'; break;
                case 'gcm_hostname': hostname = 'mtalk.google.com'; break;
                case 'gcm_secure_port': port = '5228'; break;
            }
            continue;
        }
        if (name === 'checkin_interval') {
            if (!/^-?[0-9]{1,10}$/.test(value)) throw invalid();
            const seconds = Number(value); if (!Number.isSafeInteger(seconds) || seconds > MAX_INTERVAL) throw invalid();
            interval = Math.max(MIN_INTERVAL, seconds);
        }
        if (name === 'checkin_url') checkinUrl = value;
        if (name === 'gcm_hostname') hostname = value;
        if (name === 'gcm_secure_port') port = value;
    }
    // Do not silently send credentials to a new endpoint, or claim to honor a
    // transport endpoint we do not actually use. Deletions above restore defaults.
    if ((checkinUrl && checkinUrl !== 'https://android.clients.google.com/checkin') || (hostname && hostname !== 'mtalk.google.com')
        || (port && port !== '5228' && port !== '443')) throw fault('X_PUSH_CHECKIN_CONFIG_CHANGED');
    return { intervalSeconds: interval };
}
function checkin(credentials, { previousInterval = DEFAULT_INTERVAL, timeoutMs = 15000, signal = undefined, request = https.request } = {}) {
    const payload = encodeRequest(credentials);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000 || typeof request !== 'function') throw invalid();
    return new Promise((resolve, reject) => {
        let finished = false, timer, req;
        const finish = (error, value) => {
            if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
        };
        const abort = () => { req?.destroy(); finish(fault('X_PUSH_CHECKIN_STOPPED')); };
        if (signal?.aborted) return abort();
        try {
            req = request({ protocol: 'https:', hostname: 'android.clients.google.com', port: 443, path: '/checkin', method: 'POST',
                headers: { 'content-type': 'application/x-protobuf', 'content-length': String(payload.length) } }, response => {
                const chunks = []; let length = 0;
                response.on('data', chunk => {
                    length += chunk.length;
                    if (length > MAX) { response.destroy(); finish(fault('X_PUSH_CHECKIN_INVALID')); }
                    else chunks.push(chunk);
                });
                response.on('error', () => finish(fault('X_PUSH_CHECKIN_NETWORK')));
                response.on('end', () => {
                    if (response.statusCode === 401) return finish(fault('X_PUSH_CHECKIN_UNAUTHORIZED'));
                    if (response.statusCode === 400) return finish(fault('X_PUSH_CHECKIN_BAD_REQUEST'));
                    if (response.statusCode !== 200) return finish(fault('X_PUSH_CHECKIN_NETWORK'));
                    try { finish(null, decodeResponse(Buffer.concat(chunks), credentials, previousInterval)); }
                    catch (error) { finish(error); }
                });
            });
            req.on('error', () => finish(fault('X_PUSH_CHECKIN_NETWORK')));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) return abort();
            timer = setTimeout(() => { req.destroy(); finish(fault('X_PUSH_CHECKIN_TIMEOUT')); }, timeoutMs);
            req.end(payload);
        } catch { finish(fault('X_PUSH_CHECKIN_NETWORK')); }
    });
}
module.exports = { encodeRequest, decodeResponse, checkin, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL };
