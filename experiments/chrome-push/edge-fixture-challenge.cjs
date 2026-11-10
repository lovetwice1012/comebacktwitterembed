'use strict';
// Research helper for synthetic values only. Product identifiers and keys are
// supplied by the test; no browser values or production credentials are stored.
const { createHash } = require('node:crypto');
const MODULUS = 0x7fffffffn, MULTIPLIER = 0x0e79a9c1n;
function syntheticChallengeResponse(challenge, productKey, productId) {
    if (typeof challenge !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(challenge)
        || !Buffer.isBuffer(productKey) || productKey.length !== 16 || !Buffer.isBuffer(productId) || productId.length !== 16)
        throw new Error('PROBE_CHALLENGE_INPUT_INVALID');
    const challengeBytes = Buffer.from(challenge, 'ascii');
    const combined = Buffer.concat([challengeBytes, productId]);
    const padded = Buffer.concat([combined, Buffer.alloc((8 - combined.length % 8) % 8, 0x30)]);
    const digest = createHash('md5').update(challengeBytes).update(productKey).digest();
    try {
        const parts = Array.from({ length: 4 }, (_, i) => BigInt(digest.readUInt32LE(i * 4)) & MODULUS);
        let low = 0n, high = 0n;
        for (let offset = 0; offset < padded.length; offset += 8) {
            const first = BigInt(padded.readUInt32LE(offset)), second = BigInt(padded.readUInt32LE(offset + 4));
            const mixed = (parts[0] * (((MULTIPLIER * first) % MODULUS) + low) + parts[1]) % MODULUS;
            high += mixed;
            low = (parts[2] * ((second + mixed) % MODULUS) + parts[3]) % MODULUS;
            high += low;
        }
        low = (low + parts[1]) % MODULUS; high = (high + parts[3]) % MODULUS;
        const result = Buffer.alloc(16);
        for (let i = 0; i < 4; i++) result.writeUInt32LE((digest.readUInt32LE(i * 4) ^ Number(i % 2 ? high : low)) >>> 0, i * 4);
        return result;
    } finally { challengeBytes.fill(0); combined.fill(0); padded.fill(0); digest.fill(0); }
}
function rewriteSyntheticChallenge(frame, challenge, productKey, productId) {
    if (!Buffer.isBuffer(frame) || frame.length > 262144) throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
    const text = frame.toString('ascii');
    if (!/^PUT \d+ WNS\\CHALLENGE /.test(text)) throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
    const get = tag => {
        const values = [...text.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))];
        if (values.length !== 1) throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
        return values[0][1];
    };
    const id = get('appId'), previous = get('response');
    if (!Buffer.isBuffer(productId) || !Buffer.from(id, 'ascii').equals(productId) || !/^[0-9a-f]{32}$/i.test(previous))
        throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
    const result = syntheticChallengeResponse(challenge, productKey, productId);
    try {
        let replacement = result.toString('hex');
        if (/[A-F]/.test(previous) && !/[a-f]/.test(previous)) replacement = replacement.toUpperCase();
        const output = Buffer.from(text.replace(`<response>${previous}</response>`, `<response>${replacement}</response>`), 'ascii');
        if (output.length !== frame.length) { output.fill(0); throw new Error('PROBE_CHALLENGE_FRAME_INVALID'); }
        return output;
    } finally { result.fill(0); }
}
module.exports = { syntheticChallengeResponse, rewriteSyntheticChallenge };
