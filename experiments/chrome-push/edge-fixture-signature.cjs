'use strict';
// Synthetic fixture adapter; production callers supply their own token Buffer.
const { reconnectSignature } = require('../../src/automation/edge-wns-auth');
function syntheticReconnectSignature(key, token, nonce) {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error('PROBE_SIGNATURE_INPUT_INVALID');
    const bytes = Buffer.from(token, 'ascii');
    try { return reconnectSignature(key, bytes, nonce); }
    catch { throw new Error('PROBE_SIGNATURE_INPUT_INVALID'); }
    finally { bytes.fill(0); }
}
module.exports = { syntheticReconnectSignature };
