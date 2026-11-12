'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { buildCandidate, buildBraveCandidate, buildFirefoxCandidate, validateOptions, publishCandidate, releaseEnvironment } = require('../build-mac-chrome-release-candidate.cjs');
const hash = b => createHash('sha256').update(b).digest('hex');
const baseInput = (root, browser = 'chrome') => ({ arch: 'arm64', version: '1.2.3', teamId: 'ABCDEFGHIJ', identity: 'Developer ID Application: Fixture', profile: 'fixture',
    runtime: path.join(root, 'node'), license: path.join(root, 'license'), output: path.join(root, `${browser}-mac-arm64-1.2.3.zip`) });
async function fixture(t, mode, browser = 'chrome') {
    if (process.platform === 'win32') {
        const lstat = fs.lstat;
        t.mock.method(fs, 'lstat', async filename => {
            const info = await lstat(filename);
            if (/[/\\](?:MacStoreLock|Launch|MacNode)$/.test(filename)) info.mode |= 0o111;
            return info;
        });
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-release-unit-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const input = baseInput(root, browser), calls = [];
    await fs.writeFile(input.runtime, 'runtime'); await fs.writeFile(input.license, 'license');
    await fs.writeFile(path.join(root, 'notarytool'), 'fixture'); await fs.writeFile(path.join(root, 'stapler'), 'fixture');
    const run = async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd.endsWith('/xcrun') && args[0] === '--find') return { stdout: mode === 'badtool' ? 'relative/notarytool' : path.join(root, args[1]) };
        if (cmd.endsWith('/codesign') && args.includes('--verify') && mode === 'badsignature') throw Error('private');
        if (cmd.endsWith('/clang')) { await fs.writeFile(args.at(-1), 'compiled', { mode: 0o755 }); return {}; }
        if (cmd.endsWith('/codesign') && args.includes('--sign')) { const target = args.at(-1); const st = await fs.stat(target); if (st.isFile()) await fs.appendFile(target, 'signed'); return {}; }
        if (cmd.endsWith('/ditto') && args[0] === '-x') {
            const dest = args.at(-1), source = args.at(-2), app = path.join(dest, 'X通知の準備.app');
            if (source.endsWith('candidate.zip')) { await fs.cp(path.join(path.dirname(source), 'stage'), dest, { recursive: true }); return {}; }
            const bin = path.join(app, 'Contents', 'MacOS'), res = path.join(app, 'Contents', 'Resources');
            await fs.mkdir(bin, { recursive: true }); await fs.mkdir(res, { recursive: true });
            const helper = path.join(path.dirname(dest), 'MacStoreLock'), launcher = path.join(path.dirname(dest), 'Launch');
            await fs.copyFile(helper, path.join(bin, 'MacStoreLock')); await fs.copyFile(launcher, path.join(bin, 'Launch'));
            await fs.writeFile(path.join(bin, 'MacNode'), 'runtime', { mode: 0o755 }); await fs.writeFile(path.join(bin, 'MacLevelDB.node'), 'addon');
            if (browser === 'firefox') {
                await fs.writeFile(path.join(res, 'FirefoxXPCShellReader.js'), 'bootstrap');
                await fs.writeFile(path.join(res, 'Read-PushSubscription.js'), 'reader');
            }
            await fs.writeFile(path.join(res, 'MacSetup-manifest.json'), JSON.stringify(browser === 'firefox'
                ? { packageId: 'x-notification-mac-firefox-setup', version: '0.1.0-mac-firefox-preview.1', lockSha256: hash(await fs.readFile(helper)), bootstrapSha256: hash('bootstrap'), readerSha256: hash('reader') }
                : browser === 'brave'
                ? { packageId: 'x-notification-mac-brave-setup', version: '0.1.0-mac-brave-preview.2', lockSha256: hash(await fs.readFile(helper)) }
                : { packageId: 'x-notification-mac-chrome-setup', version: '0.1.0-mac-preview.1', lockSha256: hash(await fs.readFile(helper)) }));
            await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), '<key>CFBundleShortVersionString</key><string>0.1.0</string>'); return {};
        }
        if (cmd.endsWith('/ditto') && args[0] === '-c') { await fs.writeFile(args.at(-1), args.includes('--keepParent') ? 'submitted' : 'stapled-final'); return {}; }
        if (path.basename(cmd) === 'notarytool' && args[0] === 'submit') return { stdout: JSON.stringify({ status: mode === 'reject' ? 'Invalid' : 'Accepted' }) };
        if (path.basename(cmd) === 'stapler' && args[0] === 'staple' && mode === 'staple-fail') throw Error('private');
        if (path.basename(cmd) === 'stapler' && args[0] === 'staple' && mode === 'tamper') await fs.appendFile(path.join(args.at(-1), 'Contents', 'MacOS', 'MacStoreLock'), 'tampered');
        if (path.basename(cmd) === 'stapler' && args[0] === 'staple' && mode === 'tamper-kind') {
            const filename = path.join(args.at(-1), 'Contents', 'Resources', 'MacSetup-manifest.json');
            const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
            manifest.packageId = 'x-notification-mac-chrome-setup';
            await fs.writeFile(filename, JSON.stringify(manifest));
        }
        if (path.basename(cmd) === 'stapler' && args[0] === 'staple' && mode === 'tamper-firefox-reader')
            await fs.appendFile(path.join(args.at(-1), 'Contents', 'Resources', 'Read-PushSubscription.js'), 'tampered');
        if (path.basename(cmd) === 'stapler' && args[0] === 'staple' && mode === 'tamper-firefox-bootstrap')
            await fs.appendFile(path.join(args.at(-1), 'Contents', 'Resources', 'FirefoxXPCShellReader.js'), 'tampered');
        return {};
    };
    const buildPreview = async ({ helper, launcher, runtime, license }) => {
        assert.ok(helper.toString().endsWith('signed') && launcher.toString().endsWith('signed'));
        assert.equal(runtime.toString(), 'runtime'); assert.equal(license.toString(), 'license'); return { archive: Buffer.from('preview') };
    };
    return { input, calls, run, buildPreview };
}
test('candidate refuses non-Mac and invalid or option-shaped inputs before work', () => {
    const input = baseInput(path.resolve(os.tmpdir()));
    assert.throws(() => validateOptions(input, 'win32'), { code: 'MAC_RELEASE_PLATFORM_REQUIRED' });
    for (const changes of [{ profile: '--bad' }, { teamId: 'wrong' }, { version: '1.0.0-preview' }, { identity: '-' }, { output: path.join(os.tmpdir(), 'other.zip') }])
        assert.throws(() => validateOptions({ ...input, ...changes }, 'darwin'), { code: 'MAC_RELEASE_INPUT_INVALID' });
});
test('release commands reject toolchain and runtime injection environment', () => {
    const result = releaseEnvironment({ HOME: '/home/test', PATH: '/attacker', DEVELOPER_DIR: '/attacker', SDKROOT: '/attacker', CPATH: '/attacker',
        LIBRARY_PATH: '/attacker', DYLD_INSERT_LIBRARIES: '/attacker', NODE_OPTIONS: '--require attacker', USER: 'fixture' });
    assert.deepEqual(result, { HOME: '/home/test', USER: 'fixture', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
});
test('candidate signs components before app, submits before stapling and hashes final archive', async t => {
    const f = await fixture(t), result = await buildCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview });
    const signed = f.calls.filter(c => c.cmd.endsWith('/codesign') && c.args.includes('--sign')).map(c => path.basename(c.args.at(-1)));
    assert.deepEqual(signed, ['MacStoreLock', 'Launch', 'MacLevelDB.node', 'MacNode', 'X通知の準備.app']);
    const submit = f.calls.findIndex(c => path.basename(c.cmd) === 'notarytool' && c.args[0] === 'submit'), staple = f.calls.findIndex(c => path.basename(c.cmd) === 'stapler' && c.args[0] === 'staple');
    assert.ok(submit >= 0 && staple > submit); assert.equal(result.submittedSha256, hash(Buffer.from('submitted')));
    assert.equal(result.sha256, hash(await fs.readFile(f.input.output))); assert.equal(result.published, false);
    await assert.rejects(buildCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview }), { code: 'MAC_RELEASE_OUTPUT_EXISTS' });
});
test('Brave candidate uses its own signed manifest and never accepts a Chrome output name', async t => {
    const f = await fixture(t, undefined, 'brave');
    assert.throws(() => validateOptions({ ...f.input, output: path.join(path.dirname(f.input.output), 'chrome-mac-arm64-1.2.3.zip') }, 'darwin', 'brave'),
        { code: 'MAC_RELEASE_INPUT_INVALID' });
    assert.throws(() => validateOptions(f.input, 'darwin', 'chrome'), { code: 'MAC_RELEASE_INPUT_INVALID' });
    const result = await buildBraveCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview });
    const signed = f.calls.filter(c => c.cmd.endsWith('/codesign') && c.args.includes('--sign')).map(c => path.basename(c.args.at(-1)));
    assert.deepEqual(signed, ['MacStoreLock', 'Launch', 'MacLevelDB.node', 'MacNode', 'X通知の準備.app']);
    assert.equal(result.filename, 'brave-mac-arm64-1.2.3.zip'); assert.equal(result.sha256, hash(await fs.readFile(f.input.output)));
    assert.equal(result.published, false);
});
test('Brave builder rejects Chrome metadata before submitting to Apple', async t => {
    const f = await fixture(t); f.input.output = path.join(path.dirname(f.input.output), 'brave-mac-arm64-1.2.3.zip');
    await assert.rejects(buildBraveCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview }), { code: 'MAC_RELEASE_MANIFEST_INVALID' });
    assert.equal(f.calls.some(call => path.basename(call.cmd) === 'notarytool' && call.args[0] === 'submit'), false);
    await assert.rejects(fs.access(f.input.output), { code: 'ENOENT' });
});
test('Brave builder rejects changed package identity after stapling', async t => {
    const f = await fixture(t, 'tamper-kind', 'brave');
    await assert.rejects(buildBraveCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview }), { code: 'MAC_RELEASE_MANIFEST_INVALID' });
    await assert.rejects(fs.access(f.input.output), { code: 'ENOENT' });
});
test('Firefox candidate verifies its own identity and both reader hashes', async t => {
    const f = await fixture(t, undefined, 'firefox');
    assert.throws(() => validateOptions(f.input, 'darwin', 'chrome'), { code: 'MAC_RELEASE_INPUT_INVALID' });
    const result = await buildFirefoxCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview });
    assert.equal(result.filename, 'firefox-mac-arm64-1.2.3.zip'); assert.equal(result.published, false);
    assert.equal(result.sha256, hash(await fs.readFile(f.input.output)));
});
for (const mode of ['tamper-firefox-reader', 'tamper-firefox-bootstrap']) test(`Firefox candidate rejects ${mode} after notarization`, async t => {
    const f = await fixture(t, mode, 'firefox');
    await assert.rejects(buildFirefoxCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview }), { code: 'MAC_RELEASE_MANIFEST_INVALID' });
    await assert.rejects(fs.access(f.input.output), { code: 'ENOENT' });
});
for (const mode of ['reject', 'staple-fail', 'tamper']) test(`${mode} never creates a candidate output`, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(buildCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview }), mode === 'tamper' ? { code: 'MAC_RELEASE_MANIFEST_INVALID' } : undefined);
    await assert.rejects(fs.access(f.input.output), { code: 'ENOENT' });
});
for (const mode of ['badtool', 'badsignature']) test(`${mode} stops before submission and output`, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(buildCandidate(f.input, { platform: 'darwin', run: f.run, buildPreview: f.buildPreview }));
    assert.equal(f.calls.some(call => path.basename(call.cmd) === 'notarytool' && call.args[0] === 'submit'), false);
    await assert.rejects(fs.access(f.input.output), { code: 'ENOENT' });
});

test('concurrent publishes never overwrite and leave one complete candidate', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-publish-unit-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'candidate.zip'), a = Buffer.from('complete-a'), b = Buffer.from('complete-b');
    const results = await Promise.allSettled([publishCandidate(output, a), publishCandidate(output, b)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const actual = await fs.readFile(output); assert.ok(actual.equals(a) || actual.equals(b));
    assert.deepEqual(await fs.readdir(root), ['candidate.zip']);
});
for (const mode of ['write', 'link']) test(`${mode} failure never exposes a partial candidate`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-publish-unit-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'candidate.zip');
    if (mode === 'write') {
        const open = fs.open;
        t.mock.method(fs, 'open', async (...args) => {
            const handle = await open(...args);
            return new Proxy(handle, { get(target, name) {
                if (name === 'writeFile') return async bytes => { await target.writeFile(bytes.subarray(0, 1)); throw Error('simulated write failure'); };
                const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
            } });
        });
    } else t.mock.method(fs, 'link', async () => { throw Error('simulated link failure'); });
    await assert.rejects(publishCandidate(output, Buffer.from('candidate')));
    assert.deepEqual(await fs.readdir(root), []);
});
