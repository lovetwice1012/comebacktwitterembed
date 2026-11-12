'use strict';

// Experimental local output only. Server intake still rejects this format;
// this must not be wired into a distributed app before native verification.
const { normalizeChromeTransfer } = require('./chrome-x-transfer');
const { publishMacPrivateFile } = require('./mac-private-export');
const fail = code => Object.assign(new Error(code), { code });

async function writeExperimentalMacBraveExport({ directory, filename, file, confirmed, otherSubscriptionCount, otherSitesConsent, experimental, signal }) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || experimental !== true || confirmed !== true
        || !Number.isInteger(otherSubscriptionCount) || otherSubscriptionCount < 0 || otherSubscriptionCount > 63
        || typeof otherSitesConsent !== 'boolean' || otherSubscriptionCount > 0 && !otherSitesConsent
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_BRAVE_MAC_EXPORT_INVALID');
    if (signal?.aborted) throw fail('X_BRAVE_MAC_EXPORT_CANCELLED');
    let normalized;
    try { normalized = normalizeChromeTransfer(file, { allowMac: true, allowBraveMac: true }); }
    catch { throw fail('X_BRAVE_MAC_EXPORT_INVALID'); }
    if (normalized.provenance.kind !== 'brave-gcm' || normalized.push.productCategory !== 'com.brave.macosx')
        throw fail('X_BRAVE_MAC_EXPORT_INVALID');
    const body = Buffer.from(JSON.stringify(normalized), 'utf8');
    try { return await publishMacPrivateFile({ directory, filename, body, signal, errorPrefix: 'X_BRAVE_MAC_EXPORT' }); }
    finally { body.fill(0); }
}
module.exports = { writeExperimentalMacBraveExport };
