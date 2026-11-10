'use strict';

// Bridge between the MCS session and the existing fenced inbox.
// Receipt ciphertext and replay IDs are persisted atomically by recordMcsFrame.
// Authorization must be checked inside each store transaction, not at startup.
function createChromeMcsStoreAdapter({ store, lease, authorize, decrypt }) {
    if (!store || typeof store.pendingMcs !== 'function' || typeof store.recordMcsFrame !== 'function'
        || typeof store.confirmMcs !== 'function' || !lease || typeof authorize !== 'function' || typeof decrypt !== 'function')
        throw Object.assign(new Error('X_CHROME_STORE_CONFIG_INVALID'), { code: 'X_CHROME_STORE_CONFIG_INVALID' });
    return {
        pending: () => store.pendingMcs(lease, { authorize }),
        confirm: ids => store.confirmMcs(lease, ids, { authorize }),
        commit: async message => {
            if (!message?.encrypted || !Buffer.isBuffer(message.encrypted.data) || typeof message.persistentId !== 'string')
                throw Object.assign(new Error('X_CHROME_STORE_FRAME_INVALID'), { code: 'X_CHROME_STORE_FRAME_INVALID' });
            const frame = { version: message.persistentId, data: message.encrypted.data.toString('base64url'),
                headers: message.encrypted.headers, status: 'received', ackCode: 100 };
            try { await decrypt(frame); } catch { frame.status = 'decryption_failed'; frame.ackCode = 101; }
            return store.recordMcsFrame(lease, frame, { authorize });
        },
    };
}
module.exports = { createChromeMcsStoreAdapter };
