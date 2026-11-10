'use strict';

// Pure selection of a single X subscription from an already isolated snapshot.
// This module does not discover profiles, open databases or unprotect OS keys.
const { readEncryptionData } = require('./chrome-mcs-protobuf');
const { normalizeChromeTransfer, isChromeAppId } = require('./chrome-x-transfer');
const fault = code => Object.assign(new Error(code), { code });
function dataObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fault('X_CHROME_SNAPSHOT_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))) throw fault('X_CHROME_SNAPSHOT_INVALID');
    return value;
}
function bytes(value, length) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw fault('X_CHROME_SNAPSHOT_INVALID');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== length || decoded.toString('base64url') !== value) throw fault('X_CHROME_SNAPSHOT_INVALID');
    return decoded;
}
function selectChromeMapping(preferences) {
    dataObject(preferences); const gcm = dataObject(preferences.gcm);
    const map = dataObject(gcm.push_messaging_application_id_map);
    if (gcm.product_category_for_subtypes !== 'com.chrome.windows') throw fault('X_CHROME_SNAPSHOT_UNSUPPORTED');
    const entries = Object.entries(map);
    if (entries.length > 64 || entries.some(([id, value]) => typeof id !== 'string' || typeof value !== 'string' || value.length > 2048))
        throw fault('X_CHROME_SNAPSHOT_INVALID');
    const selected = entries.filter(([, value]) => value.split('#')[0] === 'https://x.com/');
    if (selected.length !== 1) throw fault(selected.length ? 'X_CHROME_SNAPSHOT_AMBIGUOUS' : 'X_CHROME_SNAPSHOT_NOT_FOUND');
    if (!isChromeAppId(selected[0][0])) throw fault('X_CHROME_SNAPSHOT_INVALID');
    return { appId: selected[0][0], productCategory: gcm.product_category_for_subtypes, otherSubscriptionCount: entries.length - 1 };
}
function buildChromeTransfer({ preferences, subscription, records, deviceId, securityToken, browserVersion }) {
    try {
        const selected = selectChromeMapping(preferences);
        dataObject(subscription); dataObject(subscription.keys);
        const origin = new URL(subscription.scope);
        const endpoint = new URL(subscription.endpoint);
        if (origin.origin !== 'https://x.com' || origin.username || origin.password || origin.hash || origin.search
            || endpoint.protocol !== 'https:' || endpoint.hostname !== 'fcm.googleapis.com' || endpoint.port
            || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || !endpoint.pathname.startsWith('/fcm/send/'))
            throw fault('X_CHROME_SNAPSHOT_INVALID');
        const appId = selected.appId;
        if (!Array.isArray(records) || records.length > 4) throw fault('X_CHROME_SNAPSHOT_INVALID');
        const candidates = records.filter(record => {
            dataObject(record);
            return typeof record.key === 'string' && (record.key === appId || record.key.startsWith(appId + ','));
        });
        if (candidates.length !== 1 || !Buffer.isBuffer(candidates[0].value)) throw fault('X_CHROME_SNAPSHOT_AMBIGUOUS');
        const keys = readEncryptionData(candidates[0].value, { expectedAppId: appId,
            expectedPublicKey: bytes(subscription.keys.p256dh, 65), expectedAuthSecret: bytes(subscription.keys.auth, 16) });
        if (!keys.authorizedEntity || candidates[0].key !== `${appId},${keys.authorizedEntity}`) throw fault('X_CHROME_SNAPSHOT_INVALID');
        const file = normalizeChromeTransfer({ format: 'x-notification-subscription', version: 2,
            provenance: { kind: 'chrome-gcm', adapterVersion: '1.0.0', browserVersion, readMethod: 'chrome-gcm-snapshot' },
            push: { deviceId, securityToken, appId, productCategory: selected.productCategory,
                authorizedEntity: keys.authorizedEntity, scope: 'https://x.com/', p256dhPublicKey: subscription.keys.p256dh,
                authenticationSecret: subscription.keys.auth, p256dhPrivateKey: keys.privateKey } });
        return { file, otherSubscriptionCount: selected.otherSubscriptionCount };
    } catch (error) {
        const code = typeof error?.code === 'string' && /^X_CHROME_SNAPSHOT_[A-Z_]+$/.test(error.code)
            ? error.code : 'X_CHROME_SNAPSHOT_INVALID';
        throw fault(code);
    }
}
module.exports = { buildChromeTransfer, selectChromeMapping };
