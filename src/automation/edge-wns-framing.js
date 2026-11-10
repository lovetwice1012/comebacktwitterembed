'use strict';

// WNS transport framing only. Authentication, ownership, decryption, ACKs and
// socket creation belong to the receiver; this module performs none of them.
const MAX_HEADER = 512;
const MAX_PAYLOAD = 256 * 1024;
const MAX_CHUNK = MAX_HEADER + 2 + MAX_PAYLOAD;
const MAX_FRAMES_PER_CHUNK = 1024;
const fail = () => Object.assign(new Error('X_EDGE_WNS_FRAME_INVALID'), { code: 'X_EDGE_WNS_FRAME_INVALID' });

function createFrameDecoder({ maxPayload = MAX_PAYLOAD } = {}) {
    if (!Number.isSafeInteger(maxPayload) || maxPayload < 0 || maxPayload > MAX_PAYLOAD) throw fail();
    const header = Buffer.alloc(MAX_HEADER); let headerLength = 0, sawCr = false;
    let payload = null, payloadLength = 0, payloadPosition = 0, failed = false, finished = false;
    function clear() { header.fill(0); payload?.fill(0); payload = null; headerLength = 0; payloadLength = 0; payloadPosition = 0; sawCr = false; }
    function emit(frames) {
        const frame = Buffer.allocUnsafe(headerLength + 2 + payloadLength);
        header.copy(frame, 0, 0, headerLength); frame[headerLength] = 13; frame[headerLength + 1] = 10;
        if (payloadLength) payload.copy(frame, headerLength + 2);
        frames.push(frame); clear();
        if (frames.length > MAX_FRAMES_PER_CHUNK) throw fail();
    }
    function push(chunk) {
        if (failed || finished) throw fail();
        if (!Buffer.isBuffer(chunk) || chunk.length > MAX_CHUNK) { clear(); failed = true; throw fail(); }
        const frames = [];
        try {
            for (let i = 0; i < chunk.length; i++) {
                if (payload !== null) {
                    const count = Math.min(payloadLength - payloadPosition, chunk.length - i);
                    chunk.copy(payload, payloadPosition, i, i + count); payloadPosition += count; i += count - 1;
                    if (payloadPosition === payloadLength) emit(frames);
                    continue;
                }
                const byte = chunk[i];
                if (sawCr) {
                    if (byte !== 10) throw fail();
                    const line = header.subarray(0, headerLength).toString('ascii');
                    // Keep framing independent of command-specific semantics.
                    // A command line has printable tokens and a final size.
                    if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)* [0-9]{1,6}$/.test(line)) throw fail();
                    const size = Number(line.slice(line.lastIndexOf(' ') + 1));
                    if (size > maxPayload) throw fail();
                    payloadLength = size; payloadPosition = 0; sawCr = false;
                    if (!size) emit(frames); else payload = Buffer.alloc(size);
                } else if (byte === 13) sawCr = true;
                else {
                    if (byte < 0x20 || byte > 0x7e || headerLength >= MAX_HEADER) throw fail();
                    header[headerLength++] = byte;
                }
            }
            return frames;
        } catch (error) {
            for (const frame of frames) frame.fill(0);
            clear(); failed = true; throw error;
        }
    }
    function finish() {
        if (failed || finished || headerLength || sawCr || payload !== null) { clear(); failed = true; throw fail(); }
        clear(); finished = true;
    }
    return Object.freeze({ push, finish });
}
module.exports = { createFrameDecoder, MAX_HEADER, MAX_PAYLOAD, MAX_CHUNK };
