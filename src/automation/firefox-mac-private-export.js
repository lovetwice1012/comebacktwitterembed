'use strict';

// Local file only. The caller presents the final explanation and obtains the
// user's confirmation, including consent when other sites share this receiver.
const { parseTransferFile } = require('./x-setup-transfer');
const { publishMacPrivateFile } = require('./mac-private-export');
const fail = code => Object.assign(new Error(code), { code });

async function writeMacFirefoxExport({ directory, filename, file, confirmed, otherSubscriptionCount, otherSitesConsent, signal }) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || confirmed !== true
        || !Number.isInteger(otherSubscriptionCount) || otherSubscriptionCount < 0 || otherSubscriptionCount > 63
        || typeof otherSitesConsent !== 'boolean' || otherSubscriptionCount > 0 && !otherSitesConsent
        || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_FIREFOX_MAC_EXPORT_INVALID');
    if (signal?.aborted) throw fail('X_FIREFOX_MAC_EXPORT_CANCELLED');
    let normalized;
    try { normalized = parseTransferFile(JSON.stringify(file)); } catch { throw fail('X_FIREFOX_MAC_EXPORT_INVALID'); }
    if (normalized.version !== 1 || normalized.provenance.kind !== 'firefox-pushdb') throw fail('X_FIREFOX_MAC_EXPORT_INVALID');
    const body = Buffer.from(JSON.stringify(normalized), 'utf8');
    try { return await publishMacPrivateFile({ directory, filename, body, signal, errorPrefix: 'X_FIREFOX_MAC_EXPORT' }); }
    finally { body.fill(0); }
}
module.exports = { writeMacFirefoxExport };
