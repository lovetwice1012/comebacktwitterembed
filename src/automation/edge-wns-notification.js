'use strict';

// Parse only the envelope required for routing and acknowledgment. This
// module does not decrypt, store, send or acknowledge a notification.
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { MAX_HEADER, MAX_PAYLOAD } = require('./edge-wns-framing');
const fail = (stage = 'INVALID') => Object.assign(new Error('X_EDGE_WNS_NOTIFICATION_INVALID'), { code: 'X_EDGE_WNS_NOTIFICATION_INVALID', stage });
function printable(value, maximum) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/.test(value);
}
function parseNotification(frame, expectedChannel) {
    if (!Buffer.isBuffer(frame) || frame.length > MAX_HEADER + 2 + MAX_PAYLOAD || !Buffer.isBuffer(expectedChannel)
        || expectedChannel.length < 1 || expectedChannel.length > 256 || expectedChannel.some(byte => byte < 0x21 || byte > 0x7e)) throw fail('INPUT');
    const end = frame.indexOf('\r\n'), separator = frame.indexOf('\r\n\r\n', end + 2);
    if (end < 0 || end > MAX_HEADER || separator < end + 2 || separator - (end + 2) > 8192) throw fail('BOUNDARY');
    const head = frame.subarray(0, end);
    if (head.some(byte => byte < 0x20 || byte > 0x7e)) throw fail('COMMAND_BYTES');
    const parts = head.toString('ascii').split(' ');
    if (![4, 5].includes(parts.length)) throw fail('COMMAND_PARTS');
    if (parts[0] !== 'NFY' || parts[2] !== 'WNS\\NOTIF') throw fail('COMMAND_ROUTE');
    if (!/^\d{1,10}$/.test(parts[1])) throw fail('COMMAND_SEQUENCE');
    const providerChannel = parts.length === 5 ? parts[3] : null, size = parts.at(-1);
    if (providerChannel !== null && !/^[0-9a-f]{1,16}$/i.test(providerChannel)) throw fail('COMMAND_CHANNEL');
    if (!/^\d{1,6}$/.test(size) || Number(size) !== frame.length - end - 2) throw fail('COMMAND_LENGTH');
    const headerBytes = frame.subarray(end + 2, separator);
    if (headerBytes.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) throw fail('HEADER_BYTES');
    const selected = new Map();
    for (const line of headerBytes.toString('ascii').split('\r\n')) {
        const colon = line.indexOf(':'), name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
        if (colon < 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || value.length > 4096 || /[\r\n]/.test(value)) throw fail('HEADER');
        if (['channel', 'msg-id', 'content-encoding'].includes(name)) {
            if (selected.has(name)) throw fail('DUPLICATE');
            selected.set(name, value);
        }
    }
    const channel = selected.get('channel'), messageId = selected.get('msg-id');
    if (!printable(channel, 256) || !printable(messageId, 256)) throw fail('IDENTITY');
    const actual = Buffer.from(channel, 'ascii');
    let matches;
    try { matches = actual.length === expectedChannel.length && timingSafeEqual(actual, expectedChannel); }
    finally { actual.fill(0); }
    const acknowledgement = { providerChannel, messageId };
    // A different site's payload never leaves this branch or reaches a
    // decryption function. The ACK metadata contains no payload or site key.
    if (!matches) return { kind: 'foreign', acknowledgement };
    if (String(selected.get('content-encoding') || '').toLowerCase() !== 'aes128gcm') throw fail('ENCODING');
    const data = Buffer.from(frame.subarray(separator + 4));
    if (!data.length) throw fail('EMPTY');
    return { kind: 'target', acknowledgement, data, headers: { encoding: 'aes128gcm' } };
}
function createAcknowledgement(input, sequence) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw fail();
    const properties = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(properties);
    if (names.length !== 2 || names.some(name => typeof name !== 'string' || !['providerChannel', 'messageId'].includes(name)
        || !Object.hasOwn(properties[name], 'value')) || input.providerChannel !== null
        && (typeof input.providerChannel !== 'string' || !/^[0-9a-f]{1,16}$/i.test(input.providerChannel))
        || !printable(input.messageId, 256) || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 1000000) throw fail();
    const correlation = `${randomBytes(12).toString('base64')}.0`;
    const body = Buffer.from(`MS-CV: ${correlation}\r\nMsg-Id: ${input.messageId}\r\n\r\n`, 'ascii');
    const route = input.providerChannel === null ? '' : ` ${input.providerChannel}`;
    return Buffer.concat([Buffer.from(`ACK ${sequence} WNS\\NOTIF${route} ${body.length}\r\n`, 'ascii'), body]);
}
module.exports = { parseNotification, createAcknowledgement };
