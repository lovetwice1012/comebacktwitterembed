'use strict';
// Disposable-profile research only: never feed real browser records here.
const { randomBytes, timingSafeEqual } = require('node:crypto');
function replaceSyntheticKey(record, originalKey) {
    if (!Buffer.isBuffer(record) || record.length > 65536 || !Buffer.isBuffer(originalKey)
        || !/^[A-Za-z0-9+/]{43}=$/.test(originalKey.toString('ascii')) || Buffer.from(originalKey.toString('ascii'), 'base64').length !== 32)
        throw new Error('PROBE_DEVICE_INVALID');
    const offset = record.indexOf(originalKey);
    if (offset < 0 || offset !== record.lastIndexOf(originalKey)) throw new Error('PROBE_DEVICE_AMBIGUOUS');
    const secret = randomBytes(32), key = Buffer.from(secret.toString('base64'), 'ascii'); secret.fill(0);
    if (timingSafeEqual(key, originalKey)) { key.fill(0); throw new Error('PROBE_DEVICE_INVALID'); }
    const changed = Buffer.from(record); key.copy(changed, offset);
    return { record: changed, key };
}
module.exports = { replaceSyntheticKey };
