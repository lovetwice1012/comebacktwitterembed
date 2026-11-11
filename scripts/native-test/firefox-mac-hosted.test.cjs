'use strict';
// Only a fresh test directory and the preinstalled signed Firefox are used.
// No existing Firefox profile, account, subscription or network data is read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { verifyInstalledMacFirefox } = require('../../src/automation/firefox-mac-browser');

test('signed macOS Firefox reads a synthetic Push database with XPCShell',
    { skip: process.platform !== 'darwin', timeout: 480000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), token = randomBytes(16).toString('hex');
        const root = path.join(temp, `cbte-xpcshell-isolated-${token}`); await fs.mkdir(root, { mode: 0o700 });
        let preserveRoot = false;
        t.after(async () => {
            // If the process group cannot be proven empty, leave only this
            // synthetic root for the disposable hosted VM to clean up.
            if (preserveRoot) return;
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
        async function runSynthetic(source, env, resultReady) {
            const child = spawn(browser.executable, ['-xpcshell', '-e', source],
                { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '', settled = false, timer, polling = false, stopForResult = false;
            child.stdout.on('data', chunk => { if (stdout.length < 2000) stdout += chunk.toString('utf8').slice(0, 2000 - stdout.length); });
            child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString('utf8').slice(0, 2000 - stderr.length); });
            const exited = new Promise(resolve => {
                child.once('error', error => { if (!settled) { settled = true; resolve({ error: error.code || 'ERROR' }); } });
                child.once('exit', (code, signal) => { if (!settled) { settled = true; resolve({ code, signal }); } });
            });
            const poll = setInterval(() => {
                if (polling || settled || stopForResult) return;
                polling = true;
                void Promise.resolve().then(resultReady).then(ready => {
                    if (ready && !settled && !stopForResult) { stopForResult = true; child.kill('SIGTERM'); }
                }).catch(() => {}).finally(() => { polling = false; });
            }, 100);
            let status;
            try {
                status = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 30000); })]);
                if (status.timeout) {
                    child.kill('SIGTERM');
                    status = { timeout: true, result: await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 3000))]) };
                }
                await new Promise(resolve => setTimeout(resolve, 100));
                let groupAlive = false;
                if (child.pid) {
                    try { process.kill(-child.pid, 0); groupAlive = true; }
                    catch (error) { if (error.code !== 'ESRCH') groupAlive = true; }
                }
                if (groupAlive || !settled) preserveRoot = true;
                return { status, stdout, stderr, groupAlive, stopForResult };
            } finally { clearInterval(poll); clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); }
        }
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
        const seedSource = await fs.readFile(fixturePath, 'utf8'), bootstrap = await fs.readFile(bootstrapPath, 'utf8');
        // Fixed, synthetic-only progress labels identify where this headless
        // host stalls; they never include subscription data or paths.
        const seedScript = seedSource
            .replace("load(Services.env.get('CBTE_SYNTHETIC_READER'));", "dump('CBTE_STAGE_READER_LOADED\\n'); load(Services.env.get('CBTE_SYNTHETIC_READER')); dump('CBTE_STAGE_READER_READY\\n');")
            .replace('const pair = await crypto.subtle.generateKey', "dump('CBTE_STAGE_KEY_START\\n'); const pair = await crypto.subtle.generateKey")
            .replace('const publicKey = new Uint8Array', "dump('CBTE_STAGE_KEY_READY\\n'); const publicKey = new Uint8Array")
            .replace("const request = indexedDB.openForPrincipal", "dump('CBTE_STAGE_DB_OPEN\\n'); const request = indexedDB.openForPrincipal")
            .replace('tx.oncomplete = () => { db.close(); resolve(); };', "tx.oncomplete = () => { dump('CBTE_STAGE_DB_DONE\\n'); db.close(); resolve(); };")
            .replace("report('CBTE_SYNTHETIC_SEED_OK'); done = true; return;", "dump('CBTE_STAGE_REPORT_START\\n'); report('CBTE_SYNTHETIC_SEED_OK'); dump('CBTE_STAGE_REPORT_DONE\\n'); done = true; return;")
            .replace('quit(0);', "dump('CBTE_STAGE_QUIT\\n'); quit(0);");
        assert.notEqual(seedScript, seedSource);
        const readerHash = createHash('sha256').update(await fs.readFile(readerPath)).digest('hex');
        const baseEnv = { ...options.env, CBTE_SYNTHETIC_PROFILE: seed, CBTE_SYNTHETIC_MODE: 'seed',
            CBTE_SYNTHETIC_READER: readerPath, CBTE_SYNTHETIC_RESULT: path.join(root, 'result-seed.txt') };
        const seeded = await runSynthetic(seedScript, baseEnv, async () => {
            try { return await fs.readFile(path.join(root, 'result-seed.txt'), 'utf8') === 'CBTE_SYNTHETIC_SEED_OK'; }
            catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        });
        t.diagnostic(`seed: status=${JSON.stringify(seeded.status)} groupAlive=${seeded.groupAlive} stdout=${seeded.stdout} stderr=${seeded.stderr}`);
        let seedFile = 'missing';
        try { seedFile = await fs.readFile(path.join(root, 'result-seed.txt'), 'utf8') === 'CBTE_SYNTHETIC_SEED_OK' ? 'valid' : 'unexpected'; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        t.diagnostic(`seed-result-file: ${seedFile}`);
        assert(seeded.status.code === 0 || seeded.stopForResult && seeded.status.signal === 'SIGTERM', 'synthetic seed process failed');
        assert.equal(seeded.groupAlive, false);
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
        const read = await runSynthetic(bootstrap, readerEnv, async () => {
            try { const value = JSON.parse(await fs.readFile(resultPath, 'utf8')); return value.ok === true && value.export?.push?.scope === 'https://x.com/'; }
            catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
        });
        t.diagnostic(`reader: status=${JSON.stringify(read.status)} groupAlive=${read.groupAlive} stderr=${read.stderr}`);
        assert(read.status.code === 0 || read.stopForResult && read.status.signal === 'SIGTERM', 'synthetic reader process failed');
        assert.equal(read.groupAlive, false);
        const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
        assert.equal(result.ok, true); assert.equal(result.otherSubscriptionCount, 0);
        assert.equal(result.export.push.scope, 'https://x.com/'); assert.equal(result.export.provenance.browserVersion, browser.version);
        const after = await verifyInstalledMacFirefox(); assert.deepEqual(after, browser);
    });
