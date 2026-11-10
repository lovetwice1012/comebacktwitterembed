'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildMacChromeBundle, LEVELDB_SHA256 } = require('../build-mac-chrome-setup-bundle.cjs');

test('Mac application bundle is self-contained and pins the universal LevelDB addon', async t => {
    const bundle = await buildMacChromeBundle();
    assert.deepEqual(Object.keys(bundle).sort(), ['MacDependencies-LICENSE.txt', 'MacLevelDB.node', 'MacSetup.cjs']);
    assert.equal(createHash('sha256').update(bundle['MacLevelDB.node']).digest('hex'), LEVELDB_SHA256);
    assert.equal(bundle['MacLevelDB.node'].readUInt32BE(0), 0xcafebabe);
    assert(bundle['MacDependencies-LICENSE.txt'].toString('utf8').includes('classic-level'));
    const parent = await fs.realpath(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'cbte-mac-bundle-test-'));
    t.after(async () => {
        const real = await fs.realpath(temp); assert.equal(path.dirname(real).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(real), /^cbte-mac-bundle-test-/); await fs.rm(real, { recursive: true });
    });
    await fs.writeFile(path.join(temp, 'MacSetup.cjs'), bundle['MacSetup.cjs']);
    // The host's native test addon stands in for the Mach-O addon only for
    // this import smoke test; the returned distribution retains the Mac one.
    const platform = process.platform === 'win32' && process.arch === 'x64' ? 'win32-x64'
        : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64' : null;
    if (!platform) return;
    const pkg = require.resolve('classic-level/package.json');
    await fs.copyFile(path.join(path.dirname(pkg), 'prebuilds', platform, 'classic-level.node'), path.join(temp, 'MacLevelDB.node'));
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const child = spawnSync(process.execPath, ['-e', 'const app = require(process.argv[1]); process.stdout.write(typeof app.main)', path.join(temp, 'MacSetup.cjs')],
        { encoding: 'utf8', env, timeout: 15000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'function');
});
