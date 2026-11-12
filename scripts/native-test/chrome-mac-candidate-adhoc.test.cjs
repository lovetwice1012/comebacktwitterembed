'use strict';
// Isolated GitHub-hosted Mac only. This deliberately substitutes ad-hoc
// signatures and fake notary responses; it does not prove a real release.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { buildCandidate, buildBraveCandidate, buildFirefoxCandidate, buildEdgeCandidate } = require('../build-mac-chrome-release-candidate.cjs');
const { waitForMacProcessGroupExit } = require('../../src/automation/chrome-mac-process-group');
const exec = promisify(execFile);

test('selected notarization tools are Apple signed',
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_CANDIDATE_FIXTURE !== '1', timeout: 60000 }, async () => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        for (const name of ['notarytool', 'stapler']) {
            const { stdout } = await exec('/usr/bin/xcrun', ['--find', name], { timeout: 30000, env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' } });
            const tool = stdout.trim(); assert.ok(path.isAbsolute(tool) && path.basename(tool) === name);
            await exec('/usr/bin/codesign', ['--verify', '--strict', '-R', '=anchor apple', await fs.realpath(tool)], { timeout: 30000, env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' } });
        }
    });

for (const browser of ['chrome', 'brave', 'firefox', 'edge']) test(`${browser} candidate assembles and launches with ad-hoc signatures and a fake notary`,
    { skip: process.platform !== 'darwin' || process.env.CBTE_MAC_CANDIDATE_FIXTURE !== '1', timeout: 180000 }, async t => {
        assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-candidate-native-'));
        let child, closed = false, closePromise;
        t.after(async () => {
            if (child && !closed) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
            let timer; const stopped = !child || closed || await Promise.race([closePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
            clearTimeout(timer); const gone = !child?.pid || stopped && await waitForMacProcessGroupExit(child.pid);
            if (gone) { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-candidate-native-/); await fs.rm(real, { recursive: true }); }
            assert.equal(gone, true, 'candidate fixture retained because shutdown was not confirmed');
        });
        const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
        assert.ok(arch); const runtime = process.env.MAC_CANDIDATE_RUNTIME, license = process.env.MAC_CANDIDATE_LICENSE;
        assert.ok(path.isAbsolute(runtime || '') && path.isAbsolute(license || ''));
        const output = path.join(root, `${browser}-mac-${arch}-1.2.3.zip`);
        await fs.copyFile('/usr/bin/true', path.join(root, 'notarytool')); await fs.copyFile('/usr/bin/true', path.join(root, 'stapler'));
        const run = async (file, args, options = {}) => {
            if (file.endsWith('/xcrun') && args[0] === '--find') return { stdout: path.join(root, args[1]) };
            if ([path.join(root, 'notarytool'), path.join(root, 'stapler')].includes(file)) return args[0] === 'submit' ? { stdout: '{"status":"Accepted"}' } : {};
            if (file.endsWith('/spctl')) return {};
            if (file.endsWith('/codesign')) {
                args = [...args]; const i = args.indexOf('--sign'); if (i >= 0) args[i + 1] = '-';
                const ts = args.indexOf('--timestamp'); if (ts >= 0) args.splice(ts, 1);
                const requirement = args.indexOf('-R'); if (requirement >= 0) args.splice(requirement, 2);
                if ([path.join(root, 'notarytool'), path.join(root, 'stapler')].includes(args.at(-1))) return {};
            }
            return exec(file, args, { timeout: options.timeout || 120000, maxBuffer: 1024 * 1024 });
        };
        const build = browser === 'brave' ? buildBraveCandidate : browser === 'firefox' ? buildFirefoxCandidate : browser === 'edge' ? buildEdgeCandidate : buildCandidate;
        const candidate = await build({ arch, version: '1.2.3', teamId: 'ABCDEFGHIJ', identity: 'Developer ID Application: Fixture', profile: 'fixture', runtime, license, output }, { run });
        assert.equal(candidate.published, false); const extracted = path.join(root, 'extracted'); await fs.mkdir(extracted);
        await exec('/usr/bin/ditto', ['-x', '-k', output, extracted], { timeout: 30000 });
        const app = path.join(extracted, 'X通知の準備.app'), launcher = path.join(app, 'Contents/MacOS/Launch');
        const node = path.join(app, 'Contents/MacOS/MacNode'), addon = path.join(app, 'Contents/MacOS/MacLevelDB.node');
        const probe = `const addon=require(${JSON.stringify(addon)});` +
            `(async()=>{const db=addon.db_init();await addon.db_open(db,${JSON.stringify(path.join(root, 'synthetic-db'))},{createIfMissing:true});` +
            `try{await addon.db_put(db,'fixture','value',{});}finally{await addon.db_close(db);}process.stdout.write('candidate-addon-ok');})().catch(()=>{process.exitCode=1});`;
        assert.equal((await exec(node, ['-e', probe], { timeout: 30000, maxBuffer: 16384, env: { HOME: root, PATH: '/usr/bin:/bin' } })).stdout, 'candidate-addon-ok');
        const home = path.join(root, 'home'); await fs.mkdir(path.join(home, 'Library/Application Support'), { recursive: true, mode: 0o700 });
        child = spawn(launcher, [], { detached: true, stdio: 'ignore', env: { HOME: home, PATH: '/usr/bin:/bin' } });
        closePromise = new Promise(resolve => { child.once('close', () => { closed = true; resolve(); }); });
        let dialog = false;
        for (let attempt = 0; attempt < 100 && !dialog && !closed; attempt++) {
            const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 1024 * 1024 });
            dialog = stdout.split('\n').some(line => { const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
                return !!match && Number(match[2]) === child.pid && path.basename(match[3]) === 'osascript'; });
            if (!dialog) await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(dialog, 'ad-hoc candidate did not reach the initial dialog');
        t.diagnostic(`${browser} ad-hoc candidate reached a synthetic dialog; notarization and Developer ID were not tested`);
    });
