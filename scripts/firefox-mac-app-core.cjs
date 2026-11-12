'use strict';

// Shared local flow for the experimental and unpublished candidate entries.
// Files are saved locally; the user uploads them from the registration screen.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseUniqueJson } = require('../src/automation/strict-json');
const { createExperimentalMacFirefoxDialogs } = require('../src/automation/firefox-mac-dialogs');
const { runExperimentalMacFirefoxApp } = require('../src/automation/firefox-mac-app');

async function main() {
    const ui = createExperimentalMacFirefoxDialogs({ experimental: true });
    try {
        const filename = path.join(__dirname, 'MacSetup-manifest.json');
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        let manifest;
        try {
            const stat = await handle.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error();
            const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
            while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
            if (offset !== stat.size) throw new Error();
            manifest = parseUniqueJson(bytes.subarray(0, offset).toString('utf8'), 8);
        } finally { await handle.close(); }
        if (!manifest || Object.keys(manifest).sort().join(',') !== 'bootstrapSha256,lockSha256,packageId,readerSha256,version'
            || manifest.packageId !== 'x-notification-mac-firefox-setup' || manifest.version !== '0.1.0-mac-firefox-preview.1'
            || [manifest.lockSha256, manifest.bootstrapSha256, manifest.readerSha256].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) throw new Error();
        const home = await fs.realpath(os.homedir());
        const result = await runExperimentalMacFirefoxApp({ applicationSupport: path.join(home, 'Library', 'Application Support'),
            helperPath: path.join(__dirname, '..', 'MacOS', 'MacStoreLock'), expectedSha256: manifest.lockSha256,
            bootstrapPath: path.join(__dirname, 'FirefoxXPCShellReader.js'), bootstrapSha256: manifest.bootstrapSha256,
            readerPath: path.join(__dirname, 'Read-PushSubscription.js'), readerSha256: manifest.readerSha256, ui, experimental: true });
        if (result.state === 'saved') await ui.showSaved();
    } catch (error) {
        await ui.showError(typeof error?.code === 'string' ? error.code : 'X_FIREFOX_MAC_APP_INVALID'); process.exitCode = 1;
    }
}
module.exports = { main };
