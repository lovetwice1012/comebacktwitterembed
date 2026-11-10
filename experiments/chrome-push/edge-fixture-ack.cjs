'use strict';
// Synthetic-only WNS acknowledgement construction. This is not a durable
// production ACK policy and must not be used before a real receipt commits.
const { randomBytes } = require('node:crypto');
function syntheticNotificationAck(frame, sequence) {
    if (!Buffer.isBuffer(frame) || frame.length > 262144 || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 1000000)
        throw new Error('PROBE_ACK_INVALID');
    const end = frame.indexOf('\r\n'), split = frame.indexOf('\r\n\r\n', end + 2);
    if (end < 0 || end > 512 || split < end || split > end + 8192) throw new Error('PROBE_ACK_INVALID');
    const parts = frame.subarray(0, end).toString('ascii').split(' '), size = parts.at(-1);
    if (parts[0] !== 'NFY' || parts[2] !== 'WNS\\NOTIF' || !/^[0-9a-f]{1,16}$/i.test(parts[3] || '')
        || !/^\d{1,6}$/.test(size || '') || Number(size) !== frame.length - end - 2) throw new Error('PROBE_ACK_INVALID');
    const headers = frame.subarray(end + 2, split).toString('ascii').split('\r\n');
    const ids = headers.map(line => /^msg-id:\s*([^\r\n]+)$/i.exec(line)?.[1]?.trim()).filter(Boolean);
    if (ids.length !== 1 || !/^[\x21-\x7e]{1,256}$/.test(ids[0])) throw new Error('PROBE_ACK_INVALID');
    const correlation = `${randomBytes(12).toString('base64')}.0`;
    const body = Buffer.from(`MS-CV: ${correlation}\r\nMsg-Id: ${ids[0]}\r\n\r\n`, 'ascii');
    return Buffer.concat([Buffer.from(`ACK ${sequence} WNS\\NOTIF ${parts[3]} ${body.length}\r\n`, 'ascii'), body]);
}
module.exports = { syntheticNotificationAck };
