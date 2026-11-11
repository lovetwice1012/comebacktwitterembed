'use strict';

// Experimental entry point only. A future signed package must supply this
// manifest and native helper. No transfer file is uploaded automatically.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseUniqueJson } = require('../src/automation/strict-json');
const { createMacBraveDialogs } = require('../src/automation/chrome-mac-dialogs');
const { runExperimentalMacBraveApp } = require('../src/automation/brave-mac-app');

async function main() {
    if (process.env.CBTE_EXPERIMENTAL_BRAVE_MAC_LOCAL !== '1') throw new Error('X_BRAVE_MAC_APP_UNAVAILABLE');
    const ui = createMacBraveDialogs();
    try {
        const filename = path.join(__dirname, 'MacSetup-manifest.json');
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        let manifest;
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error('invalid manifest');
            manifest = parseUniqueJson(await handle.readFile('utf8'), 8);
        } finally { await handle.close(); }
        if (!manifest || Object.keys(manifest).sort().join(',') !== 'lockSha256,packageId,version'
            || manifest.packageId !== 'x-notification-mac-brave-setup' || manifest.version !== '0.1.0-mac-brave-preview.1'
            || typeof manifest.lockSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.lockSha256)) throw new Error('invalid manifest');
        const home = await fs.realpath(os.homedir());
        const result = await runExperimentalMacBraveApp({ applicationSupport: path.join(home, 'Library', 'Application Support'),
            helperPath: path.join(__dirname, '..', 'MacOS', 'MacStoreLock'), expectedSha256: manifest.lockSha256, ui, experimental: true });
        if (result.state === 'saved') await ui.showSaved();
    } catch (error) {
        await ui.showError(typeof error?.code === 'string' ? error.code : 'X_BRAVE_MAC_APP_INVALID');
        process.exitCode = 1;
    }
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
