'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const firefox = process.env.CBTE_XPCSHELL_FIREFOX;

test('signed Firefox XPCShell reads a synthetic Push database copied between isolated profiles',
    { skip: process.platform !== 'win32' || !firefox, timeout: 45000 }, async t => {
        const parent = await fs.realpath(os.tmpdir());
        const base = path.join(parent, `cbte-xpcshell-isolated-${randomBytes(16).toString('hex')}`);
        await fs.mkdir(base); await fs.mkdir(path.join(base, 'seed')); await fs.mkdir(path.join(base, 'read'));
        await fs.writeFile(path.join(base, 'seed', 'cookies.sqlite'), 'synthetic-cookie-sentinel');
        t.after(async () => {
            const real = await fs.realpath(base);
            assert.equal(path.dirname(real).toLowerCase(), parent.toLowerCase());
            assert.match(path.basename(real), /^cbte-xpcshell-isolated-[0-9a-f]{32}$/);
            await fs.rm(real, { recursive: true });
        });
        const runner = path.join(__dirname, 'firefox-xpcshell-runner.ps1');
        const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const invalidBase = path.join(base, 'not-an-isolated-root'); await fs.mkdir(invalidBase);
        const rejected = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
            '-Base', invalidBase, '-Firefox', firefox], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        if (rejected.error) throw rejected.error;
        assert.notEqual(rejected.status, 0);
        assert.deepEqual(await fs.readdir(invalidBase), []);
        const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
            '-Base', base, '-Firefox', firefox], { windowsHide: true, encoding: 'utf8', timeout: 35000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /SYNTHETIC_READ_OK/);
        assert.equal(await fs.readFile(path.join(base, 'result-seed.txt'), 'utf8'), 'CBTE_SYNTHETIC_SEED_OK');
        assert.equal(await fs.readFile(path.join(base, 'result-read.txt'), 'utf8'), 'CBTE_SYNTHETIC_READ_OK');
        assert.equal(await fs.readFile(path.join(base, 'seed', 'cookies.sqlite'), 'utf8'), 'synthetic-cookie-sentinel');
        await assert.rejects(fs.access(path.join(base, 'read', 'cookies.sqlite')), { code: 'ENOENT' });
    });
