'use strict';
// Only a fresh test directory and the preinstalled signed Firefox are used.
// No existing Firefox profile, account, subscription or network data is read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { verifyInstalledMacFirefox } = require('../../src/automation/firefox-mac-browser');

test('signed macOS Firefox reads a synthetic Push database with XPCShell',
    { skip: process.platform !== 'darwin', timeout: 480000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), token = randomBytes(16).toString('hex');
        const root = path.join(temp, `cbte-xpcshell-isolated-${token}`); await fs.mkdir(root, { mode: 0o700 });
        t.after(async () => {
            const real = await fs.realpath(root);
            assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-xpcshell-isolated-[0-9a-f]{32}$/);
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

        const seed = path.join(root, 'seed'), snapshot = path.join(root, `firefox-snapshot-${token}`);
        await fs.mkdir(seed); await fs.mkdir(snapshot);
        const fixturePath = path.resolve(__dirname, 'firefox-xpcshell-fixture.js');
        const readerPath = path.resolve(__dirname, '../../client/angelic-setup/Read-PushSubscription.js');
        const bootstrapPath = path.resolve(__dirname, '../../client/angelic-setup/mac/FirefoxXPCShellReader.js');
        const seedScript = await fs.readFile(fixturePath, 'utf8'), bootstrap = await fs.readFile(bootstrapPath, 'utf8');
        const readerHash = createHash('sha256').update(await fs.readFile(readerPath)).digest('hex');
        const baseEnv = { ...options.env, CBTE_SYNTHETIC_PROFILE: seed, CBTE_SYNTHETIC_MODE: 'seed',
            CBTE_SYNTHETIC_READER: readerPath, CBTE_SYNTHETIC_RESULT: path.join(root, 'result-seed.txt') };
        const seeded = spawnSync(browser.executable, ['-xpcshell', '-e', seedScript], { ...options, input: '', env: baseEnv });
        t.diagnostic(`seed: status=${seeded.status} error=${seeded.error?.code || 'none'} stderr=${(seeded.stderr || '').slice(0, 2000)}`);
        assert.equal(Boolean(seeded.error), false, 'synthetic seed process failed');
        assert.equal(seeded.status, 0, `synthetic seed stderr: ${(seeded.stderr || '').slice(0, 4000)}`);
        assert.equal(await fs.readFile(path.join(root, 'result-seed.txt'), 'utf8'), 'CBTE_SYNTHETIC_SEED_OK');
        const source = path.join(seed, 'storage/permanent/chrome/idb'), target = path.join(snapshot, 'storage/permanent/chrome/idb');
        await fs.mkdir(target, { recursive: true });
        const stem = '2918063365piupsah'; let copied = false;
        for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal']) {
            try { await fs.copyFile(path.join(source, stem + suffix), path.join(target, stem + suffix)); if (suffix === '.sqlite') copied = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        assert.equal(copied, true);
        try { await fs.cp(path.join(source, `${stem}.files`), path.join(target, `${stem}.files`), { recursive: true, errorOnExist: true, force: false }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const resultPath = path.join(root, `firefox-result-${token}.json`);
        const readerEnv = { ...options.env, CBTE_GECKO_SNAPSHOT: snapshot, CBTE_GECKO_RESULT: resultPath,
            CBTE_GECKO_READER: readerPath, CBTE_GECKO_READER_SHA256: readerHash,
            CBTE_GECKO_UAID: '22222222-2222-4222-8222-222222222222', CBTE_GECKO_VERSION: browser.version };
        const read = spawnSync(browser.executable, ['-xpcshell', '-e', bootstrap], { ...options, input: '', env: readerEnv });
        t.diagnostic(`reader: status=${read.status} error=${read.error?.code || 'none'} stderr=${(read.stderr || '').slice(0, 2000)}`);
        assert.equal(Boolean(read.error), false, 'synthetic reader process failed');
        assert.equal(read.status, 0, `synthetic reader stderr: ${(read.stderr || '').slice(0, 4000)}`);
        const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
        assert.equal(result.ok, true); assert.equal(result.otherSubscriptionCount, 0);
        assert.equal(result.export.push.scope, 'https://x.com/'); assert.equal(result.export.provenance.browserVersion, browser.version);
        const after = await verifyInstalledMacFirefox(); assert.deepEqual(after, browser);
    });
