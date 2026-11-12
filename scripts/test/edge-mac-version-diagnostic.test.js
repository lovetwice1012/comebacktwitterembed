'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createInstrumentedVerifier, createHostedVersionDiagnostic, formatVersionDiagnostics } = require('../native-test/edge-mac-version-diagnostic.cjs');

function fixture({ signatureTimeout = false, badVersion = false, replaced = false } = {}) {
    let clock = 0; const events = [], root = path.resolve(__dirname, '../..');
    const brokerSource = fs.readFileSync(path.join(root, 'src/automation/edge-mac-broker.js'), 'utf8');
    const versionSource = fs.readFileSync(path.join(root, 'src/automation/edge-mac-browser-version.js'), 'utf8');
    const fsApi = {
        async lstat(name) { events.push('stat'); const dir = name === '/Applications/Microsoft Edge.app';
            return { isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false, dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 }; },
        async realpath(name) { return replaced && name.endsWith('Info.plist') ? '/other/private-path' : name; },
    };
    function execFile(file, _args, _options, callback) {
        events.push(file === '/usr/bin/codesign' ? 'codesign' : 'plutil');
        if (file === '/usr/bin/codesign' && signatureTimeout) {
            clock += 120000; return setImmediate(() => callback(Object.assign(new Error('private-output'), { killed: true, signal: 'SIGTERM' }), '', 'private-output'));
        }
        return setImmediate(() => callback(null, file === '/usr/bin/plutil' ? badVersion ? 'private-version' : '157.0.1234.5\n' : '', ''));
    }
    function fallbackRequire(name) {
        if (name === 'node:path') return path.posix;
        if (name === 'node:child_process') return { spawn() { throw new Error('must not launch'); } };
        if (name.startsWith('./')) return {};
        return require(name);
    }
    const diagnostic = createInstrumentedVerifier({ fsApi, execFile, brokerSource, versionSource, fallbackRequire,
        processValue: { platform: 'darwin' }, clock: () => clock });
    return { diagnostic, events };
}
test('instrumentation runs the unchanged verification and records only fixed classifications', async () => {
    const f = fixture(); const result = await f.diagnostic.verify();
    assert.equal(result.browserVersion, '157.0.1234.5');
    const formatted = formatVersionDiagnostics(f.diagnostic.snapshot());
    assert.match(formatted, /codesign=valid:/); assert.match(formatted, /plist_extract=valid:/);
    assert(!formatted.includes('157.0.1234.5') && !formatted.includes('/Applications/'));
    assert.equal(f.events.filter(value => value === 'codesign').length, 2);
});
test('timeout, malformed plist and replaced path remain failures without leaking tool output', async () => {
    for (const [options, expected] of [[{ signatureTimeout: true }, /codesign=timeout:120000ms/],
        [{ badVersion: true }, /plist_extract=invalid_version:/], [{ replaced: true }, /plist_realpath=changed:/]]) {
        const f = fixture(options); await assert.rejects(f.diagnostic.verify(), { code: 'X_EDGE_MAC_BROWSER_INVALID' });
        const formatted = formatVersionDiagnostics(f.diagnostic.snapshot()); assert.match(formatted, expected);
        assert(!formatted.includes('private') && !formatted.includes('/other/'));
    }
});
test('formatting rejects untrusted kinds, outcomes, values and extra fields', () => {
    for (const value of [[{ kind: 'codesign', outcome: 'SECRET', ms: 1 }], [{ kind: '/private', outcome: 'valid', ms: 1 }],
        [{ kind: 'codesign', outcome: 'valid', ms: -1 }], [{ kind: 'codesign', outcome: 'valid', ms: 1, token: 'secret' }], null])
        assert.equal(formatVersionDiagnostics(value), 'unavailable');
});
test('the hosted diagnostic cannot read local applications outside a hosted Mac', () => {
    if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
        && process.env.CBTE_MAC_EDGE_HOSTED === '1') return;
    assert.throws(() => createHostedVersionDiagnostic(), /FIXTURE_DIAGNOSTIC_ENVIRONMENT_INVALID/);
});
