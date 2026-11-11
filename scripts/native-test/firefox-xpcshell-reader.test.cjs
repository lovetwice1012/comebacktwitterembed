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
        const token = randomBytes(16).toString('hex'), base = path.join(parent, `cbte-xpcshell-isolated-${token}`);
        const snapshot = path.join(base, `firefox-snapshot-${token}`);
        await fs.mkdir(base); await fs.mkdir(path.join(base, 'seed')); await fs.mkdir(snapshot);
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
        const output = JSON.parse(await fs.readFile(path.join(base, `firefox-result-${token}.json`), 'utf8'));
        assert.equal(output.ok, true); assert.equal(output.export.push.scope, 'https://x.com/');
        assert.equal(output.export.push.uaid, '22222222-2222-4222-8222-222222222222');
        assert.equal(output.export.provenance.browserVersion, '160.0-synthetic');
        // Re-read the same synthetic copy using the bootstrap bytes over a
        // private stdin pipe, rather than asking Firefox to reopen its path.
        await fs.unlink(path.join(base, `firefox-result-${token}.json`));
        // XPCShell automatically evaluates xpcshell.js from its working
        // directory even when the main script comes from stdin. This harmless
        // fixture proves that the future launcher must also control its cwd.
        await fs.writeFile(path.join(base, 'xpcshell.js'), `{
          const marker = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
          marker.initWithPath(Services.env.get('CBTE_SYNTHETIC_PROFILE')); const parent = marker.parent; parent.append('autoload-marker');
          const out = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
          out.init(parent, 0x8a, 0o600, 0); out.close();
        }\n`, { flag: 'wx' });
        const piped = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
            '-Base', base, '-Firefox', firefox, '-ReadCopiedOnly', '-PipeBootstrap'], { windowsHide: true, encoding: 'utf8', timeout: 35000 });
        if (piped.error) throw piped.error;
        assert.equal(piped.status, 0, piped.stderr); assert.match(piped.stdout, /SYNTHETIC_READ_OK/);
        const pipedOutput = JSON.parse(await fs.readFile(path.join(base, `firefox-result-${token}.json`), 'utf8'));
        assert.deepEqual(pipedOutput, output);
        assert((await fs.stat(path.join(base, 'autoload-marker'))).isFile());
        if (process.env.CBTE_SYNTHETIC_INVENTORY === '1') {
            async function inventory(dir, rel = '') {
                for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                    const name = path.join(rel, entry.name);
                    console.log(`SYNTHETIC_ENTRY ${entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'} ${name}`);
                    if (entry.isDirectory()) await inventory(path.join(dir, entry.name), name);
                }
            }
            await inventory(snapshot);
        }
        assert.equal(await fs.readFile(path.join(base, 'seed', 'cookies.sqlite'), 'utf8'), 'synthetic-cookie-sentinel');
        await assert.rejects(fs.access(path.join(snapshot, 'cookies.sqlite')), { code: 'ENOENT' });
    });
