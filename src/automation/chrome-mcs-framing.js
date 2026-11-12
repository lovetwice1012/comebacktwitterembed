'use strict';

// MCS framing only. This module deliberately does not connect, decode message
// contents, acknowledge messages, or read any browser profile data.
// Chromium connection_handler_impl.cc uses version 41, one-byte message tags,
// and protobuf varint32 lengths; the version is sent only at login.
const VERSION = 41;
const DEFAULT_MAX_FRAME = 64 * 1024;
const MAX_FRAMES_PER_CHUNK = 1024;
const fault = () => Object.assign(new Error('X_CHROME_MCS_FRAME_INVALID'), { code: 'X_CHROME_MCS_FRAME_INVALID' });

function encodeLength(size) {
    const result = [];
    do {
        let byte = size % 128;
        size = Math.floor(size / 128);
        if (size) byte |= 0x80;
        result.push(byte);
    } while (size);
    return Buffer.from(result);
}

function encodeFrame(tag, payload, { first = false, maxFrame = DEFAULT_MAX_FRAME } = {}) {
    if (!Number.isInteger(tag) || tag < 0 || tag > 15 || !Buffer.isBuffer(payload)
        || !Number.isInteger(maxFrame) || maxFrame < 0 || maxFrame > DEFAULT_MAX_FRAME
        || payload.length > maxFrame || typeof first !== 'boolean') throw fault();
    return Buffer.concat([first ? Buffer.from([VERSION, tag]) : Buffer.from([tag]), encodeLength(payload.length), payload]);
}

function createFrameDecoder({ maxFrame = DEFAULT_MAX_FRAME, captureCompleteOnError = false } = {}) {
    if (!Number.isInteger(maxFrame) || maxFrame < 0 || maxFrame > DEFAULT_MAX_FRAME || typeof captureCompleteOnError !== 'boolean') throw fault();
    let state = 'version', tag, size = 0, shift = 0, count = 0, payload, position = 0, failed = false, completedOnError = [];
    function clearPartial() { payload?.fill(0); payload = undefined; }
    function discard() { clearPartial(); for (const frame of completedOnError) frame.payload.fill(0); completedOnError = []; failed = true; }
    function push(chunk) {
        if (failed) throw fault();
        if (!Buffer.isBuffer(chunk)) { discard(); throw fault(); }
        const frames = [];
        try {
            for (let i = 0; i < chunk.length; i++) {
                const byte = chunk[i];
                if (state === 'version') {
                    // Chromium accepts legacy 38 and versions at least 41.
                    if (byte !== 38 && byte < VERSION) throw fault();
                    state = 'tag';
                } else if (state === 'tag') {
                    if (byte > 15) throw fault();
                    tag = byte; size = 0; shift = 0; count = 0; state = 'size';
                } else if (state === 'size') {
                    count++;
                    if (count > 5 || (count === 5 && (byte & 0xf0))) throw fault();
                    size += (byte & 0x7f) * 2 ** shift;
                    shift += 7;
                    if (size > maxFrame) throw fault();
                    if (!(byte & 0x80)) {
                        if (count > 1 && byte === 0) throw fault(); // reject non-canonical lengths
                        payload = Buffer.alloc(size); position = 0;
                        if (size === 0) { frames.push({ tag, payload }); payload = undefined; state = 'tag'; }
                        else state = 'payload';
                    }
                } else {
                    const n = Math.min(size - position, chunk.length - i);
                    chunk.copy(payload, position, i, i + n); position += n; i += n - 1;
                    if (position === size) { frames.push({ tag, payload }); payload = undefined; state = 'tag'; }
                }
                if (frames.length > MAX_FRAMES_PER_CHUNK) throw fault();
            }
            return frames;
        } catch (error) {
            if (captureCompleteOnError) completedOnError = frames.splice(0, MAX_FRAMES_PER_CHUNK);
            for (const frame of frames) frame.payload.fill(0);
            clearPartial(); failed = true; throw error;
        }
    }
    function finish() {
        if (failed || state !== 'tag') { discard(); throw fault(); }
    }
    function takeCompletedOnError() { const frames = completedOnError; completedOnError = []; return frames; }
    return { push, finish, discard, takeCompletedOnError };
}

module.exports = { createFrameDecoder, encodeFrame, VERSION, DEFAULT_MAX_FRAME };
