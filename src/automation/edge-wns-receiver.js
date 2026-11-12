'use strict';

// Receipt handling only. A caller supplies a fenced lease, rollout guard and
// an already-authenticated transport; this module opens no socket or profile.
const { createHash } = require('node:crypto');
const { parseNotification, createAcknowledgement } = require('./edge-wns-notification');
const fail = code => Object.assign(new Error(code), { code });
function createEdgeWnsReceiver({ store, lease, channel, authorize, sendAck }) {
    if (!store || typeof store.recordFrame !== 'function' || typeof store.assertLease !== 'function' || !lease
        || !Buffer.isBuffer(channel) || !channel.length || channel.length > 256 || channel.some(byte => byte < 0x21 || byte > 0x7e)
        || typeof authorize !== 'function' || typeof sendAck !== 'function') throw fail('X_EDGE_WNS_RECEIVER_CONFIG_INVALID');
    const ownChannel = Buffer.from(channel); let busy = false, failed = false, closed = false;
    function ensureOpen() { if (failed || closed) throw fail('X_EDGE_WNS_RECEIVER_STOPPED'); }
    return Object.freeze({
        async receive(frame, sequence, { acknowledge = true } = {}) {
            ensureOpen();
            if (typeof acknowledge !== 'boolean') throw fail('X_EDGE_WNS_RECEIVER_CONFIG_INVALID');
            if (busy) { failed = true; throw fail('X_EDGE_WNS_RECEIVER_BUSY'); }
            busy = true; let parsed, acknowledgement;
            try {
                parsed = parseNotification(frame, ownChannel);
                if (acknowledge) acknowledgement = createAcknowledgement(parsed.acknowledgement, sequence);
                if (parsed.kind === 'foreign') {
                    await store.assertLease(lease, { authorize }); ensureOpen();
                    if (acknowledge) try { await sendAck(acknowledgement); } catch { throw fail('X_EDGE_WNS_ACK_FAILED'); }
                    return { state: 'discarded' };
                }
                const version = createHash('sha256').update('edge-wns\0').update(ownChannel).update('\0')
                    .update(parsed.acknowledgement.messageId, 'ascii').digest('hex');
                const data = parsed.data.toString('base64url');
                // Persist encrypted bytes before ACK and before attempting
                // payload processing. A successor can recover the receipt.
                const saved = await store.recordFrame(lease, { version, data, headers: parsed.headers, status: 'received', ackCode: 100 }, { authorize });
                if (!saved || saved.subscriptionId !== lease.subscriptionId || saved.ownerUserId !== lease.ownerUserId
                    || saved.revision !== lease.revision || saved.version !== version || saved.data !== data
                    || saved.headers?.encoding !== 'aes128gcm') throw fail('X_EDGE_WNS_RECEIPT_CONFLICT');
                await store.assertLease(lease, { authorize }); ensureOpen();
                if (acknowledge) try { await sendAck(acknowledgement); } catch { throw fail('X_EDGE_WNS_ACK_FAILED'); }
                return { state: 'persisted', inboxId: saved.id, duplicate: saved.duplicate };
            } catch (error) { failed = true; throw error; }
            finally { acknowledgement?.fill(0); parsed?.data?.fill(0); busy = false; }
        },
        close() { closed = true; ownChannel.fill(0); },
    });
}
module.exports = { createEdgeWnsReceiver };
