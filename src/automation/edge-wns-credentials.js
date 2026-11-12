'use strict';

const { normalizeEdgeTransfer } = require('./edge-wns-transfer');
const fail = () => Object.assign(new Error('X_EDGE_WNS_CREDENTIALS_INVALID'), { code: 'X_EDGE_WNS_CREDENTIALS_INVALID' });

// Worker-only adapter. Borrowed credential buffers are cleared even when the
// gateway fails or is cancelled. The callback must not retain them afterward.
async function withEdgeWnsCredentials(file, callback) {
    if (typeof callback !== 'function') throw fail();
    let parsed;
    try { parsed = normalizeEdgeTransfer(file); } catch { throw fail(); }
    const p = parsed.push;
    const deviceKey = Buffer.from(p.deviceKey, 'base64url');
    const reconnectToken = Buffer.from(p.reconnectToken, 'ascii');
    const siteChannel = Buffer.from(p.siteChannel, 'ascii');
    try {
        return await callback({ authenticationMode: 'bound', agent: { ...p.agent }, client: { ...p.client },
            deviceKey, reconnectToken, siteChannel, ...(p.connectVersion === '2' ? { connectVersion: '2' } : {}) });
    } finally { deviceKey.fill(0); reconnectToken.fill(0); siteChannel.fill(0); }
}
module.exports = { withEdgeWnsCredentials };
