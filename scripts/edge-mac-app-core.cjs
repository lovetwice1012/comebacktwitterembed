'use strict';

// Candidate-only local flow. The saved file is uploaded by its owner.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseUniqueJson } = require('../src/automation/strict-json');
const { createExperimentalMacEdgeDialogs } = require('../src/automation/edge-mac-dialogs');
const { runExperimentalMacEdgeApp } = require('../src/automation/edge-mac-app');

async function main() {
    const ui = createExperimentalMacEdgeDialogs({ experimental: true });
    try {
        const handle = await fs.open(path.join(__dirname, 'MacSetup-manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let manifest;
        try {
            const stat = await handle.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error();
            const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
            while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
            if (offset !== stat.size) throw new Error();
            manifest = parseUniqueJson(bytes.subarray(0, offset).toString('utf8'), 8);
        } finally { await handle.close(); }
        if (!manifest || Object.keys(manifest).sort().join(',') !== 'identitySha256,lockSha256,packageId,peerSha256,version'
            || manifest.packageId !== 'x-notification-mac-edge-setup' || manifest.version !== '0.1.0-mac-edge-preview.1'
            || [manifest.lockSha256, manifest.identitySha256, manifest.peerSha256].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) throw new Error();
        const home = await fs.realpath(os.homedir()), bin = path.join(__dirname, '..', 'MacOS');
        const result = await runExperimentalMacEdgeApp({ applicationSupport: path.join(home, 'Library', 'Application Support'),
            helperPath: path.join(bin, 'MacStoreLock'), expectedSha256: manifest.lockSha256,
            identityPath: path.join(bin, 'MacEdgeIdentity'), identitySha256: manifest.identitySha256,
            peerPath: path.join(bin, 'MacEdgeSocketOwner'), peerSha256: manifest.peerSha256, ui, experimental: true });
        if (result.state === 'saved') await ui.showSaved();
    } catch (error) {
        await ui.showError(typeof error?.code === 'string' ? error.code : 'X_EDGE_MAC_APP_INVALID'); process.exitCode = 1;
    }
}
module.exports = { main };
