'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');

test('Windows Chrome package protects its profile, rejects tampering and never overwrites existing output',
    { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
        const parent = await fsp.realpath(os.tmpdir()), root = await fsp.mkdtemp(path.join(parent, 'cbte-chrome-package-test-'));
        t.after(async () => {
            const actual = await fsp.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
            assert.match(path.basename(actual), /^cbte-chrome-package-test-/); await fsp.rm(actual, { recursive: true });
        });
        const bundle = path.join(root, '配布 & fixture'), owned = path.join(root, '専用 & fixture');
        await fsp.mkdir(bundle);
        const archive = await fsp.readFile(path.resolve(__dirname, '../../artifacts/angelic-setup/chrome-setup-0.1.0-chrome-preview.6.zip'));
        for (const [name, content] of Object.entries(unzipSync(archive))) {
            assert.match(name, /^(?:_app\/)?[^/\\]+$/); await fsp.mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
            await fsp.writeFile(path.join(bundle, name), content, { flag: 'wx' });
        }
        const app = path.join(bundle, '_app');
        const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const invoke = args => {
            const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'ChromeSetup.ps1'), ...args],
                { encoding: 'utf8', windowsHide: true, timeout: 30000 });
            if (result.error) throw result.error;
            return { ...result, data: JSON.parse(result.stdout) };
        };
        assert.equal(invoke(['-Action', 'Status', '-PrivateRoot', owned]).data.prepared, false);
        assert.equal(invoke(['-Action', 'Prepare', '-PrivateRoot', owned]).data.prepared, true);
        const braveOwned = path.join(root, 'Brave専用');
        assert.equal(invoke(['-Action', 'Status', '-Browser', 'brave', '-PrivateRoot', braveOwned]).data.prepared, false);
        assert.equal(invoke(['-Action', 'Prepare', '-Browser', 'brave', '-PrivateRoot', braveOwned]).data.prepared, true);
        const bravePrefs = JSON.parse(await fsp.readFile(path.join(braveOwned, 'chrome-profile', 'Default', 'Preferences'), 'utf8'));
        assert.equal(bravePrefs.brave.gcm.channel_status, true);
        assert.equal(invoke(['-Action', 'Status', '-Browser', 'chrome', '-PrivateRoot', braveOwned]).status, 1);
        assert.equal(invoke(['-Action', 'Status', '-Browser', 'brave', '-PrivateRoot', owned]).status, 1);
        const output = path.join(root, 'existing.json'); await fsp.writeFile(output, 'existing');
        const rejected = invoke(['-Action', 'Export', '-PrivateRoot', owned, '-OutputPath', output]);
        assert.equal(rejected.status, 1); assert.match(rejected.data.message, /^X_CHROME_OUTPUT_INVALID:/);
        assert.equal(await fsp.readFile(output, 'utf8'), 'existing');
        const foreign = path.join(root, 'foreign'); await fsp.mkdir(foreign); await fsp.writeFile(path.join(foreign, 'keep.txt'), 'keep');
        assert.equal(invoke(['-Action', 'Prepare', '-PrivateRoot', foreign]).status, 1);
        assert.equal(await fsp.readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'keep');
        await fsp.appendFile(path.join(app, 'ChromeCapture.cjs'), '\n// modified\n');
        const tampered = invoke(['-Action', 'Status', '-PrivateRoot', path.join(root, 'new-owned')]);
        assert.equal(tampered.status, 1); assert.match(tampered.data.message, /^X_CHROME_PACKAGE_INVALID:/);
        assert.equal(fs.existsSync(path.join(root, 'new-owned')), false);
    });
test('Chrome and Brave launchers select the right browser in paths with Japanese and symbols',
    { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
        const parent = await fsp.realpath(os.tmpdir()), root = await fsp.mkdtemp(path.join(parent, 'cbte-chrome-launch-test-'));
        t.after(async () => { const actual = await fsp.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
            assert.match(path.basename(actual), /^cbte-chrome-launch-test-/); await fsp.rm(actual, { recursive: true }); });
        const bundle = path.join(root, '日本語 [folder] & ! $value %literal%'); await fsp.mkdir(bundle);
        const entries = unzipSync(await fsp.readFile(path.resolve(__dirname, '../../artifacts/angelic-setup/chrome-setup-0.1.0-chrome-preview.6.zip')));
        for (const name of ['Chromeで開始.cmd', 'Braveで開始.cmd']) await fsp.writeFile(path.join(bundle, name), entries[name]);
        const app = path.join(bundle, '_app'); await fsp.mkdir(app);
        const resultPath = path.join(root, 'launcher-result.json');
        await fsp.writeFile(path.join(app, 'Start-ChromeSetup.ps1'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`
param([string]$Browser='chrome')
[IO.File]::WriteAllText($env:X_SETUP_LAUNCH_RESULT,([ordered]@{browser=$Browser;apartment=[Threading.Thread]::CurrentThread.GetApartmentState().ToString();argumentCount=$args.Count;scriptDirectory=$PSScriptRoot}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
exit 0
`, 'utf8')]));
        for (const [name, expected] of [['Chromeで開始.cmd', 'chrome'], ['Braveで開始.cmd', 'brave']]) {
            const launched = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '""%X_SETUP_ENTRY%" ignored-user-argument"'],
                { encoding: 'utf8', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true,
                    env: { ...process.env, X_SETUP_ENTRY: path.join(bundle, name), X_SETUP_LAUNCH_RESULT: resultPath } });
            if (launched.error) throw launched.error;
            assert.equal(launched.status, 0, launched.stderr);
            const actual = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
            assert.equal(actual.browser, expected); assert.equal(actual.apartment, 'STA'); assert.equal(actual.argumentCount, 0);
            assert.equal(actual.scriptDirectory.toLowerCase(), app.toLowerCase());
        }
    });
