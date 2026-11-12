'use strict';

// Local candidate builder only. It never changes the release registry or
// publishes a download. Running it submits the resulting archive to Apple.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildMacChromePreview, buildMacBraveReleasePreview, buildMacFirefoxReleasePreview, readInput } = require('./build-mac-chrome-preview.cjs');
const exec = promisify(execFile);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function publishCandidate(output, bytes) {
    const parent = await fs.realpath(path.dirname(output));
    const final = path.join(parent, path.basename(output));
    const tempDirectory = await fs.mkdtemp(path.join(parent, '.cbte-candidate-'));
    const temp = path.join(tempDirectory, 'candidate.tmp');
    let handle, identity, linked = false, cleanupPending = false;
    try {
        await fs.chmod(tempDirectory, 0o700);
        handle = await fs.open(temp, 'wx', 0o600); identity = await handle.stat();
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
        // Hard-link creation is atomic and fails if the destination exists;
        // unlike rename it can never replace an unrelated existing file.
        await fs.link(temp, final); linked = true;
    } finally {
        if (handle) await handle.close().catch(() => {});
        if (identity) {
            try { const actual = await fs.lstat(temp); if (actual.dev === identity.dev && actual.ino === identity.ino) await fs.unlink(temp); else cleanupPending = true; }
            catch (error) { if (error?.code !== 'ENOENT') cleanupPending = true; }
        }
        try { await fs.rmdir(tempDirectory); } catch (error) { if (error?.code !== 'ENOENT') cleanupPending = true; }
    }
    if (!linked) fail('MAC_RELEASE_SAVE_FAILED');
    return { cleanupPending };
}

const CANDIDATE_KINDS = Object.freeze({
    chrome: Object.freeze({ prefix: 'chrome-mac', packageId: 'x-notification-mac-chrome-setup', manifestVersion: '0.1.0-mac-preview.1', buildPreview: buildMacChromePreview }),
    brave: Object.freeze({ prefix: 'brave-mac', packageId: 'x-notification-mac-brave-setup', manifestVersion: '0.1.0-mac-brave-preview.2', buildPreview: buildMacBraveReleasePreview }),
    firefox: Object.freeze({ prefix: 'firefox-mac', packageId: 'x-notification-mac-firefox-setup', manifestVersion: '0.1.0-mac-firefox-preview.1', buildPreview: buildMacFirefoxReleasePreview }),
});
async function verifyManifest(kind, manifest, bin, res) {
    if (!manifest || manifest.packageId !== kind.packageId || manifest.version !== kind.manifestVersion
        || manifest.lockSha256 !== digest(await fs.readFile(path.join(bin, 'MacStoreLock')))) fail('MAC_RELEASE_MANIFEST_INVALID');
    if (kind.prefix === 'firefox-mac') {
        for (const [field, filename] of [['bootstrapSha256', 'FirefoxXPCShellReader.js'], ['readerSha256', 'Read-PushSubscription.js']]) {
            if (manifest[field] !== digest(await fs.readFile(path.join(res, filename)))) fail('MAC_RELEASE_MANIFEST_INVALID');
        }
    }
}
function validateOptions(input, platform = process.platform, browser = 'chrome') {
    if (platform !== 'darwin') fail('MAC_RELEASE_PLATFORM_REQUIRED');
    const kind = Object.hasOwn(CANDIDATE_KINDS, browser) ? CANDIDATE_KINDS[browser] : null;
    if (!input || !['arm64', 'x64'].includes(input.arch) || typeof input.version !== 'string'
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(input.version)
        || typeof input.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(input.teamId)
        || typeof input.identity !== 'string' || !/^Developer ID Application: [^\r\n]{1,180}$/.test(input.identity)
        || typeof input.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(input.profile)
        || ![input.runtime, input.license, input.output].every(value => typeof value === 'string' && path.isAbsolute(value))
        || !kind || path.basename(input.output) !== `${kind.prefix}-${input.arch}-${input.version}.zip`) fail('MAC_RELEASE_INPUT_INVALID');
    return Object.freeze({ ...input });
}
async function run(file, args, opts = {}) {
    // No shell expansion or secret-bearing command logging.
    // Do not allow environment variables to select a different toolchain,
    // inject compiler flags, or insert runtime libraries into Apple tools.
    const env = releaseEnvironment(process.env);
    try { return await exec(file, args, { timeout: opts.timeout || 120000, maxBuffer: 1024 * 1024, windowsHide: true, env }); }
    catch { fail('MAC_RELEASE_COMMAND_FAILED'); }
}
function releaseEnvironment(source) {
    const env = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].filter(name => typeof source[name] === 'string')
        .map(name => [name, source[name]]));
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'; return env;
}
async function buildForBrowser(browser, raw, dependencies = {}) {
    const input = validateOptions(raw, dependencies.platform || process.platform, browser);
    const kind = CANDIDATE_KINDS[browser];
    const command = dependencies.run || run;
    try { await fs.lstat(input.output); fail('MAC_RELEASE_OUTPUT_EXISTS'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const tmpRoot = await fs.realpath(os.tmpdir()), temp = await fs.mkdtemp(path.join(tmpRoot, 'cbte-mac-candidate-'));
    await fs.chmod(temp, 0o700);
    let stage = 'inputs', outputCreated = false;
    try {
        const runtime = await readInput(input.runtime, 150 * 1024 * 1024), license = await readInput(input.license, 1024 * 1024);
        stage = 'toolchain';
        async function appleTool(name) {
            const found = await command('/usr/bin/xcrun', ['--find', name]);
            const resolved = String(found.stdout || '').trim();
            if (!path.isAbsolute(resolved) || path.basename(resolved) !== name) fail('MAC_RELEASE_TOOLCHAIN_INVALID');
            const real = await fs.realpath(resolved), info = await fs.lstat(real);
            if (!info.isFile() || info.isSymbolicLink()) fail('MAC_RELEASE_TOOLCHAIN_INVALID');
            await command('/usr/bin/codesign', ['--verify', '--strict', '-R', '=anchor apple', real]);
            return real;
        }
        const notarytool = await appleTool('notarytool'), stapler = await appleTool('stapler');
        const helper = path.join(temp, 'MacStoreLock'), launcher = path.join(temp, 'Launch'), section = path.join(temp, 'restrict-section');
        await fs.writeFile(section, Buffer.from([0]), { flag: 'wx', mode: 0o600 });
        const repo = path.resolve(__dirname, '..');
        const helperSource = path.join(repo, 'client/angelic-setup/mac/lock-notification-stores.c');
        const launchSource = path.join(repo, 'client/angelic-setup/mac/launch-native.c');
        stage = 'compile';
        const targetArch = input.arch === 'arm64' ? 'arm64' : 'x86_64';
        await command('/usr/bin/clang', ['-O2', '-arch', targetArch, '-mmacosx-version-min=13.5', helperSource, '-o', helper]);
        await command('/usr/bin/clang', ['-O2', '-arch', targetArch, '-mmacosx-version-min=13.5', launchSource, `-Wl,-sectcreate,__RESTRICT,__restrict,${section}`, '-o', launcher]);
        const sign = async (target, args = []) => command('/usr/bin/codesign', ['--force', '--sign', input.identity, '--timestamp', '--options', 'runtime', ...args, target]);
        stage = 'sign_components'; await sign(helper); await sign(launcher);
        stage = 'assemble';
        const preview = await (dependencies.buildPreview || kind.buildPreview)({ arch: input.arch, runtime, license,
            launcher: await readInput(launcher, 4 * 1024 * 1024), helper: await readInput(helper, 4 * 1024 * 1024) });
        const previewZip = path.join(temp, 'preview.zip'), stageDir = path.join(temp, 'stage');
        await fs.writeFile(previewZip, preview.archive, { flag: 'wx', mode: 0o600 }); await fs.mkdir(stageDir, { mode: 0o700 });
        await command('/usr/bin/ditto', ['-x', '-k', previewZip, stageDir]);
        const app = path.join(stageDir, 'X通知の準備.app'), bin = path.join(app, 'Contents', 'MacOS'), res = path.join(app, 'Contents', 'Resources');
        const manifestPath = path.join(res, 'MacSetup-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        // The current entry point requires this exact internal format version.
        // Keep it unchanged; the separately supplied version is the bundle's
        // release version, not a replacement for the internal protocol marker.
        await verifyManifest(kind, manifest, bin, res);
        const plistPath = path.join(app, 'Contents', 'Info.plist');
        const plist = await fs.readFile(plistPath, 'utf8');
        if (!plist.includes('<key>CFBundleShortVersionString</key><string>0.1.0</string>')) fail('MAC_RELEASE_MANIFEST_INVALID');
        await fs.writeFile(plistPath, plist.replace('<key>CFBundleShortVersionString</key><string>0.1.0</string>',
            `<key>CFBundleShortVersionString</key><string>${input.version}</string>`), { mode: 0o600 });
        const entitlement = path.join(temp, 'node-entitlements.plist');
        await fs.writeFile(entitlement, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>', { flag: 'wx', mode: 0o600 });
        stage = 'sign_bundle'; await sign(path.join(bin, 'MacLevelDB.node'));
        await sign(path.join(bin, 'MacNode'), ['--entitlements', entitlement]);
        await sign(app);
        const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${input.teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
        const verify = async target => command('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, target]);
        for (const target of [path.join(bin, 'MacStoreLock'), path.join(bin, 'Launch'), path.join(bin, 'MacNode'), path.join(bin, 'MacLevelDB.node'), app]) await verify(target);
        if (manifest.lockSha256 !== digest(await fs.readFile(path.join(bin, 'MacStoreLock')))) fail('MAC_RELEASE_MANIFEST_INVALID');
        const submitZip = path.join(temp, 'submit.zip');
        await command('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, submitZip]);
        const submittedSha256 = digest(await readInput(submitZip, 200 * 1024 * 1024));
        stage = 'notarize';
        const submission = await command(notarytool, ['submit', submitZip, '--keychain-profile', input.profile, '--wait', '--output-format', 'json'], { timeout: 1800000 });
        let result; try { result = JSON.parse(submission.stdout); } catch { fail('MAC_RELEASE_NOTARY_INVALID'); }
        if (result?.status !== 'Accepted') fail('MAC_RELEASE_NOTARY_REJECTED');
        stage = 'staple'; await command(stapler, ['staple', app]);
        await command(stapler, ['validate', app]);
        await verify(app);
        await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
        stage = 'verify_final'; const finalZip = path.join(temp, 'candidate.zip');
        // Archive the app and the user guide without a wrapping folder.
        await command('/usr/bin/ditto', ['-c', '-k', stageDir, finalZip]);
        const check = path.join(temp, 'check'); await fs.mkdir(check, { mode: 0o700 });
        await command('/usr/bin/ditto', ['-x', '-k', finalZip, check]);
        const checkedApp = path.join(check, 'X通知の準備.app');
        const checkedBin = path.join(checkedApp, 'Contents', 'MacOS');
        for (const name of ['MacStoreLock', 'Launch', 'MacNode', 'MacLevelDB.node']) await verify(path.join(checkedBin, name));
        for (const name of ['MacStoreLock', 'Launch', 'MacNode']) {
            const stat = await fs.lstat(path.join(checkedBin, name));
            if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) fail('MAC_RELEASE_PACKAGE_INVALID');
        }
        await verify(checkedApp); await command(stapler, ['validate', checkedApp]);
        await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', checkedApp]);
        const checkedManifest = JSON.parse(await fs.readFile(path.join(checkedApp, 'Contents', 'Resources', 'MacSetup-manifest.json'), 'utf8'));
        await verifyManifest(kind, checkedManifest, checkedBin, path.join(checkedApp, 'Contents', 'Resources'));
        const bytes = await readInput(finalZip, 200 * 1024 * 1024);
        stage = 'save'; const saved = await publishCandidate(input.output, bytes); outputCreated = true;
        return Object.freeze({ version: input.version, arch: input.arch, filename: path.basename(input.output), bytes: bytes.length,
            sha256: digest(bytes), submittedSha256, published: false, cleanupPending: saved.cleanupPending });
    } catch (error) {
        if (outputCreated) { /* Preserve a completed candidate; never delete a user file. */ }
        throw Object.assign(error instanceof Error ? error : new Error('MAC_RELEASE_FAILED'), { stage });
    } finally {
        const actual = await fs.realpath(temp);
        if (path.dirname(actual) === tmpRoot && path.basename(actual).startsWith('cbte-mac-candidate-')) await fs.rm(actual, { recursive: true, force: true });
    }
}
const buildCandidate = (raw, dependencies) => buildForBrowser('chrome', raw, dependencies);
const buildBraveCandidate = (raw, dependencies) => buildForBrowser('brave', raw, dependencies);
const buildFirefoxCandidate = (raw, dependencies) => buildForBrowser('firefox', raw, dependencies);
function parseArgs(args) {
    if (args.length !== 8) fail('MAC_RELEASE_INPUT_INVALID');
    const [arch, version, teamId, identity, profile, runtime, license, output] = args;
    return { arch, version, teamId, identity, profile, runtime, license, output };
}
if (require.main === module) Promise.resolve().then(() => buildCandidate(parseArgs(process.argv.slice(2)))).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { const stage = /^[a-z_]+$/.test(String(error?.stage || '')) ? ` stage=${error.stage}` : '';
        process.stderr.write(`${/^MAC_RELEASE_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'MAC_RELEASE_FAILED'}${stage}\n`); process.exitCode = 1; });
module.exports = { buildCandidate, buildBraveCandidate, buildFirefoxCandidate, validateOptions, parseArgs, publishCandidate, releaseEnvironment };
