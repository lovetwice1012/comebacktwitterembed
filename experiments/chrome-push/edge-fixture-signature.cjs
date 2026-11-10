'use strict';
// Interoperability research using disposable credentials only. This is not a
// production WNS implementation or an approved transfer-file format.
const { createHmac } = require('node:crypto');
function syntheticReconnectSignature(key, token, nonce) {
    if (!Buffer.isBuffer(key) || key.length !== 32 || typeof token !== 'string'
        || !/^[\x21-\x7e]{1,4096}$/.test(token) || typeof nonce !== 'string' || !/^\d{32}$/.test(nonce))
        throw new Error('PROBE_SIGNATURE_INPUT_INVALID');
    const input = Buffer.from(token + nonce, 'ascii');
    let digest;
    try {
        digest = createHmac('sha256', key).update(input).digest();
        return Buffer.concat([Buffer.from([1]), digest.subarray(-16)]);
    } finally { input.fill(0); digest?.fill(0); }
}
module.exports = { syntheticReconnectSignature };
