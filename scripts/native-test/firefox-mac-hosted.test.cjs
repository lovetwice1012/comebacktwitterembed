'use strict';
// Only a fresh test directory and the preinstalled signed Firefox are used.
// No existing Firefox profile, account, subscription or network data is read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { verifyInstalledMacFirefox } = require('../../src/automation/firefox-mac-browser');

test('signed macOS Firefox executes a synthetic XPCShell script from stdin',
    { skip: process.platform !== 'darwin', timeout: 240000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-firefox-hosted-fixture-'));
        t.after(async () => {
            const real = await fs.realpath(root);
            assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-firefox-hosted-fixture-/);
            await fs.rm(real, { recursive: true });
        });
        const browser = await verifyInstalledMacFirefox();
        assert.equal(browser.executable, '/Applications/Firefox.app/Contents/MacOS/firefox');
        assert.match(browser.version, /^[0-9A-Za-z._+-]{1,64}$/);
        const script = 'print("CBTE_SYNTHETIC_STDIN_OK"); quit(0);\n';
        const options = { cwd: root, input: script, encoding: 'utf8', timeout: 30000,
            env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin', MOZ_HEADLESS: '1', MOZ_DISABLE_NONLOCAL_CONNECTIONS: '1' } };
        const child = spawnSync(browser.executable, ['-xpcshell', '-f', '-'], options);
        const viaDevice = spawnSync(browser.executable, ['-xpcshell', '-f', '/dev/stdin'], options);
        const inline = spawnSync(browser.executable, ['-xpcshell', '-e', script], { ...options, input: '' });
        for (const [name, value] of [['pipe', child], ['device', viaDevice], ['inline', inline]]) {
            t.diagnostic(`${name}: status=${value.status} error=${value.error?.code || 'none'} stderr=${(value.stderr || '').slice(0, 1000)}`);
        }
        assert.equal(inline.error, undefined); assert.equal(inline.status, 0); assert.match(inline.stdout, /CBTE_SYNTHETIC_STDIN_OK/);
        assert.equal(child.error, undefined);
        // The process receives only synthetic input and a private empty HOME.
        // Capture a bounded diagnostic without credentials or profile data.
        assert.equal(child.status, 0, `synthetic Firefox stderr: ${(child.stderr || '').slice(0, 4000)}`);
        assert.match(child.stdout, /CBTE_SYNTHETIC_STDIN_OK/);
        const after = await verifyInstalledMacFirefox(); assert.deepEqual(after, browser);
    });
