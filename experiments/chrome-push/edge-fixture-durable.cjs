'use strict';
// Loopback-only research adapter, not a production WNS receiver. It exercises
// the existing lease-fenced ciphertext inbox without storing foreign payloads.
const { createHash } = require('node:crypto');
const { syntheticRecipientMatches } = require('./edge-fixture-routing.cjs');
const { firstFixtureNotification } = require('./edge-wns-fixture-framing.cjs');
const { syntheticNotificationAck } = require('./edge-fixture-ack.cjs');
const fail = code => Object.assign(new Error(code), { code });

function messageId(frame) {
    const end = frame.indexOf('\r\n'), split = frame.indexOf('\r\n\r\n', end + 2);
    if (end < 0 || split < end || split - end > 8192) throw fail('PROBE_DURABLE_FRAME_INVALID');
    const bytes = frame.subarray(end + 2, split);
    if (bytes.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 0x20 || byte > 0x7e))) throw fail('PROBE_DURABLE_FRAME_INVALID');
    const values = [];
    for (const line of bytes.toString('ascii').split('\r\n')) {
        const colon = line.indexOf(':'); if (colon < 1) throw fail('PROBE_DURABLE_FRAME_INVALID');
        if (line.slice(0, colon).toLowerCase() === 'msg-id') values.push(line.slice(colon + 1).trim());
    }
    if (values.length !== 1 || !/^[\x21-\x7e]{1,256}$/.test(values[0])) throw fail('PROBE_DURABLE_FRAME_INVALID');
    return values[0];
}

function createSyntheticDurableReceiver({ scope, store, lease, channel, authorize, sendAck, beforeAck = async () => {} }) {
    if (typeof scope !== 'string' || !/^http:\/\/(?:localhost|127\.0\.0\.1):[1-9][0-9]{0,4}\/$/.test(scope)
        || !store || typeof store.recordFrame !== 'function' || typeof store.assertLease !== 'function' || !lease || !Buffer.isBuffer(channel) || !channel.length
        || typeof authorize !== 'function' || typeof sendAck !== 'function' || typeof beforeAck !== 'function')
        throw fail('PROBE_DURABLE_CONFIG_INVALID');
    return { async receive(frame, sequence) {
        const target = syntheticRecipientMatches(frame, channel);
        if (!target) {
            await store.assertLease(lease, { authorize });
            const ack = syntheticNotificationAck(frame, sequence);
            try { await sendAck(ack); } finally { ack.fill(0); }
            return { state: 'discarded' };
        }
        const id = messageId(frame), cipher = firstFixtureNotification([frame]);
        if (!cipher) throw fail('PROBE_DURABLE_FRAME_INVALID');
        try {
            const version = createHash('sha256').update('synthetic-wns\0').update(channel).update('\0').update(id, 'ascii').digest('hex');
            const data = cipher.toString('base64url');
            const saved = await store.recordFrame(lease, { version, data, headers: { encoding: 'aes128gcm' }, status: 'received', ackCode: 100 }, { authorize });
            if (saved.version !== version || saved.data !== data || saved.headers?.encoding !== 'aes128gcm') throw fail('PROBE_DURABLE_ID_CONFLICT');
            await beforeAck(saved);
            await store.assertLease(lease, { authorize });
            const ack = syntheticNotificationAck(frame, sequence);
            try { await sendAck(ack); } finally { ack.fill(0); }
            return { state: 'persisted', inboxId: saved.id, duplicate: saved.duplicate };
        } finally { cipher.fill(0); }
    } };
}
module.exports = { createSyntheticDurableReceiver };
