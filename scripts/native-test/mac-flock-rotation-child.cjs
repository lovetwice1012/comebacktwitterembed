'use strict';
// Disposable hosted fixture. No application entry point imports this script.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getOrCreateMacEdgeProfile } = require('../../src/automation/chrome-mac-profile-registry');
const { rotateMacEdgeProfile } = require('../../src/automation/edge-mac-profile-rotation');
const { runProtectedExperiment } = require('./edge-mac-protected-session.cjs');
const { parseManifest, verifyResearchAddon } = require('./edge-mac-manifest-research.cjs');
(async () => {
    const [addonPath, base, mode] = process.argv.slice(2), temp = await fs.realpath(os.tmpdir());
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || process.env.CBTE_MAC_FLOCK_RESEARCH !== '1' || !path.isAbsolute(addonPath || '') || path.dirname(base || '') !== temp
        || !/^cbte-flock-rotation-/.test(path.basename(base || '')) || !['hold', 'rotate'].includes(mode)) throw new Error('invalid fixture');
    const stat = await fs.lstat(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
        || await fs.realpath(base) !== base) throw new Error('invalid fixture');
    const v2 = process.env.CBTE_MAC_FLOCK_V2 === '1';
    if (v2) {
        const manifestPath = process.env.CBTE_MAC_FLOCK_MANIFEST;
        if (!path.isAbsolute(manifestPath || '')) throw new Error('fixture manifest unavailable');
        const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
        await verifyResearchAddon({ file: addonPath, manifest });
    }
    const addon = require(addonPath);
    async function execute() {
        const old = await getOrCreateMacEdgeProfile(base);
        if (mode === 'hold') {
            process.stdout.write('READY');
            await new Promise(resolve => { process.stdin.once('data', resolve); process.stdin.once('end', resolve); process.stdin.resume(); });
        } else {
            await rotateMacEdgeProfile({ directory: base, oldProfile: old, confirmed: true });
            process.stdout.write('ROTATED');
        }
    }
    if (v2) {
        try { await runProtectedExperiment({ base, addon, execute }); }
        catch (error) { if (error?.code === 'RESEARCH_SESSION_BUSY') process.stdout.write('BUSY'); else throw error; }
    } else {
        const result = addon.acquire(path.join(base, 'session.lock'));
        if (result === 'BUSY') { process.stdout.write('BUSY'); return; }
        if (result !== 'OK') throw new Error('fixture lock failed');
        try { await execute(); } finally { if (addon.release() !== 'OK') throw new Error('fixture lock cleanup failed'); }
    }
})().catch(() => { process.exitCode = 1; });
