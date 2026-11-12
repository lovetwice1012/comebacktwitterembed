'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const { classifyCodesign } = require('../native-test/brave-mac-install-diagnostic.cjs');
const { classifyFailure } = require('../native-test/brave-mac-verifier-diagnostic.cjs');
test('Brave signature diagnostic emits fixed categories without raw output', () => {
    assert.equal(classifyCodesign({ status: 0, stderr: 'sensitive-output' }), 'valid');
    assert.equal(classifyCodesign({ status: 1, stderr: 'sensitive-output' }), 'rejected');
    assert.equal(classifyCodesign({ status: null, error: { code: 'ETIMEDOUT', message: 'sensitive-output' } }), 'timeout');
    assert.equal(classifyCodesign({ status: null, signal: 'SIGTERM', stderr: 'sensitive-output' }), 'terminated');
    assert.equal(classifyCodesign({ status: null, error: { code: 'ENOENT', message: 'sensitive-output' } }), 'unavailable');
});
test('Brave verification diagnostics keep failures in bounded categories', () => {
    assert.equal(classifyFailure(null), 'ok');
    assert.equal(classifyFailure({ code: 'ETIMEDOUT', message: 'secret' }), 'timeout');
    assert.equal(classifyFailure({ killed: true, signal: 'SIGTERM', message: 'secret' }), 'terminated');
    assert.equal(classifyFailure({ code: 1, stderr: 'secret' }), 'rejected');
    assert.equal(classifyFailure({ code: 'ENOENT', path: 'secret' }), 'missing');
    assert.equal(classifyFailure({ code: 'EACCES', path: 'secret' }), 'denied');
    assert.equal(classifyFailure({ code: 'unexpected', message: 'secret' }), 'other');
});
test('diagnostic preserves strict verification and identifies the original failed stage', async () => {
    const helper = fs.readFileSync(path.join(__dirname, '../native-test/brave-mac-verifier-diagnostic.cjs'), 'utf8');
    const verifier = fs.readFileSync(path.join(__dirname, '../../src/automation/brave-mac-browser.js'), 'utf8');
    for (const failure of ['first_signature', 'second_signature', 'post_identity']) {
        let signature = 0, inspections = 0; const events = [], calls = [];
        const fakeFs = { async readFile() { return verifier; }, async lstat(name) {
            inspections++; return { dev: 1, ino: 10, size: 100, mtimeMs: failure === 'post_identity' && inspections > 3 ? 2 : 1, ctimeMs: 1,
                isSymbolicLink: () => false, isDirectory: () => name.endsWith('.app'), isFile: () => !name.endsWith('.app') };
        }, async realpath(name) { return name; } };
        function execFile() {}
        execFile[util.promisify.custom] = async (file, args) => {
            calls.push({ file, args });
            if (file === '/usr/bin/codesign') {
                signature++;
                if (failure === 'first_signature' && signature === 1 || failure === 'second_signature' && signature === 2)
                    throw Object.assign(new Error('secret stderr'), { code: 1 });
                return { stdout: '', stderr: '' };
            }
            return { stdout: '157.1.2.3\n', stderr: '' };
        };
        const module = { exports: {} };
        vm.runInNewContext(helper, { module, exports: module.exports, __dirname: path.join(__dirname, '../native-test'),
            process: { platform: 'darwin', env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', CBTE_MAC_BRAVE_HOSTED: '1' } },
            require(name) { if (name === 'node:fs/promises') return fakeFs; if (name === 'node:child_process') return { execFile };
                if (name === './brave-mac-install-diagnostic.cjs') return { snapshotBraveInstallation: async () => 'synthetic' };
                return require(name); } });
        const verify = await module.exports.createInstrumentedBraveVerifier({ diagnostic: text => events.push(text) });
        await assert.rejects(verify(), { code: 'X_BRAVE_MAC_BROWSER_INVALID' });
        assert(calls.filter(call => call.file === '/usr/bin/codesign').every(call => call.args.includes('--deep') && call.args.includes('--strict') && call.args.includes('-R')));
        if (failure === 'first_signature') assert(events.some(event => event.includes('signature=1 result=rejected')));
        if (failure === 'second_signature') assert(events.some(event => event.includes('signature=2 result=rejected')));
        if (failure === 'post_identity') assert(events.some(event => event.includes('inspection=post_app_lstat') && event.includes('stableSincePre=false')));
        assert(!JSON.stringify(events).includes('secret'));
    }
});
