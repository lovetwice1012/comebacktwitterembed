'use strict';

// Bounded parser for synthetic captures only. It is not a production WNS
// client, does not authenticate, and cannot safely consume untrusted traffic.
function firstFixtureNotification(chunks) {
    if (!Array.isArray(chunks) || chunks.length > 4096) return null;
    let total = 0;
    for (const chunk of chunks) {
        if (!Buffer.isBuffer(chunk) || (total += chunk.length) > 262144) return null;
    }
    const data = Buffer.concat(chunks); let pos = 0;
    try {
        while (pos < data.length) {
            const end = data.indexOf('\r\n', pos);
            if (end < pos || end - pos > 512) return null;
            const headerBytes = data.subarray(pos, end);
            if (!headerBytes.length || headerBytes.some(byte => byte < 0x20 || byte > 0x7e)) return null;
            const line = headerBytes.toString('ascii');
            const parts = line.split(' '), sizeText = parts.at(-1);
            if (!/^\d{1,6}$/.test(sizeText)) return null;
            const size = Number(sizeText), payload = end + 2, frameEnd = payload + size;
            if (size > 262144 || frameEnd > data.length) return null;
            if (parts[0] === 'NFY' && parts.includes('WNS\\NOTIF')) {
                const headersEnd = data.indexOf('\r\n\r\n', payload);
                if (headersEnd < payload || headersEnd + 4 > frameEnd || headersEnd - payload > 8192) return null;
                const headers = data.subarray(payload, headersEnd).toString('ascii').split('\r\n');
                const encoding = headers.filter(header => /^content-encoding:/i.test(header));
                if (encoding.length !== 1 || !/^content-encoding:\s*aes128gcm\s*$/i.test(encoding[0])) return null;
                return Buffer.from(data.subarray(headersEnd + 4, frameEnd));
            }
            pos = frameEnd;
        }
        return null;
    } finally { data.fill(0); }
}
module.exports = { firstFixtureNotification };
