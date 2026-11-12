'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

test('experimental Mac Firefox app uses only its own profile and requires verified input paths', async () => {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/firefox-mac-app.js'), 'utf8');
    const module = { exports: {} }, calls = [];
    const dependencies = {
        './chrome-mac-app': { async ensureMacSetupDirectory(input) { calls.push(['base', input]); return '/support/XNotificationSetup'; } },
        './chrome-mac-profile-registry': { async getOrCreateMacFirefoxProfile(input) { calls.push(['firefox', input]); return { rootPath: '/owned', profileId: 'fixture' }; } },
        './firefox-mac-setup-session': { async runExperimentalMacFirefoxSetup(input) { calls.push(['session', input]); return { state: 'cancelled' }; } },
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: name => dependencies[name] || require(name), AbortSignal });
    const options = { applicationSupport: '/support', helperPath: '/app/helper', expectedSha256: 'a'.repeat(64),
        bootstrapPath: '/app/bootstrap', bootstrapSha256: 'b'.repeat(64), readerPath: '/app/reader', readerSha256: 'c'.repeat(64),
        ui: {}, experimental: true };
    assert.equal((await module.exports.runExperimentalMacFirefoxApp(options)).state, 'cancelled');
    assert.equal(calls[1][0], 'firefox'); assert.equal(calls[2][1].rootPath, '/owned'); assert.equal(calls[2][1].experimental, true);
    calls.length = 0;
    await assert.rejects(module.exports.runExperimentalMacFirefoxApp({ ...options, experimental: false }), { code: 'X_FIREFOX_MAC_APP_INVALID' });
    await assert.rejects(module.exports.runExperimentalMacFirefoxApp({ ...options, readerPath: 'relative' }), { code: 'X_FIREFOX_MAC_APP_INVALID' });
    await assert.rejects(module.exports.runExperimentalMacFirefoxApp({ ...options, bootstrapSha256: 'invalid' }), { code: 'X_FIREFOX_MAC_APP_INVALID' });
    await assert.rejects(module.exports.runExperimentalMacFirefoxApp({ ...options, signal: {} }), { code: 'X_FIREFOX_MAC_APP_INVALID' });
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await module.exports.runExperimentalMacFirefoxApp({ ...options, signal: aborted.signal })).state, 'cancelled');
    assert.equal(calls.length, 0);
});
