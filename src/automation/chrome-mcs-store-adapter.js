'use strict';

// Bridge between the MCS session and the existing fenced inbox.
// Receipt ciphertext and replay IDs are persisted atomically by recordMcsFrame.
// Authorization must be checked inside each store transaction, not at startup.
function createChromeMcsStoreAdapter({ store, lease, authorize, decrypt }) {
    if (!store || typeof store.pendingMcs !== 'function' || typeof store.recordMcsFrame !== 'function'
        || typeof store.confirmMcs !== 'function' || typeof store.recordMcsControl !== 'function' || !lease || typeof authorize !== 'function' || typeof decrypt !== 'function')
        throw Object.assign(new Error('X_CHROME_STORE_CONFIG_INVALID'), { code: 'X_CHROME_STORE_CONFIG_INVALID' });
    async function persist(message, recovery) {
        if (!message?.encrypted || !Buffer.isBuffer(message.encrypted.data) || typeof message.persistentId !== 'string')
            throw Object.assign(new Error('X_CHROME_STORE_FRAME_INVALID'), { code: 'X_CHROME_STORE_FRAME_INVALID' });
        const frame = { version: message.persistentId, data: message.encrypted.data.toString('base64url'),
            headers: message.encrypted.headers, status: 'received', ackCode: 100 };
        try { await decrypt(frame); } catch { frame.status = 'decryption_failed'; frame.ackCode = 101; }
        if (recovery && typeof store.recordMcsRecoveryFrame !== 'function')
            throw Object.assign(new Error('X_CHROME_STORE_RECOVERY_UNAVAILABLE'), { code: 'X_CHROME_STORE_RECOVERY_UNAVAILABLE' });
        return recovery ? store.recordMcsRecoveryFrame(lease, frame, { authorize }) : store.recordMcsFrame(lease, frame, { authorize });
    }
    return {
        pending: () => store.pendingMcs(lease, { authorize }),
        confirm: ids => store.confirmMcs(lease, ids, { authorize }),
        control: message => store.recordMcsControl(lease, { kind: message.control, persistentId: message.persistentId }, { authorize }),
        recoverControl: message => {
            if (typeof store.recordMcsRecoveryControl !== 'function') throw Object.assign(new Error('X_CHROME_STORE_RECOVERY_UNAVAILABLE'), { code: 'X_CHROME_STORE_RECOVERY_UNAVAILABLE' });
            return store.recordMcsRecoveryControl(lease, { kind: message.control, persistentId: message.persistentId }, { authorize });
        },
        commit: message => persist(message, false),
        recover: message => persist(message, true),
    };
}
module.exports = { createChromeMcsStoreAdapter };
