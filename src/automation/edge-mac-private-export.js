'use strict';

// Experimental local output only. No app or server route may expose this
// until Mac Edge storage, protocol and process lifecycle are verified.
const { normalizeEdgeTransfer } = require('./edge-wns-transfer');
const { publishMacPrivateFile } = require('./mac-private-export');
const fail = code => Object.assign(new Error(code), { code });

async function writeExperimentalMacEdgeExport({ directory, filename, file, confirmed, otherSubscriptionCount,
    unclassifiedRecordCount, otherNotificationsPossible, otherSitesConsent, experimental, signal }) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || experimental !== true || confirmed !== true
        || !Number.isInteger(otherSubscriptionCount) || otherSubscriptionCount < 0 || otherSubscriptionCount > 127
        || !Number.isInteger(unclassifiedRecordCount) || unclassifiedRecordCount < 0 || unclassifiedRecordCount > 127
        || typeof otherNotificationsPossible !== 'boolean'
        || otherNotificationsPossible !== (otherSubscriptionCount > 0 || unclassifiedRecordCount > 0)
        || typeof otherSitesConsent !== 'boolean' || otherNotificationsPossible && !otherSitesConsent
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_EDGE_MAC_EXPORT_INVALID');
    if (signal?.aborted) throw fail('X_EDGE_MAC_EXPORT_CANCELLED');
    let normalized;
    try { normalized = normalizeEdgeTransfer(file); } catch { throw fail('X_EDGE_MAC_EXPORT_INVALID'); }
    const body = Buffer.from(JSON.stringify(normalized), 'utf8');
    try { return await publishMacPrivateFile({ directory, filename, body, signal, errorPrefix: 'X_EDGE_MAC_EXPORT' }); }
    finally { body.fill(0); }
}
module.exports = { writeExperimentalMacEdgeExport };
