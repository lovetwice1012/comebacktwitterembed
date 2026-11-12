'use strict';

// Test-only aggregate observation. Never retain or return frame bytes, IDs,
// channels or payloads. An NFY count is not proof that a message was stored.
function countNotifications(transport) {
    let count = 0;
    return {
        transport: { ...transport, async next(...args) {
            const frame = await transport.next(...args);
            if (Buffer.isBuffer(frame) && frame.length >= 4 && frame.subarray(0, 4).equals(Buffer.from('NFY '))) count = Math.min(999, count + 1);
            return frame;
        } },
        getCount: () => count,
    };
}
function batchTimeoutState(mask, frames) {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7 || !Number.isInteger(frames) || frames < 0 || frames > 999) throw new Error('PROBE_OBSERVATION_INVALID');
    return `batch-timeout-${mask}-nfys-${frames}`;
}
function batchTimeoutCode(state) {
    if (typeof state !== 'string') return null;
    const match = /^batch-timeout-([0-7])-nfys-(0|[1-9][0-9]{0,2})$/.exec(state);
    return match ? `PROBE_BATCH_TIMEOUT_${match[1]}_NFYS_${match[2]}` : null;
}
module.exports = { countNotifications, batchTimeoutState, batchTimeoutCode };
