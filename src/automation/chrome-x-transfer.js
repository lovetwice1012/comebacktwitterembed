'use strict';

// Strict validation for Chrome subscription transfers. Intake and the worker
// require a separate server-side Chrome feature opt-in.
const { createECDH, createHash, timingSafeEqual } = require('node:crypto');
const INVALID = () => Object.assign(new Error('X_CHROME_TRANSFER_INVALID'), { code: 'X_CHROME_TRANSFER_INVALID' });
const UUID_PART = '[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{9}-V2';
const APP_ID = new RegExp(`^wp:https://x\\.com/#${UUID_PART}$`);
const U64_MAX = (1n << 64n) - 1n;

function object(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw INVALID();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== allowed.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key)
        || !Object.hasOwn(descriptors[key], 'value'))) throw INVALID();
}
function decimal(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > U64_MAX) throw INVALID();
    return value;
}
function base64url(value, size) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw INVALID();
    const result = Buffer.from(value, 'base64url');
    if (result.length !== size || result.toString('base64url') !== value) throw INVALID();
    return result;
}
function normalizeChromeTransfer(file) {
    try {
        object(file, ['format', 'version', 'provenance', 'push']);
        if (file.format !== 'x-notification-subscription' || file.version !== 2) throw INVALID();
        const kindDescriptor = file.provenance && Object.getOwnPropertyDescriptor(file.provenance, 'kind');
        const isBrave = kindDescriptor && Object.hasOwn(kindDescriptor, 'value') && kindDescriptor.value === 'brave-gcm';
        object(file.provenance, isBrave ? ['kind', 'adapterVersion', 'browserVersion', 'engineVersion', 'readMethod']
            : ['kind', 'adapterVersion', 'browserVersion', 'readMethod']);
        const provenance = file.provenance;
        const versionPattern = /^[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/;
        if ((!isBrave && (provenance.kind !== 'chrome-gcm' || provenance.readMethod !== 'chrome-gcm-snapshot'))
            || (isBrave && (provenance.readMethod !== 'brave-gcm-snapshot' || typeof provenance.engineVersion !== 'string' || !versionPattern.test(provenance.engineVersion)))
            || provenance.adapterVersion !== '1.0.0' || typeof provenance.browserVersion !== 'string' || !versionPattern.test(provenance.browserVersion)) throw INVALID();
        object(file.push, ['deviceId', 'securityToken', 'appId', 'productCategory', 'authorizedEntity', 'scope',
            'p256dhPublicKey', 'authenticationSecret', 'p256dhPrivateKey']);
        const push = file.push;
        decimal(push.deviceId); decimal(push.securityToken);
        if (typeof push.appId !== 'string' || !APP_ID.test(push.appId)
            || push.productCategory !== (isBrave ? 'com.brave.windows' : 'com.chrome.windows') || push.scope !== 'https://x.com/'
            || typeof push.authorizedEntity !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(push.authorizedEntity)) throw INVALID();
        const publicKey = base64url(push.p256dhPublicKey, 65);
        base64url(push.authenticationSecret, 16);
        object(push.p256dhPrivateKey, ['kty', 'crv', 'x', 'y', 'd']);
        const jwk = push.p256dhPrivateKey;
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw INVALID();
        const x = base64url(jwk.x, 32), y = base64url(jwk.y, 32), d = base64url(jwk.d, 32);
        const expected = Buffer.concat([Buffer.from([4]), x, y]);
        const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(d);
        if (!timingSafeEqual(publicKey, expected) || !timingSafeEqual(publicKey, ecdh.getPublicKey())) throw INVALID();
        return { format: file.format, version: 2,
            provenance: { kind: provenance.kind, adapterVersion: provenance.adapterVersion, browserVersion: provenance.browserVersion,
                ...(isBrave ? { engineVersion: provenance.engineVersion } : {}), readMethod: provenance.readMethod },
            push: { deviceId: push.deviceId, securityToken: push.securityToken, appId: push.appId,
                productCategory: push.productCategory, authorizedEntity: push.authorizedEntity, scope: push.scope,
                p256dhPublicKey: push.p256dhPublicKey, authenticationSecret: push.authenticationSecret,
                p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } } };
    } catch { throw INVALID(); }
}
function identifyChromeTransfer(file) {
    const normalized = normalizeChromeTransfer(file), hash = data => createHash('sha256').update(data).digest('hex');
    return { deviceHash: hash('chrome-device\0' + normalized.push.deviceId),
        // Browser upgrades change provenance, not the Push subscription. Bind
        // idempotency to all device, routing and cryptographic material.
        appHash: hash('chrome-app\0' + normalized.push.appId), contentHash: hash(JSON.stringify(normalized.push)) };
}

module.exports = { normalizeChromeTransfer, identifyChromeTransfer, isChromeAppId: value => typeof value === 'string' && APP_ID.test(value) };
