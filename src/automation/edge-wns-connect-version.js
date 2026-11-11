'use strict';

// Builds the explicitly selected handshake version. Existing callers default
// to version 1; version 2 is not enabled by intake. The caller clears the buffer.
const { connectFrame } = require('./edge-wns-protocol');
const fail = () => Object.assign(new Error('X_EDGE_WNS_CONNECT_VERSION_INVALID'), { code: 'X_EDGE_WNS_CONNECT_VERSION_INVALID' });
function connectFrameForVersion(agent, sequence, version) {
    if (version !== '1' && version !== '2') throw fail();
    let frame;
    try {
        frame = connectFrame(agent, sequence);
        const marker = Buffer.from('<connect><ver>1</ver>'), index = frame.indexOf(marker);
        if (index < 0 || frame.indexOf(marker, index + 1) !== -1) throw fail();
        if (version === '2') frame[index + Buffer.byteLength('<connect><ver>')] = 0x32;
        return frame;
    } catch { frame?.fill(0); throw fail(); }
}
module.exports = { connectFrameForVersion };
