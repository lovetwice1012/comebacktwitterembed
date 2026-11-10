'use strict';

// Parse the bounded BND response observed in WNS fixture traffic. The caller
// owns the returned token Buffer and must clear it after durable handling.
const { MAX_HEADER, MAX_PAYLOAD } = require('./edge-wns-framing');
const fail = () => Object.assign(new Error('X_EDGE_WNS_BIND_INVALID'), { code: 'X_EDGE_WNS_BIND_INVALID' });
function parseBindResponse(frame, expectedSequence) {
    if (!Buffer.isBuffer(frame) || frame.length > MAX_HEADER + 2 + MAX_PAYLOAD
        || !Number.isSafeInteger(expectedSequence) || expectedSequence < 1 || expectedSequence > 1000000) throw fail();
    const end = frame.indexOf('\r\n'), separator = frame.indexOf('\r\n\r\n', end + 2);
    if (end < 0 || end > MAX_HEADER || separator < end + 2 || separator - end - 2 > 8192) throw fail();
    const command = frame.subarray(0, end);
    if (command.some(byte => byte < 0x20 || byte > 0x7e)) throw fail();
    const parts = command.toString('ascii').split(' '), size = parts.at(-1);
    if (parts.length !== 4 || parts[0] !== 'BND' || parts[1] !== String(expectedSequence) || parts[2] !== 'CON'
        || !/^\d{1,6}$/.test(size) || Number(size) !== frame.length - end - 2) throw fail();
    const headers = frame.subarray(end + 2, separator);
    if (headers.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) throw fail();
    for (const line of headers.toString('ascii').split('\r\n')) {
        const index = line.indexOf(':');
        if (index < 1 || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(line.slice(0, index)) || /[\r\n]/.test(line.slice(index + 1))) throw fail();
    }
    const bytes = frame.subarray(separator + 4);
    if (!bytes.length || bytes.length > 16384 || bytes.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) throw fail();
    const body = bytes.toString('ascii').trim();
    if (body.includes('&') || body.includes('<!') || body.includes('<?')) throw fail();
    const root = /^<([A-Za-z][A-Za-z0-9-]{0,63})>/.exec(body);
    if (!root || !body.endsWith(`</${root[1]}>`)) throw fail();
    const inner = body.slice(root[0].length, -(root[1].length + 3)), values = new Map();
    const item = /\s*<([A-Za-z][A-Za-z0-9-]{0,63})>([^<>]*)<\/\1>/gy;
    let offset = 0, count = 0;
    while (offset < inner.length) {
        if (/^\s*$/.test(inner.slice(offset))) break;
        item.lastIndex = offset; const match = item.exec(inner);
        if (!match || ++count > 32 || values.has(match[1])) throw fail();
        values.set(match[1], match[2]); offset = item.lastIndex;
    }
    const version = values.get('ver'), nonce = values.get('nonce'), token = values.get('reconnect-token');
    if (typeof version !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(version)
        || typeof nonce !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(nonce)
        || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw fail();
    return { version, nonce, reconnectToken: Buffer.from(token, 'ascii') };
}
module.exports = { parseBindResponse };
