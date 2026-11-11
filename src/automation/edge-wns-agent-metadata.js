'use strict';

// Experimental parser for the observed CNT wire shape. It returns only the
// four agent fields and must not log the frame or infer values from the OS.
const { MAX_HEADER, MAX_PAYLOAD } = require('./edge-wns-framing');
const fail = () => Object.assign(new Error('X_EDGE_WNS_AGENT_INVALID'), { code: 'X_EDGE_WNS_AGENT_INVALID' });

function parseEdgeAgentMetadata(frame) {
    try {
        if (!Buffer.isBuffer(frame) || frame.length > MAX_HEADER + 2 + MAX_PAYLOAD) throw fail();
        const end = frame.indexOf('\r\n'), separator = frame.indexOf('\r\n\r\n', end + 2);
        if (end < 0 || end > MAX_HEADER || separator < end + 2 || separator - end - 2 > 8192) throw fail();
        const command = frame.subarray(0, end);
        if (command.some(byte => byte < 0x20 || byte > 0x7e)) throw fail();
        const parts = command.toString('ascii').split(' '), size = parts.at(-1);
        if (parts.length !== 4 || parts[0] !== 'CNT' || !/^[1-9]\d{0,6}$/.test(parts[1]) || parts[2] !== 'CON'
            || !/^\d{1,6}$/.test(size) || Number(size) !== frame.length - end - 2) throw fail();
        const headers = frame.subarray(end + 2, separator);
        if (headers.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) throw fail();
        for (const line of headers.toString('ascii').split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon < 1 || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(line.slice(0, colon)) || /[\r\n]/.test(line.slice(colon + 1))) throw fail();
        }
        const body = frame.subarray(separator + 4);
        if (!body.length || body.length > 4096 || body.some(byte => byte < 0x20 || byte > 0x7e)) throw fail();
        const match = /^<connect><ver>1<\/ver><agent><os>([^<>&]{1,128})<\/os><osVer>([^<>&]{1,128})<\/osVer><proc>([^<>&]{1,128})<\/proc><lcid>([^<>&]{1,128})<\/lcid><\/agent><\/connect>$/.exec(body.toString('ascii'));
        if (!match) throw fail();
        return { os: match[1], osVersion: match[2], architecture: match[3], locale: match[4] };
    } catch { throw fail(); }
}
module.exports = { parseEdgeAgentMetadata };
