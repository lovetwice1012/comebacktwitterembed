'use strict';

// Hosted Windows CI only: read the exact immutable preview ZIP built in this
// run. This helper never accepts a user-provided output path or publishes it.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const NAME = 'cbte-edge-preview-16.zip';
const SHA256 = '90e38fb2c879b0748cd5a3a9ab2a4f048836ad92c549358ded87253a800afbb4';
const SIZE = 35994476;

async function readPinnedHostedArchive() {
    if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true'
        || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.NODE_ENV !== 'test')
        throw new Error('PROBE_PACKAGE_HOST_INVALID');
    const temp = process.env.RUNNER_TEMP;
    if (typeof temp !== 'string' || !path.isAbsolute(temp)) throw new Error('PROBE_PACKAGE_HOST_INVALID');
    const parent = await fs.realpath(temp), filename = path.join(parent, NAME);
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== SIZE || before.nlink !== 1)
        throw new Error('PROBE_PACKAGE_INVALID');
    const handle = await fs.open(filename, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== SIZE || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1)
            throw new Error('PROBE_PACKAGE_INVALID');
        const bytes = await handle.readFile();
        if (bytes.length !== SIZE || createHash('sha256').update(bytes).digest('hex') !== SHA256)
            throw new Error('PROBE_PACKAGE_INVALID');
        return bytes;
    } finally { await handle.close(); }
}
module.exports = { readPinnedHostedArchive, NAME, SHA256, SIZE };
