'use strict';

// Extract public protocol metadata from an already authenticated calibration
// browser's bounded BND request. Reconnect tokens and signatures are neither
// returned nor written anywhere by this parser.
const { MAX_HEADER, MAX_PAYLOAD } = require('./edge-wns-framing');
const fail = () => Object.assign(new Error('X_EDGE_WNS_METADATA_INVALID'), { code: 'X_EDGE_WNS_METADATA_INVALID' });
function occurrences(buffer, text) {
    const needle = Buffer.from(text, 'ascii'); let index = 0, count = 0;
    while ((index = buffer.indexOf(needle, index)) !== -1) { count++; index += needle.length; }
    return count;
}
function parseEdgeClientMetadata(frame) {
    try {
        if (!Buffer.isBuffer(frame) || frame.length > MAX_HEADER + 2 + MAX_PAYLOAD) throw fail();
        const end = frame.indexOf('\r\n'), separator = frame.indexOf('\r\n\r\n', end + 2);
        if (end < 0 || end > MAX_HEADER || separator < end + 2 || separator - end - 2 > 8192) throw fail();
        const head = frame.subarray(0, end);
        if (head.some(byte => byte < 0x20 || byte > 0x7e)) throw fail();
        const parts = head.toString('ascii').split(' '), size = parts.at(-1);
        if (parts.length !== 5 || parts[0] !== 'BND' || !/^[1-9]\d{0,6}$/.test(parts[1]) || parts[2] !== 'CON\\WNS'
            || !/^[0-9a-f]{1,16}$/i.test(parts[3]) || !/^\d{1,6}$/.test(size) || Number(size) !== frame.length - end - 2) throw fail();
        const headers = frame.subarray(end + 2, separator);
        if (headers.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) throw fail();
        for (const line of headers.toString('ascii').split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon < 1 || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(line.slice(0, colon)) || /[\r\n]/.test(line.slice(colon + 1))) throw fail();
        }
        const body = frame.subarray(separator + 4);
        if (!body.length || body.length > 16384 || body.some(byte => byte < 0x20 || byte > 0x7e)
            || body.includes(Buffer.from('&')) || body.includes(Buffer.from('<!')) || body.includes(Buffer.from('<?'))
            || !body.subarray(-15).equals(Buffer.from('</client></wns>'))) throw fail();
        if (occurrences(body, '<client>') !== 1 || occurrences(body, '</client>') !== 1
            || occurrences(body, '<name>') !== 1 || occurrences(body, '</name>') !== 1 || occurrences(body, '<ver>') !== 2 || occurrences(body, '</ver>') !== 2) throw fail();
        const prefix = body.subarray(0, Math.min(body.length, 512)).toString('ascii');
        const match = /^<wns><ver>([^<]{1,32})<\/ver><client><name>([^<]{1,128})<\/name><ver>([^<]{1,64})<\/ver>/.exec(prefix);
        if (!match || match.slice(1).some(value => !/^[\x20-\x7e]+$/.test(value) || /[<>&]/.test(value))) throw fail();
        return { channel: parts[3], protocolVersion: match[1], clientName: match[2], clientVersion: match[3] };
    } catch { throw fail(); }
}
module.exports = { parseEdgeClientMetadata };
