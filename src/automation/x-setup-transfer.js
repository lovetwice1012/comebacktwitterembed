'use strict';

const { KeyObject, constants, createCipheriv, createDecipheriv, createECDH, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, timingSafeEqual } = require('node:crypto');
const { AutomationError } = require('./service');

const MAX_FILE_BYTES = 32768;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HYBRID_ALGORITHM = 'RSA-OAEP-256+A256GCM';
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const INVALID_MESSAGE = '設定ファイルを確認できませんでした。専用ツールで書き出したファイルを選んでください。';

function invalidFile() { return new AutomationError('X_SETUP_INVALID_FILE', INVALID_MESSAGE, 422); }
function vaultUnavailable() { return new AutomationError('X_SETUP_VAULT_UNAVAILABLE', '通知設定を安全に保存できません。管理者による確認が必要です。', 503); }
function decryptFailed() { return new AutomationError('X_SETUP_DECRYPT_FAILED', '保存された通知設定を確認できません。管理者による確認が必要です。', 503); }
function reject() { throw invalidFile(); }

function exactFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (names.length !== fields.length || names.some(name => typeof name !== 'string' || !fields.includes(name) || !Object.hasOwn(descriptors[name], 'value'))) reject();
}

// JSON.parse alone silently accepts duplicate keys, including escaped aliases. Scan
// every object before parsing and bound nesting independently of the JSON engine.
function parseUniqueJson(source) {
    let offset = 0;
    // JSON strings must reject unescaped control bytes while allowing escapes.
    // eslint-disable-next-line no-control-regex
    const stringToken = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const whitespace = () => { while (offset < source.length && /[ \t\r\n]/.test(source[offset])) offset++; };
    function readString() {
        stringToken.lastIndex = offset;
        const match = stringToken.exec(source);
        if (!match) reject();
        offset = stringToken.lastIndex;
        return JSON.parse(match[0]);
    }
    function value(depth) {
        if (depth > 12) reject();
        whitespace();
        if (source[offset] === '{') {
            offset++; whitespace();
            const names = new Set();
            if (source[offset] === '}') { offset++; return; }
            while (true) {
                whitespace();
                const name = readString();
                if (names.has(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) reject();
                names.add(name); whitespace();
                if (source[offset++] !== ':') reject();
                value(depth + 1); whitespace();
                const next = source[offset++];
                if (next === '}') return;
                if (next !== ',') reject();
            }
        }
        if (source[offset] === '[') {
            offset++; whitespace();
            if (source[offset] === ']') { offset++; return; }
            while (true) {
                value(depth + 1); whitespace();
                const next = source[offset++];
                if (next === ']') return;
                if (next !== ',') reject();
            }
        }
        if (source[offset] === '"') { readString(); return; }
        for (const literal of ['true', 'false', 'null']) {
            if (source.startsWith(literal, offset)) { offset += literal.length; return; }
        }
        numberToken.lastIndex = offset;
        if (!numberToken.exec(source)) reject();
        offset = numberToken.lastIndex;
    }
    value(0); whitespace();
    if (offset !== source.length) reject();
    return JSON.parse(source);
}

function decode(value, length) {
    if (typeof value !== 'string' || value.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) reject();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== length || bytes.toString('base64url') !== value) reject();
    return bytes;
}
function canonicalUrl(value) {
    // Literal whitespace/control characters cannot be silently normalized by URL.
    if (typeof value !== 'string' || !value.length || value.length > 4096
        || /[\u0000-\u0020\u007f?#]/.test(value)) reject(); // eslint-disable-line no-control-regex
    const url = new URL(value);
    if (url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) reject();
    return url;
}
function normalizeFile(file) {
    exactFields(file, ['format', 'version', 'provenance', 'push']);
    if (file.format !== 'x-notification-subscription' || file.version !== 1) reject();
    const provenance = file.provenance;
    exactFields(provenance, ['kind', 'adapterVersion', 'browserVersion', 'readMethod']);
    if (provenance.kind !== 'firefox-pushdb' || provenance.adapterVersion !== '1.0.0'
        || provenance.readMethod !== 'gecko-indexeddb-readonly'
        || typeof provenance.browserVersion !== 'string' || !/^[0-9A-Za-z._+-]{1,64}$/.test(provenance.browserVersion)) reject();
    const push = file.push;
    exactFields(push, ['uaid', 'channelID', 'pushEndpoint', 'scope', 'originAttributes', 'p256dhPublicKey', 'authenticationSecret', 'p256dhPrivateKey']);
    if (typeof push.uaid !== 'string' || !(/^[0-9a-f]{32}$/.test(push.uaid) || UUID.test(push.uaid))
        || typeof push.channelID !== 'string' || !UUID.test(push.channelID) || push.originAttributes !== '') reject();
    const endpoint = canonicalUrl(push.pushEndpoint);
    if (endpoint.hostname !== 'updates.push.services.mozilla.com' || endpoint.pathname === '/') reject();
    if (canonicalUrl(push.scope).origin !== 'https://x.com') reject();
    const publicKey = decode(push.p256dhPublicKey, 65);
    decode(push.authenticationSecret, 16);
    const jwk = push.p256dhPrivateKey;
    exactFields(jwk, ['kty', 'crv', 'x', 'y', 'd', 'ext', 'key_ops']);
    const operations = jwk.key_ops;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.ext !== true || !Array.isArray(operations)
        || Reflect.ownKeys(operations).length !== 2 || !Object.hasOwn(Object.getOwnPropertyDescriptor(operations, '0') || {}, 'value')
        || operations.length !== 1 || operations[0] !== 'deriveBits') reject();
    const x = decode(jwk.x, 32), y = decode(jwk.y, 32), d = decode(jwk.d, 32);
    const scalar = BigInt('0x' + d.toString('hex'));
    if (scalar <= 0n || scalar >= P256_ORDER) reject();
    const expected = Buffer.concat([Buffer.from([4]), x, y]);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    // Compare the complete SEC1 point; x-only agreement would accept Q and -Q.
    if (!timingSafeEqual(publicKey, expected) || !timingSafeEqual(publicKey, ecdh.getPublicKey(undefined, 'uncompressed'))) reject();
    return {
        format: 'x-notification-subscription', version: 1,
        provenance: { kind: provenance.kind, adapterVersion: provenance.adapterVersion, browserVersion: provenance.browserVersion, readMethod: provenance.readMethod },
        push: {
            uaid: push.uaid, channelID: push.channelID, pushEndpoint: push.pushEndpoint, scope: push.scope, originAttributes: '',
            p256dhPublicKey: push.p256dhPublicKey, authenticationSecret: push.authenticationSecret,
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true, key_ops: ['deriveBits'] },
        },
    };
}
function parseTransferFile(fileText) {
    if (typeof fileText !== 'string') throw invalidFile();
    if (Buffer.byteLength(fileText, 'utf8') > MAX_FILE_BYTES) throw new AutomationError('X_SETUP_FILE_TOO_LARGE', '設定ファイルのサイズが上限を超えています。', 413);
    try { return normalizeFile(parseUniqueJson(fileText)); } catch { throw invalidFile(); }
}
function identifyTransfer(file) {
    try {
        const normalized = normalizeFile(file);
        const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
        return { uaidHash: hash(normalized.push.uaid.replace(/-/g, '')), channelHash: hash(normalized.push.channelID), contentHash: hash(JSON.stringify(normalized)) };
    } catch { throw invalidFile(); }
}

function vaultKeys(options) {
    try {
        if (!options || typeof options.activeKeyId !== 'string' || !KEY_ID.test(options.activeKeyId)) throw new Error();
        const entries = options.keys instanceof Map ? [...options.keys] : Object.entries(options.keys);
        if (!entries.length || entries.length > 64) throw new Error();
        const keys = new Map();
        for (const [id, key] of entries) {
            if (typeof id !== 'string' || !KEY_ID.test(id) || !Buffer.isBuffer(key) || key.length !== 32) throw new Error();
            keys.set(id, Buffer.from(key));
        }
        if (!keys.has(options.activeKeyId)) throw new Error();
        return { activeKeyId: options.activeKeyId, keys };
    } catch { throw vaultUnavailable(); }
}
function associatedData(context, keyId, version = 1, algorithm = 'A256GCM') {
    exactFields(context, ['subscriptionId', 'ownerUserId', 'revision']);
    if (typeof context.subscriptionId !== 'string' || !UUID.test(context.subscriptionId)
        || typeof context.ownerUserId !== 'string' || !/^[0-9]{1,32}$/.test(context.ownerUserId)
        || !Number.isSafeInteger(context.revision) || context.revision < 1) throw new Error();
    return Buffer.from(JSON.stringify(['x-notification-subscription-vault', version, algorithm, keyId, context.subscriptionId, context.ownerUserId, context.revision]), 'utf8');
}
function sealerFor(config) {
    return (file, context) => {
        // Keep file validation errors useful to intake callers, without copying data.
        let normalized;
        try { normalized = normalizeFile(file); } catch { throw invalidFile(); }
        try {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', config.keys.get(config.activeKeyId), iv, { authTagLength: 16 });
            cipher.setAAD(associatedData(context, config.activeKeyId));
            const ciphertext = Buffer.concat([cipher.update(JSON.stringify(normalized), 'utf8'), cipher.final()]);
            return { version: 1, algorithm: 'A256GCM', keyId: config.activeKeyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
        } catch { throw vaultUnavailable(); }
    };
}
function createTransferSealer(options) {
    return Object.freeze({ seal: sealerFor(vaultKeys(options)) });
}
// This separate constructor is for a trusted future worker. Intake only needs
// createTransferSealer and must never receive an object exposing open().
function createTransferWorkerVault(options) {
    const config = vaultKeys(options);
    return Object.freeze({
        seal: sealerFor(config),
        open(envelope, context) {
            try {
                exactFields(envelope, ['version', 'algorithm', 'keyId', 'iv', 'ciphertext', 'tag']);
                if (envelope.version !== 1 || envelope.algorithm !== 'A256GCM' || typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId)) throw new Error();
                const key = config.keys.get(envelope.keyId);
                if (!key || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext.length || envelope.ciphertext.length > Math.ceil(MAX_FILE_BYTES * 4 / 3)) throw new Error();
                const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
                if (ciphertext.toString('base64url') !== envelope.ciphertext) throw new Error();
                const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12), { authTagLength: 16 });
                decipher.setAAD(associatedData(context, envelope.keyId));
                decipher.setAuthTag(decode(envelope.tag, 16));
                const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                return parseTransferFile(plaintext.toString('utf8'));
            } catch { throw decryptFailed(); }
        },
    });
}

function rsaKeys(options, role) {
    try {
        if (!options || typeof options.activeKeyId !== 'string' || !KEY_ID.test(options.activeKeyId)) throw new Error();
        const supplied = role === 'public' ? options.publicKeys : options.privateKeys;
        const entries = supplied instanceof Map ? [...supplied] : Object.entries(supplied);
        if (!entries.length || entries.length > 64) throw new Error();
        const keys = new Map();
        for (const [id, input] of entries) {
            if (typeof id !== 'string' || !KEY_ID.test(id)) throw new Error();
            let key;
            if (input instanceof KeyObject) key = input;
            else if (typeof input === 'string' && input.length <= 16384) {
                // Do not derive a public key from private material in the web
                // constructor. Accept one PEM block of the requested role only.
                const pem = input.trim();
                const allowed = role === 'public'
                    ? /^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----$/
                    : /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----$/;
                if (!allowed.test(pem)) throw new Error();
                key = role === 'public' ? createPublicKey(pem) : createPrivateKey(pem);
            } else throw new Error();
            const modulusLength = key.asymmetricKeyDetails?.modulusLength;
            if (key.type !== role || key.asymmetricKeyType !== 'rsa' || !Number.isInteger(modulusLength)
                || modulusLength < 3072 || modulusLength > 4096) throw new Error();
            keys.set(id, { key, bytes: Math.ceil(modulusLength / 8) });
        }
        if (!keys.has(options.activeKeyId)) throw new Error();
        return { activeKeyId: options.activeKeyId, keys };
    } catch { throw vaultUnavailable(); }
}

// The web role possesses RSA public keys only. Each envelope has a fresh AES
// data key, and only the worker's private key can unwrap that key afterwards.
function createTransferPublicSealer(options) {
    const config = rsaKeys(options, 'public');
    return Object.freeze({
        seal(file, context) {
            let normalized;
            try { normalized = normalizeFile(file); } catch { throw invalidFile(); }
            let dataKey;
            try {
                const aad = associatedData(context, config.activeKeyId, 2, HYBRID_ALGORITHM);
                dataKey = randomBytes(32);
                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: 16 });
                cipher.setAAD(aad);
                const ciphertext = Buffer.concat([cipher.update(JSON.stringify(normalized), 'utf8'), cipher.final()]);
                const wrapped = publicEncrypt({ key: config.keys.get(config.activeKeyId).key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: aad }, dataKey);
                return { version: 2, algorithm: HYBRID_ALGORITHM, keyId: config.activeKeyId, wrappedKey: wrapped.toString('base64url'), iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
            } catch { throw vaultUnavailable(); }
            finally { dataKey?.fill(0); }
        },
    });
}

function createTransferPrivateWorkerVault(options) {
    const config = rsaKeys(options, 'private');
    return Object.freeze({
        open(envelope, context) {
            let dataKey;
            try {
                exactFields(envelope, ['version', 'algorithm', 'keyId', 'wrappedKey', 'iv', 'ciphertext', 'tag']);
                if (envelope.version !== 2 || envelope.algorithm !== HYBRID_ALGORITHM || typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId)) throw new Error();
                const recipient = config.keys.get(envelope.keyId);
                if (!recipient || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext.length || envelope.ciphertext.length > Math.ceil(MAX_FILE_BYTES * 4 / 3)) throw new Error();
                const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
                if (ciphertext.toString('base64url') !== envelope.ciphertext) throw new Error();
                const aad = associatedData(context, envelope.keyId, 2, HYBRID_ALGORITHM);
                dataKey = privateDecrypt({ key: recipient.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: aad }, decode(envelope.wrappedKey, recipient.bytes));
                if (dataKey.length !== 32) throw new Error();
                const decipher = createDecipheriv('aes-256-gcm', dataKey, decode(envelope.iv, 12), { authTagLength: 16 });
                decipher.setAAD(aad);
                decipher.setAuthTag(decode(envelope.tag, 16));
                const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                return parseTransferFile(plaintext.toString('utf8'));
            } catch { throw decryptFailed(); }
            finally { dataKey?.fill(0); }
        },
    });
}

module.exports = { MAX_FILE_BYTES, parseTransferFile, identifyTransfer, createTransferSealer, createTransferWorkerVault, createTransferPublicSealer, createTransferPrivateWorkerVault };
