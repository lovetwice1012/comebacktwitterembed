'use strict';

// CI-only diagnostics for public installed application metadata. Never inspect
// browser profiles, Keychain entries, subscriptions, or notification data.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function describeInstalledChrome(t, label) {
    const app = '/Applications/Google Chrome.app';
    const framework = path.join(app, 'Contents/Frameworks/Google Chrome Framework.framework/Versions');
    try {
        const versions = (await fs.readdir(framework)).sort();
        const current = await fs.readlink(path.join(framework, 'Current'));
        let hash = 'unavailable';
        try { const seal = await fs.readFile(path.join(framework, 'Current/_CodeSignature/CodeResources')); hash = createHash('sha256').update(seal).digest('hex'); }
        catch { /* Some releases put the signature elsewhere. */ }
        t.diagnostic(`${label} framework versions=${JSON.stringify(versions)} current=${current} resourceSealSha256=${hash}`);
        return { current, hash };
    } catch (error) { t.diagnostic(`${label} framework metadata unavailable: ${error?.code || 'unknown'}`); return null; }
}
module.exports = { describeInstalledChrome };
