'use strict';

// Bounded parser for synthetic captures only. It is not a production WNS
// client, does not authenticate, and cannot safely consume untrusted traffic.
function firstFixtureNotification(chunks, index = 0) {
    if (!Array.isArray(chunks) || chunks.length > 4096 || !Number.isInteger(index) || index < 0 || index > 100) return null;
    let total = 0;
    for (const chunk of chunks) {
        if (!Buffer.isBuffer(chunk) || (total += chunk.length) > 262144) return null;
    }
    const data = Buffer.concat(chunks); let pos = 0, notifications = 0;
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
                if (notifications++ === index) return Buffer.from(data.subarray(headersEnd + 4, frameEnd));
            }
            pos = frameEnd;
        }
        return null;
    } finally { data.fill(0); }
}
// Extract only coarse response metadata from complete synthetic BND frames.
// This is not a production parser and deliberately discards header values.
function fixtureBindResponses(chunks) {
    if (!Array.isArray(chunks) || chunks.length > 4096) return null;
    let size = 0;
    for (const chunk of chunks) if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 262144) return null;
    const data = Buffer.concat(chunks), responses = []; let pos = 0;
    try {
        while (pos < data.length) {
            const end = data.indexOf('\r\n', pos); if (end < pos || end - pos > 512) return null;
            const header = data.subarray(pos, end);
            if (!header.length || header.some(value => value < 0x20 || value > 0x7e)) return null;
            const parts = header.toString('ascii').split(' '), length = parts.at(-1);
            if (!/^\d{1,6}$/.test(length)) return null;
            const start = end + 2, finish = start + Number(length); if (finish > data.length) return null;
            if (parts[0] === 'BND' && parts[2] === 'CON') {
                const separator = data.indexOf('\r\n\r\n', start);
                if (separator < start || separator + 4 > finish || separator - start > 8192) return null;
                const lines = data.subarray(start, separator).toString('ascii').split('\r\n');
                const allowed = new Set(['status', 'status-code', 'error', 'error-code', 'content-type', 'ms-cv']);
                const headers = lines.map(line => { const colon = line.indexOf(':'); return colon > 0 ? [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] : null; }).filter(Boolean);
                const numeric = headers.filter(([name, value]) => ['status', 'status-code', 'error-code'].includes(name) && /^[1-5]\d\d$/.test(value));
                const body = data.subarray(separator + 4, finish).toString('ascii');
                const root = /^\s*<(wns|error|bind)(?:\s|>)/i.exec(body)?.[1]?.toLowerCase() || null;
                responses.push({ headerNames: [...new Set(headers.map(([name]) => name).filter(name => allowed.has(name)))],
                    statusClasses: numeric.map(([, value]) => `${value[0]}xx`), root });
            }
            pos = finish;
        }
        return responses;
    } finally { data.fill(0); }
}
module.exports = { firstFixtureNotification, fixtureBindResponses };
