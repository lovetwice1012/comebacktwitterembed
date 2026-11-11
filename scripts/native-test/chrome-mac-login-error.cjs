'use strict';

// Synthetic CI diagnostics only. Return a fixed category, never provider text,
// credentials or arbitrary protobuf fields.
const { TextDecoder } = require('node:util');
function fields(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 65536) throw new Error('invalid');
    let position = 0; const result = [];
    function varint() {
        let value = 0n;
        for (let shift = 0n; shift < 70n; shift += 7n) {
            if (position >= buffer.length) throw new Error('invalid');
            const byte = buffer[position++]; value |= BigInt(byte & 127) << shift;
            if (!(byte & 128)) return value;
        }
        throw new Error('invalid');
    }
    while (position < buffer.length) {
        if (result.length >= 256) throw new Error('invalid');
        const key = varint(), number = Number(key >> 3n), wire = Number(key & 7n);
        if (!Number.isSafeInteger(number) || number < 1 || number > 0x1fffffff) throw new Error('invalid');
        let value;
        if (wire === 0) value = varint();
        else if (wire === 2) { const length = varint(); if (length > BigInt(buffer.length - position)) throw new Error('invalid');
            value = buffer.subarray(position, position + Number(length)); position += Number(length); }
        else if (wire === 1 || wire === 5) { const length = wire === 1 ? 8 : 4; if (position + length > buffer.length) throw new Error('invalid'); position += length; }
        else throw new Error('invalid');
        result.push({ number, wire, value });
    }
    return result;
}
function classifySyntheticLoginError(payload) {
    try {
        const errors = fields(payload).filter(field => field.number === 3);
        if (errors.length !== 1 || errors[0].wire !== 2) return 'MALFORMED';
        const info = fields(errors[0].value), pieces = [];
        for (const number of [2, 3]) {
            const entries = info.filter(field => field.number === number);
            if (entries.length > 1 || entries.some(field => field.wire !== 2 || field.value.length > 2048)) return 'MALFORMED';
            if (entries.length) pieces.push(new TextDecoder('utf-8', { fatal: true }).decode(entries[0].value));
        }
        const text = pieces.join(' ');
        if (/\brate.limit|\bquota|\bthrottl/i.test(text)) return 'RATE';
        if (/\bexpir/i.test(text)) return 'EXPIRED';
        if (/\btoken/i.test(text)) return 'TOKEN';
        if (/\bdevice/i.test(text)) return 'DEVICE';
        if (/\bauth|\bunauthori|\bpermission/i.test(text)) return 'AUTH';
        return 'OTHER';
    } catch { return 'MALFORMED'; }
}
module.exports = { classifySyntheticLoginError };
