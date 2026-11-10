'use strict';
// Synthetic research only. This mirrors the existing hybrid-vault primitives
// with a separate domain; it is not a production key format or migration.
const { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, constants } = require('node:crypto');
const fail = () => Object.assign(new Error('PROBE_STATE_VAULT_INVALID'), { code: 'PROBE_STATE_VAULT_INVALID' });
function aad(context) {
    if (!context || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(context.subscriptionId || '')
        || !/^\d{1,32}$/.test(context.ownerUserId || '') || !Number.isSafeInteger(context.revision) || context.revision < 1
        || !Number.isSafeInteger(context.generation) || context.generation < 1) throw fail();
    return Buffer.from(JSON.stringify(['synthetic-wns-state', 1, context.subscriptionId, context.ownerUserId, context.revision, context.generation]));
}
function decode(value, length) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) throw fail();
    return bytes;
}
function createSyntheticStateVault(privateInput) {
    let privateKey, publicKey;
    try {
        privateKey = createPrivateKey(privateInput); publicKey = createPublicKey(privateKey);
        const bits = privateKey.asymmetricKeyDetails?.modulusLength;
        if (privateKey.asymmetricKeyType !== 'rsa' || !Number.isInteger(bits) || bits < 3072 || bits > 4096) throw fail();
    } catch { throw fail(); }
    const wrappedLength = Math.ceil(privateKey.asymmetricKeyDetails.modulusLength / 8);
    return {
        seal(token, context) {
            if (!Buffer.isBuffer(token) || token.length < 1 || token.length > 4096 || token.some(byte => byte < 0x21 || byte > 0x7e)) throw fail();
            const associated = aad(context), dataKey = randomBytes(32), iv = randomBytes(12);
            try {
                const cipher = createCipheriv('aes-256-gcm', dataKey, iv); cipher.setAAD(associated);
                const ciphertext = Buffer.concat([cipher.update(token), cipher.final()]);
                const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: associated }, dataKey);
                return { version: 1, algorithm: 'RSA-OAEP-256+A256GCM', wrappedKey: wrapped.toString('base64url'), iv: iv.toString('base64url'),
                    ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
            } catch { throw fail(); } finally { dataKey.fill(0); associated.fill(0); }
        },
        open(envelope, context) {
            let dataKey;
            const associated = aad(context);
            try {
                if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
                    || ![Object.prototype, null].includes(Object.getPrototypeOf(envelope))
                    || Reflect.ownKeys(envelope).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(envelope, key), 'value'))
                    || Object.keys(envelope).sort().join(',') !== ['algorithm', 'ciphertext', 'iv', 'tag', 'version', 'wrappedKey'].sort().join(',')
                    || envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-256+A256GCM'
                    || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 5462) throw fail();
                dataKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: associated }, decode(envelope.wrappedKey, wrappedLength));
                if (dataKey.length !== 32) throw fail();
                const decipher = createDecipheriv('aes-256-gcm', dataKey, decode(envelope.iv, 12)); decipher.setAAD(associated); decipher.setAuthTag(decode(envelope.tag, 16));
                const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]);
                if (!plaintext.length || plaintext.length > 4096 || plaintext.some(byte => byte < 0x21 || byte > 0x7e)) { plaintext.fill(0); throw fail(); }
                return plaintext;
            } catch { throw fail(); } finally { dataKey?.fill(0); associated.fill(0); }
        },
    };
}
module.exports = { createSyntheticStateVault };
