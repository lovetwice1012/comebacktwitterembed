'use strict';

// Hosted-runner-only diagnostics: inspect the fixed installed application,
// never profiles or keychain data; emit only fixed classifications.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const APP = '/Applications/Brave Browser.app';
const EXE = path.join(APP, 'Contents/MacOS/Brave Browser');
const PLIST = path.join(APP, 'Contents/Info.plist');
const FRAMEWORK = path.join(APP, 'Contents/Frameworks/Brave Browser Framework.framework/Versions/Current');
const REQUIREMENT = '=anchor apple generic and identifier "com.brave.Browser" and certificate leaf[subject.OU] = "KL8N8XSYF4"';

async function snapshotBraveInstallation() {
    try {
        const values = [];
        for (const name of [APP, EXE, PLIST]) {
            const stat = await fs.lstat(name);
            values.push([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isSymbolicLink()]);
        }
        try {
            const stat = await fs.lstat(FRAMEWORK);
            values.push([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isSymbolicLink(),
                stat.isSymbolicLink() ? await fs.readlink(FRAMEWORK) : null]);
        } catch { values.push(null); }
        return JSON.stringify(values);
    } catch { return null; }
}
function classifyCodesign(result) {
    if (result?.status === 0) return 'valid';
    if (result?.error?.code === 'ETIMEDOUT') return 'timeout';
    if (Number.isInteger(result?.status)) return 'rejected';
    return 'unavailable';
}
async function diagnoseBraveInstallation(t, baseline) {
    const current = await snapshotBraveInstallation();
    const changed = baseline === null || current === null ? 'unknown' : baseline === current ? 'false' : 'true';
    const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', REQUIREMENT, APP],
        { timeout: 35000, stdio: 'ignore' });
    const version = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', PLIST],
        { timeout: 10000, encoding: 'utf8', maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const versionFormat = version.status === 0 && typeof version.stdout === 'string'
        ? /^[0-9]{1,3}(?:\.[0-9]{1,5}){3}\r?\n?$/.test(version.stdout) ? 'valid' : 'invalid' : 'unknown';
    t.diagnostic(`synthetic Brave installation: metadataChanged=${changed} codesign=${classifyCodesign(signature)} versionFormat=${versionFormat}`);
}
module.exports = { snapshotBraveInstallation, classifyCodesign, diagnoseBraveInstallation };
