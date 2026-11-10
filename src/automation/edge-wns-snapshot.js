'use strict';

// Pure converter for an already isolated Edge snapshot. It does not read a
// profile, launch a browser, create a file, or transmit any data.
const { selectXRecord, selectDeviceRecord, countOtherSiteRecords, clearRecord } = require('./edge-wns-record');
const { normalizeEdgeTransfer } = require('./edge-wns-transfer');
const invalid = () => Object.assign(new Error('X_EDGE_WNS_SNAPSHOT_INVALID'), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' });
async function buildEdgeTransfer({ siteRecords, deviceRecord, expected, browserVersion, agent, client }) {
    let selected, device;
    try {
        const otherSubscriptionCount = countOtherSiteRecords(siteRecords);
        selected = selectXRecord(siteRecords, expected);
        device = selectDeviceRecord(deviceRecord);
        const pub = selected.publicKey;
        const file = normalizeEdgeTransfer({ format: 'x-notification-subscription', version: 3,
            provenance: { kind: 'edge-wns', adapterVersion: '1.0.0', browserVersion, readMethod: 'edge-wns-snapshot' },
            push: { scope: 'https://x.com/', siteChannel: selected.channel.toString('ascii'), deviceKey: device.deviceKey.toString('base64url'),
                reconnectToken: device.reconnectToken.toString('ascii'), agent, client, p256dhPublicKey: pub.toString('base64url'),
                authenticationSecret: selected.auth.toString('base64url'), p256dhPrivateKey: { kty: 'EC', crv: 'P-256',
                    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url'), d: selected.privateKey.toString('base64url') },
                applicationServerKey: selected.applicationServerKey.toString('base64url') } });
        return { file, otherSubscriptionCount };
    } catch { throw invalid(); }
    finally { clearRecord(selected); device?.deviceKey.fill(0); device?.reconnectToken.fill(0); }
}
module.exports = { buildEdgeTransfer };
