'use strict';
// Research-only hash binding. OS signature verification is performed separately.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseUniqueJson } = require('../../src/automation/strict-json');
const fail = () => Object.assign(new Error('RESEARCH_MANIFEST_INVALID'), { code: 'RESEARCH_MANIFEST_INVALID' });
function parseManifest(text) {
    try { const value = parseUniqueJson(text, 4);
        if (!value || Object.keys(value).sort().join(',') !== 'addonSha256,kind' || value.kind !== 'mac-edge-lock-research-v1'
            || typeof value.addonSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.addonSha256)) throw fail();
        return value;
    } catch { throw fail(); }
}
async function verifyResearchAddon({ file, manifest }) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !manifest || !/^[a-f0-9]{64}$/.test(manifest.addonSha256 || '')) throw fail();
    let handle, bytes;
    try {
        if (await fs.realpath(file) !== file) throw fail();
        const before = await fs.lstat(file); handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!before.isFile() || before.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino || info.nlink !== 1
            || ![0, process.getuid()].includes(info.uid) || (info.mode & 0o022) || info.size < 1 || info.size > 4 * 1024 * 1024) throw fail();
        bytes = await handle.readFile(); const after = await handle.stat(), named = await fs.lstat(file);
        if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || named.isSymbolicLink()
            || named.dev !== info.dev || named.ino !== info.ino || createHash('sha256').update(bytes).digest('hex') !== manifest.addonSha256) throw fail();
    } catch { throw fail(); }
    finally { bytes?.fill(0); try { await handle?.close(); } catch {
        // eslint-disable-next-line no-unsafe-finally
        throw fail();
    } }
}
module.exports = { parseManifest, verifyResearchAddon };
