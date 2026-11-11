'use strict';

// Experimental frame construction only. This does not change the existing
// receiver or intake. The caller owns the returned buffer and must clear it.
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
