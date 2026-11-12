'use strict';
// Disposable hosted fixture. No application entry point imports this script.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getOrCreateMacEdgeProfile } = require('../../src/automation/chrome-mac-profile-registry');
const { rotateMacEdgeProfile } = require('../../src/automation/edge-mac-profile-rotation');
(async () => {
    const [addonPath, base, mode] = process.argv.slice(2), temp = await fs.realpath(os.tmpdir());
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || process.env.CBTE_MAC_FLOCK_RESEARCH !== '1' || !path.isAbsolute(addonPath || '') || path.dirname(base || '') !== temp
        || !/^cbte-flock-rotation-/.test(path.basename(base || '')) || !['hold', 'rotate'].includes(mode)) throw new Error('invalid fixture');
    const stat = await fs.lstat(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
        || await fs.realpath(base) !== base) throw new Error('invalid fixture');
    const addon = require(addonPath), v2 = process.env.CBTE_MAC_FLOCK_V2 === '1';
    const result = addon.acquire(v2 ? base : path.join(base, 'session.lock'));
    if (result === 'BUSY') { process.stdout.write('BUSY'); return; }
    if (result !== 'OK') throw new Error('fixture lock failed');
    try {
        if (v2 && addon.begin() !== 'OK') throw new Error('fixture guard failed');
        const old = await getOrCreateMacEdgeProfile(base);
        if (mode === 'hold') {
            process.stdout.write('READY');
            await new Promise(resolve => { process.stdin.once('data', resolve); process.stdin.once('end', resolve); process.stdin.resume(); });
        } else {
            await rotateMacEdgeProfile({ directory: base, oldProfile: old, confirmed: true });
            process.stdout.write('ROTATED');
        }
    } finally {
        if (v2 && addon.end() !== 'OK') throw new Error('fixture guard cleanup failed');
        if (addon.release() !== 'OK') throw new Error('fixture lock cleanup failed');
    }
})().catch(() => { process.exitCode = 1; });
