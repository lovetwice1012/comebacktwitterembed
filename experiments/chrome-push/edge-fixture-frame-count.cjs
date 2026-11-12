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
// Independent, test-only framing observer. It records command headers until
// CRLF, then skips the specified body length without copying any payload.
// Invalid observations fail closed and never affect the real transport.
function createWireCounter() {
    const header = Buffer.alloc(512); let used = 0, left = 0, pending = false, cr = false, invalid = false, count = 0;
    function complete() { if (pending) count = Math.min(999, count + 1); pending = false; }
    function feed(chunk) {
        if (invalid) return;
        if (!Buffer.isBuffer(chunk)) { invalid = true; return; }
        for (const byte of chunk) {
            if (left > 0) { if (--left === 0) complete(); continue; }
            if (cr) {
                if (byte !== 10) { invalid = true; break; }
                const line = header.subarray(0, used).toString('ascii');
                const parsed = /^([\x21-\x7e]+)(?: [\x21-\x7e]+)* ([0-9]{1,6})$/.exec(line);
                header.fill(0); used = 0; cr = false;
                if (!parsed || Number(parsed[2]) > 256 * 1024) { invalid = true; break; }
                left = Number(parsed[2]); pending = parsed[1] === 'NFY'; if (!left) complete();
            } else if (byte === 13) cr = true;
            else if (byte < 0x20 || byte > 0x7e || used >= header.length) { invalid = true; break; }
            else header[used++] = byte;
        }
        if (invalid) { header.fill(0); used = 0; left = 0; pending = false; }
    }
    return Object.freeze({ feed, result: () => invalid ? 'invalid' : count });
}
function batchTimeoutState(mask, frames, wire) {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7 || !Number.isInteger(frames) || frames < 0 || frames > 999
        || wire !== 'invalid' && (!Number.isInteger(wire) || wire < 0 || wire > 999)) throw new Error('PROBE_OBSERVATION_INVALID');
    return `batch-timeout-${mask}-nfys-${frames}-wire-${wire}`;
}
function batchTimeoutCode(state) {
    if (typeof state !== 'string') return null;
    const match = /^batch-timeout-([0-7])-nfys-(0|[1-9][0-9]{0,2})-wire-(invalid|0|[1-9][0-9]{0,2})$/.exec(state);
    return match ? `PROBE_BATCH_TIMEOUT_${match[1]}_NFYS_${match[2]}_WIRE_${match[3].toUpperCase()}` : null;
}
module.exports = { countNotifications, createWireCounter, batchTimeoutState, batchTimeoutCode };
