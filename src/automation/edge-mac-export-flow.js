'use strict';

// Experimental local-only composition. The caller must obtain verified
// calibration data and stop all browser processes before invoking this flow.
const { ClassicLevel } = require('classic-level');
const { withMacEdgeSnapshot } = require('./chrome-mac-snapshot');
const { readEdgeSnapshot } = require('./edge-wns-snapshot-io');
const { writeExperimentalMacEdgeExport } = require('./edge-mac-private-export');
const fail = code => Object.assign(new Error(code), { code });
function exact(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw fail('X_EDGE_MAC_FLOW_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key)
        || !Object.hasOwn(descriptors[key], 'value'))) throw fail('X_EDGE_MAC_FLOW_INVALID');
}

async function exportExperimentalMacEdgeNotifications({ rootPath, profileId, helperPath, expectedSha256, subscription,
    browserVersion, connectVersion, agent, client, confirmSave, experimental, signal = undefined }) {
    if (experimental !== true || typeof confirmSave !== 'function' || signal !== undefined && !(signal instanceof AbortSignal))
        throw fail('X_EDGE_MAC_FLOW_INVALID');
    // The current transferable format replays connect version 1. Never
    // silently downgrade an observed version 2 handshake into that format.
    if (connectVersion !== '1') throw fail('X_EDGE_MAC_FLOW_PROTOCOL_UNSUPPORTED');
    function check() { if (signal?.aborted) throw fail('X_EDGE_MAC_FLOW_CANCELLED'); }
    const allocated = [];
    function decode(value, size) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(size * 4 / 3))
            throw fail('X_EDGE_MAC_FLOW_INVALID');
        const bytes = Buffer.from(value, 'base64url'); allocated.push(bytes);
        if (bytes.length !== size || bytes.toString('base64url') !== value) throw fail('X_EDGE_MAC_FLOW_INVALID');
        return bytes;
    }
    let data;
    try {
        check();
        exact(subscription, ['scope', 'endpoint', 'keys', 'applicationServerKey']);
        exact(subscription.keys, ['p256dh', 'auth']);
        if (subscription.scope !== 'https://x.com/' || typeof subscription.endpoint !== 'string') throw fail('X_EDGE_MAC_FLOW_INVALID');
        const expected = { endpoint: subscription.endpoint, publicKey: decode(subscription.keys.p256dh, 65),
            auth: decode(subscription.keys.auth, 16), applicationServerKey: decode(subscription.applicationServerKey, 65) };
        data = await withMacEdgeSnapshot({ rootPath, profileId, helperPath, expectedSha256, work: async snapshot => {
            check(); if (snapshot.signal.aborted) throw fail('X_EDGE_MAC_FLOW_CANCELLED');
            const result = await readEdgeSnapshot({ ...snapshot, expected, browserVersion, agent, client,
                dbFactory: directory => new ClassicLevel(directory, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }) });
            check(); if (snapshot.signal.aborted) throw fail('X_EDGE_MAC_FLOW_CANCELLED');
            return result;
        } });
    } finally { for (const value of allocated) value.fill(0); }
    check();
    if (!data || !Number.isInteger(data.otherSubscriptionCount) || data.otherSubscriptionCount < 0 || data.otherSubscriptionCount > 127
        || !Number.isInteger(data.unclassifiedRecordCount) || data.unclassifiedRecordCount < 0 || data.unclassifiedRecordCount > 127
        || typeof data.otherNotificationsPossible !== 'boolean'
        || data.otherNotificationsPossible !== (data.otherSubscriptionCount > 0 || data.unclassifiedRecordCount > 0))
        throw fail('X_EDGE_MAC_FLOW_INVALID');
    const choice = await confirmSave({ otherSubscriptionCount: data.otherSubscriptionCount,
        unclassifiedRecordCount: data.unclassifiedRecordCount, otherNotificationsPossible: data.otherNotificationsPossible });
    check();
    if (choice === null) return { state: 'cancelled' };
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.getPrototypeOf(choice) !== Object.prototype
        || Object.keys(choice).sort().join(',') !== 'confirmed,directory,filename,otherSitesConsent'
        || choice.confirmed !== true || typeof choice.otherSitesConsent !== 'boolean'
        || data.otherNotificationsPossible && !choice.otherSitesConsent) throw fail('X_EDGE_MAC_FLOW_CONFIRMATION_REQUIRED');
    const output = await writeExperimentalMacEdgeExport({ directory: choice.directory, filename: choice.filename, file: data.file,
        confirmed: true, otherSubscriptionCount: data.otherSubscriptionCount, unclassifiedRecordCount: data.unclassifiedRecordCount,
        otherNotificationsPossible: data.otherNotificationsPossible, otherSitesConsent: choice.otherSitesConsent, experimental: true, signal });
    return { state: 'saved', ...output };
}
module.exports = { exportExperimentalMacEdgeNotifications };
