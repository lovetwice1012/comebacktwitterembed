'use strict';

// Authentication primitives only. No vendor credentials, browser data,
// network connections or transfer-file format are provided by this module.
const { createHash, createHmac } = require('node:crypto');
const fail = () => Object.assign(new Error('X_EDGE_WNS_AUTH_INVALID'), { code: 'X_EDGE_WNS_AUTH_INVALID' });
const MODULUS = 0x7fffffffn, MULTIPLIER = 0x0e79a9c1n;

function reconnectSignature(key, token, nonce) {
    if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(token) || !token.length || token.length > 4096
        || token.some(byte => byte < 0x21 || byte > 0x7e) || typeof nonce !== 'string' || !/^\d{32}$/.test(nonce)) throw fail();
    const input = Buffer.concat([token, Buffer.from(nonce, 'ascii')]); let digest;
    try {
        digest = createHmac('sha256', key).update(input).digest();
        return Buffer.concat([Buffer.from([1]), digest.subarray(-16)]);
    } catch { throw fail(); } finally { input.fill(0); digest?.fill(0); }
}

function challengeResponse(challenge, productKey, productId) {
    if (typeof challenge !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(challenge)
        || !Buffer.isBuffer(productKey) || productKey.length !== 16 || !Buffer.isBuffer(productId) || productId.length !== 16) throw fail();
    const challengeBytes = Buffer.from(challenge, 'ascii'), combined = Buffer.concat([challengeBytes, productId]);
    const padded = Buffer.concat([combined, Buffer.alloc((8 - combined.length % 8) % 8, 0x30)]); let digest;
    try {
        digest = createHash('md5').update(challengeBytes).update(productKey).digest();
        const parts = Array.from({ length: 4 }, (_, index) => BigInt(digest.readUInt32LE(index * 4)) & MODULUS);
        let low = 0n, high = 0n;
        for (let offset = 0; offset < padded.length; offset += 8) {
            const first = BigInt(padded.readUInt32LE(offset)), second = BigInt(padded.readUInt32LE(offset + 4));
            const mixed = (parts[0] * (((MULTIPLIER * first) % MODULUS) + low) + parts[1]) % MODULUS;
            high += mixed; low = (parts[2] * ((second + mixed) % MODULUS) + parts[3]) % MODULUS; high += low;
        }
        low = (low + parts[1]) % MODULUS; high = (high + parts[3]) % MODULUS;
        const result = Buffer.alloc(16);
        for (let index = 0; index < 4; index++) result.writeUInt32LE((digest.readUInt32LE(index * 4) ^ Number(index % 2 ? high : low)) >>> 0, index * 4);
        return result;
    } catch { throw fail(); } finally { challengeBytes.fill(0); combined.fill(0); padded.fill(0); digest?.fill(0); }
}
module.exports = { reconnectSignature, challengeResponse };
