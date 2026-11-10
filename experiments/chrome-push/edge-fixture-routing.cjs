'use strict';
// Compares two local, synthetic WNS deliveries. Only structural relationships
// are returned; the notification identifiers and ciphertext are never logged.
const { matchingSyntheticRecordFields, matchingSyntheticTextFields } = require('./edge-fixture-record.cjs');
const { timingSafeEqual } = require('node:crypto');
const invalid = () => new Error('PROBE_ROUTING_INVALID');
function syntheticRecipientMatches(frame, expectedChannel) {
    if (!Buffer.isBuffer(frame) || frame.length > 262144 || !Buffer.isBuffer(expectedChannel) || !expectedChannel.length || expectedChannel.length > 256
        || expectedChannel.some(byte => byte < 0x21 || byte > 0x7e))
        throw invalid();
    const end = frame.indexOf('\r\n'), split = frame.indexOf('\r\n\r\n', end + 2);
    if (end < 0 || end > 512 || split < end || split > end + 8192) throw invalid();
    const head = frame.subarray(0, end);
    if (head.some(byte => byte < 0x20 || byte > 0x7e)) throw invalid();
    const parts = head.toString('ascii').split(' '), length = parts.at(-1);
    if (parts[0] !== 'NFY' || parts[2] !== 'WNS\\NOTIF' || !/^\d{1,6}$/.test(length || '') || Number(length) !== frame.length - end - 2)
        throw invalid();
    const headerBytes = frame.subarray(end + 2, split);
    if (headerBytes.some(byte => byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && (byte < 0x20 || byte > 0x7e))) throw invalid();
    const headers = headerBytes.toString('ascii').split('\r\n'), channels = [];
    for (const line of headers) {
        const colon = line.indexOf(':');
        if (colon < 1 || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(line.slice(0, colon))) throw invalid();
        if (line.slice(0, colon).toLowerCase() === 'channel') channels.push(line.slice(colon + 1).trim());
    }
    if (channels.length !== 1 || !/^[\x21-\x7e]{1,256}$/.test(channels[0])) throw invalid();
    const actual = Buffer.from(channels[0], 'ascii');
    try { return actual.length === expectedChannel.length && timingSafeEqual(actual, expectedChannel); }
    finally { actual.fill(0); }
}
function syntheticIdentity(chunks, ciphertext, options = {}) {
    if (!Array.isArray(chunks) || chunks.length > 4096 || !Buffer.isBuffer(ciphertext) || !ciphertext.length) throw invalid();
    let size = 0;
    for (const chunk of chunks) if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 262144) throw invalid();
    const data = Buffer.concat(chunks); let offset = 0, result;
    try {
        while (offset < data.length) {
            const end = data.indexOf('\r\n', offset); if (end < offset || end - offset > 512) throw invalid();
            const head = data.subarray(offset, end);
            if (!head.length || head.some(byte => byte < 0x20 || byte > 0x7e)) throw invalid();
            const parts = head.toString('ascii').split(' '), length = parts.at(-1);
            if (!/^\d{1,6}$/.test(length)) throw invalid();
            const begin = end + 2, finish = begin + Number(length); if (finish > data.length) throw invalid();
            if (parts[0] === 'NFY' && parts[2] === 'WNS\\NOTIF') {
                const separator = data.indexOf('\r\n\r\n', begin);
                if (separator < begin || separator + 4 > finish || separator - begin > 8192) throw invalid();
                if (data.subarray(separator + 4, finish).equals(ciphertext)) {
                    if (result || !/^[0-9a-f]{1,16}$/i.test(parts[3] || '')) throw invalid();
                    const headers = new Map();
                    const rawHeaders = data.subarray(begin, separator);
                    if (rawHeaders.some(byte => byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && (byte < 0x20 || byte > 0x7e))) throw invalid();
                    for (const line of rawHeaders.toString('ascii').split('\r\n')) {
                        const colon = line.indexOf(':'); if (colon < 1) throw invalid();
                        const name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
                        if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || headers.has(name) || value.length > 4096) throw invalid();
                        headers.set(name, value);
                    }
                    result = { channel: parts[3], headers, ...(options.includeFrame === true ? { frame: Buffer.from(data.subarray(offset, finish)) } : {}) };
                }
            }
            offset = finish;
        }
        if (!result) throw invalid();
        return result;
    } catch (error) { result?.frame?.fill(0); throw error; }
    finally { data.fill(0); }
}
function syntheticRecipientProof(chunks, firstCipher, otherCipher, expectedChannel) {
    let first, other;
    try {
        first = syntheticIdentity(chunks, firstCipher, { includeFrame: true });
        other = syntheticIdentity(chunks, otherCipher, { includeFrame: true });
        return { targetAccepted: syntheticRecipientMatches(first.frame, expectedChannel), otherAccepted: syntheticRecipientMatches(other.frame, expectedChannel) };
    } finally { first?.frame?.fill(0); other?.frame?.fill(0); }
}
function syntheticChannelStability(chunks, firstCipher, firstNextCipher, otherCipher, otherNextCipher) {
    const values = [firstCipher, firstNextCipher, otherCipher, otherNextCipher];
    if (values.some(value => !Buffer.isBuffer(value)) || new Set(values.map(value => value.toString('hex'))).size !== 4) throw invalid();
    const channels = values.map(value => syntheticIdentity(chunks, value).headers.get('channel'));
    if (channels.some(value => typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value))) throw invalid();
    return { targetChannelStable: channels[0] === channels[1], otherChannelStable: channels[2] === channels[3], sitesHaveDistinctChannels: channels[0] !== channels[2] };
}
function compareSyntheticRouting(chunks, firstCipher, secondCipher, firstRecord, secondRecord) {
    if (!Buffer.isBuffer(firstRecord) || !Buffer.isBuffer(secondRecord) || !Buffer.isBuffer(firstCipher) || !Buffer.isBuffer(secondCipher) || firstCipher.equals(secondCipher)) throw invalid();
    const first = syntheticIdentity(chunks, firstCipher), second = syntheticIdentity(chunks, secondCipher);
    const names = [...new Set([...first.headers.keys(), ...second.headers.keys()])].sort();
    const allowed = new Set(['channel', 'context', 'msg-id', 'ms-cv', 'content-type', 'content-encoding', 'content-length', 'crypto-key', 'encryption', 'x-wns-type', 'x-wns-id', 'x-wns-tag']);
    const safe = entries => [...new Set(entries.map(name => allowed.has(name) ? name : 'other'))];
    const present = (record, value) => value && Buffer.byteLength(value) >= 4 && record.includes(Buffer.from(value, 'ascii'));
    return { channelEqual: first.channel === second.channel, headerNames: safe(names),
        distinctHeaders: safe(names.filter(name => first.headers.get(name) !== second.headers.get(name))),
        firstChannelMatchesFields: matchingSyntheticRecordFields(firstRecord, first.channel),
        secondChannelMatchesFields: matchingSyntheticRecordFields(secondRecord, second.channel),
        firstChannelHeaderFields: first.headers.has('channel') ? matchingSyntheticTextFields(firstRecord, first.headers.get('channel')) : [],
        secondChannelHeaderFields: second.headers.has('channel') ? matchingSyntheticTextFields(secondRecord, second.headers.get('channel')) : [],
        headerNamesMatchingOwnRecords: safe(names.filter(name => present(firstRecord, first.headers.get(name)) && present(secondRecord, second.headers.get(name)))),
        headerNamesMatchingOtherRecords: safe(names.filter(name => present(secondRecord, first.headers.get(name)) || present(firstRecord, second.headers.get(name)))) };
}
module.exports = { syntheticRecipientMatches, syntheticIdentity, syntheticRecipientProof, syntheticChannelStability, compareSyntheticRouting };
