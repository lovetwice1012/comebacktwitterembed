'use strict';

// Entry point for a future signed macOS distribution. It uses the installed
// Chrome and only prepares a local file for the user to upload manually.
// The package builder must provide and validate the bundled native helper.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseUniqueJson } = require('../src/automation/strict-json');
const { createMacChromeDialogs } = require('../src/automation/chrome-mac-dialogs');
const { runMacChromeApp } = require('../src/automation/chrome-mac-app');

async function main() {
    const ui = createMacChromeDialogs();
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
            || manifest.packageId !== 'x-notification-mac-chrome-setup' || manifest.version !== '0.1.0-mac-preview.1'
            || typeof manifest.lockSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.lockSha256)) throw new Error('invalid manifest');
        const home = await fs.realpath(os.homedir());
        const result = await runMacChromeApp({ applicationSupport: path.join(home, 'Library', 'Application Support'),
            helperPath: path.join(__dirname, 'MacStoreLock'), expectedSha256: manifest.lockSha256, ui });
        if (result.state === 'saved') await ui.showSaved();
    } catch (error) {
        await ui.showError(typeof error?.code === 'string' ? error.code : 'X_CHROME_MAC_APP_INVALID');
        process.exitCode = 1;
    }
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
