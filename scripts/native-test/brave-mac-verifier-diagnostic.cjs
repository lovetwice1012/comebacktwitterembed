'use strict';

// CI-only instrumentation of the unchanged installed-browser verifier. It
// delegates every filesystem and signature check to the real OS APIs and
// emits fixed stages and booleans only, never tool output or profile data.
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const child = require('node:child_process');
const util = require('node:util');
const { snapshotBraveInstallation } = require('./brave-mac-install-diagnostic.cjs');
const realExec = util.promisify(child.execFile);
const APP = '/Applications/Brave Browser.app';
const ROLES = new Map([[APP, 'app'], [path.join(APP, 'Contents/MacOS/Brave Browser'), 'executable'],
    [path.join(APP, 'Contents/Info.plist'), 'plist']]);
function classifyFailure(error) {
    if (!error) return 'ok';
    if (error.code === 'ETIMEDOUT') return 'timeout';
    if (typeof error.signal === 'string' && error.signal.length) return 'terminated';
    if (Number.isInteger(error.code)) return 'rejected';
    if (error.code === 'ENOENT') return 'missing';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'denied';
    return 'other';
}
async function createInstrumentedBraveVerifier(t) {
    if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true'
        || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.CBTE_MAC_BRAVE_HOSTED !== '1')
        throw new Error('FIXTURE_VERIFIER_UNAVAILABLE');
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/brave-mac-browser.js'), 'utf8');
    return async () => {
        const events = [], beforeStats = new Map(); let signatureChecks = 0;
        const phase = () => signatureChecks >= 2 ? 'post' : 'pre';
        const wrappedFs = { ...fs,
            async lstat(name) {
                const role = ROLES.get(name) || 'unexpected';
                try {
                    const stat = await fs.lstat(name);
                    const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
                    if (phase() === 'pre') beforeStats.set(role, fingerprint);
                    const before = phase() === 'post' ? beforeStats.get(role) : null;
                    const differences = ['dev', 'inode', 'size', 'mtime', 'ctime'].map((name, index) =>
                        `${name}Changed=${before ? String(before[index] !== fingerprint[index]) : 'unknown'}`);
                    const stable = before ? String(before.every((value, index) => value === fingerprint[index])) : 'unknown';
                    events.push(`inspection=${phase()}_${role}_lstat symlink=${stat.isSymbolicLink()} kind=${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'} stableSincePre=${stable} ${differences.join(' ')}`);
                    return stat;
                } catch (error) { events.push(`inspection=${phase()}_${role}_lstat result=${classifyFailure(error)}`); throw error; }
            },
            async realpath(name) {
                const role = ROLES.get(name) || 'unexpected';
                try {
                    const actual = await fs.realpath(name);
                    events.push(`inspection=${phase()}_${role}_realpath unchanged=${actual === name}`);
                    return actual;
                } catch (error) { events.push(`inspection=${phase()}_${role}_realpath result=${classifyFailure(error)}`); throw error; }
            } };
        function execFile() { throw new Error('FIXTURE_PROMISIFY_EXPECTED'); }
        execFile[util.promisify.custom] = async (file, args, options) => {
            const isSignature = file === '/usr/bin/codesign';
            const number = isSignature ? ++signatureChecks : 0;
            const before = isSignature ? await snapshotBraveInstallation() : null;
            let result, failure;
            try { result = await realExec(file, args, options); return result; }
            catch (error) { failure = error; throw error; }
            finally {
                if (isSignature) {
                    const after = await snapshotBraveInstallation();
                    const changed = before === null || after === null ? 'unknown' : before === after ? 'false' : 'true';
                    events.push(`signature=${number} result=${classifyFailure(failure)} metadataChanged=${changed}`);
                } else {
                    const version = typeof result?.stdout === 'string' ? result.stdout.replace(/\r?\n$/, '') : '';
                    const valid = /^[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/.test(version);
                    events.push(`versionExtraction result=${classifyFailure(failure)} formatValid=${valid}`);
                }
            }
        };
        const module = { exports: {} };
        vm.runInNewContext(source, { module, exports: module.exports, process,
            require(name) {
                if (name === 'node:fs/promises') return wrappedFs;
                if (name === 'node:child_process') return { execFile };
                if (name === 'node:path') return path;
                if (name === 'node:util') return util;
                throw new Error('FIXTURE_UNEXPECTED_REQUIRE');
            } });
        try { return await module.exports.verifyInstalledMacBrave(); }
        catch (error) {
            for (const event of events) t.diagnostic(`synthetic Brave verification ${event}`);
            throw error;
        }
    };
}
module.exports = { createInstrumentedBraveVerifier, classifyFailure };
