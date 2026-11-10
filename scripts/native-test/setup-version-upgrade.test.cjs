'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const currentFirefoxBuilder = require('../build-angelic-setup-package.cjs');
const root = path.resolve(__dirname, '../..');

test('new setup packages recognize profiles created by the previous releases', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(temp, 'cbte-setup-upgrade-test-'));
    t.after(async () => {
        const actual = await fs.realpath(directory); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-setup-upgrade-test-[A-Za-z0-9]+$/); await fs.rm(actual, { recursive: true });
    });
    const oldFirefoxPath = path.join(root, 'artifacts/angelic-setup/x-notification-setup-0.1.0-preview.4.zip');
    const oldFirefox = await fs.readFile(oldFirefoxPath);
    const newFirefox = await currentFirefoxBuilder.buildArchive();
    assert.equal(createHash('sha256').update(oldFirefox).digest('hex'), 'c41a47ecb694cc8afe19ccfab3420d492a5a327b8264cb84b46da9ab1d7325db');
    assert.equal(await fs.readFile(`${oldFirefoxPath}.sha256`, 'utf8'), 'c41a47ecb694cc8afe19ccfab3420d492a5a327b8264cb84b46da9ab1d7325db  x-notification-setup-0.1.0-preview.4.zip\n');
    assert.equal(newFirefox.version, '0.1.0-preview.5');
    const archives = [oldFirefox, newFirefox.archive,
        await fs.readFile(path.join(root, 'artifacts/angelic-setup/chrome-setup-0.1.0-chrome-preview.1.zip')),
        await fs.readFile(path.join(root, 'artifacts/angelic-setup/chrome-setup-0.1.0-chrome-preview.2.zip')),
        await fs.readFile(path.join(root, 'artifacts/angelic-setup/chrome-setup-0.1.0-chrome-preview.3.zip'))];
    const bundles = [];
    for (let i = 0; i < archives.length; i++) {
        const bundle = path.join(directory, `bundle-${i}`); await fs.mkdir(bundle); bundles.push(bundle);
        for (const [name, data] of Object.entries(unzipSync(archives[i]))) {
            assert.match(name, i === 4 ? /^(?:_app\/)?[^/\\]+$/ : /^[^/\\]+$/);
            await fs.mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
            await fs.writeFile(path.join(bundle, name), data, { flag: 'wx' });
        }
    }
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const invoke = (script, args) => {
        const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
            { encoding: 'utf8', timeout: 20000, windowsHide: true });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    const firefoxRoot = path.join(directory, 'firefox-owned');
    invoke(path.join(bundles[0], 'Setup-XNotifications.ps1'), ['-Action', 'Prepare', '-PrivateRoot', firefoxRoot]);
    const oldOwner = await fs.readFile(path.join(firefoxRoot, 'owner.json'));
    assert.equal(invoke(path.join(bundles[1], 'Setup-XNotifications.ps1'), ['-Action', 'Status', '-PrivateRoot', firefoxRoot]).prepared, true);
    assert.deepEqual(await fs.readFile(path.join(firefoxRoot, 'owner.json')), oldOwner);
    for (const browser of ['chrome', 'brave']) {
        const owned = path.join(directory, `${browser}-owned`), oldScript = path.join(bundles[2], 'ChromeSetup.ps1'), newScript = path.join(bundles[3], 'ChromeSetup.ps1');
        assert.equal(invoke(oldScript, ['-Action', 'Prepare', '-Browser', browser, '-PrivateRoot', owned]).prepared, true);
        const owner = await fs.readFile(path.join(owned, 'owner.json'));
        assert.equal(invoke(newScript, ['-Action', 'Status', '-Browser', browser, '-PrivateRoot', owned]).prepared, true);
        assert.equal(invoke(path.join(bundles[4], '_app', 'ChromeSetup.ps1'), ['-Action', 'Status', '-Browser', browser, '-PrivateRoot', owned]).prepared, true);
        assert.deepEqual(await fs.readFile(path.join(owned, 'owner.json')), owner);
    }
});
