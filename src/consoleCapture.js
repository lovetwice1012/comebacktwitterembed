'use strict';

const MAX_BUFFER_CHARS = 200000;
const TRUNCATION_MARKER = '\n[consoleCapture] Older buffered output was truncated.\n';

function shouldBuffer(value) {
    const text = String(value ?? '');
    return !text.startsWith('[dashboard] ') && !text.startsWith('[consoleFlush] ');
}

function append(consoleBuffer, value) {
    if (!consoleBuffer || !shouldBuffer(value)) return false;

    consoleBuffer.text = String(consoleBuffer.text || '') + String(value ?? '');
    if (consoleBuffer.text.length > MAX_BUFFER_CHARS) {
        const keep = Math.max(0, MAX_BUFFER_CHARS - TRUNCATION_MARKER.length);
        consoleBuffer.text = TRUNCATION_MARKER + consoleBuffer.text.slice(-keep);
    }
    return true;
}

module.exports = {
    append,
    shouldBuffer,
    _internal: {
        MAX_BUFFER_CHARS,
        TRUNCATION_MARKER,
    },
};
