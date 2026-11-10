'use strict';
// Research-only: read fixed product bytes from this one installed Edge build.
// Never persist, log, transmit or include them in a distribution package.
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const FILE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\157.0.4341.42\\msedge.dll';
const HASH = '9f3773d5f287cdb958e08ef0aeaaa44280dcd150ceacF8327ff17475ba38f20b'.toLowerCase();
async function readSyntheticProductConstants() {
    const handle = await fs.open(FILE, 'r');
    let key, id;
    try {
        const before = await handle.stat(), hash = createHash('sha256');
        if (!before.isFile() || before.size !== 357748040) throw new Error('PROBE_EDGE_VERSION_UNSUPPORTED');
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
        if (hash.digest('hex') !== HASH) throw new Error('PROBE_EDGE_VERSION_UNSUPPORTED');
        key = Buffer.alloc(16); id = Buffer.alloc(16);
        const first = await handle.read(key, 0, 16, 0x128e33f0), second = await handle.read(id, 0, 16, 0x128e31a0);
        const after = await handle.stat();
        if (first.bytesRead !== 16 || second.bytesRead !== 16 || before.size !== after.size || before.mtimeMs !== after.mtimeMs
            || [...key, ...id].some(byte => byte < 0x21 || byte > 0x7e)) throw new Error('PROBE_EDGE_VERSION_UNSUPPORTED');
        return { key, id };
    } catch (error) { key?.fill(0); id?.fill(0); throw error; }
    finally { await handle.close(); }
}
module.exports = { readSyntheticProductConstants };
