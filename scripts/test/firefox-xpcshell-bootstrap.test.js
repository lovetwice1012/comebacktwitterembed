'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../client/angelic-setup/mac/FirefoxXPCShellReader.js'), 'utf8');
const token = 'a'.repeat(32), parent = '/synthetic/setup';
const defaults = { CBTE_GECKO_SNAPSHOT: `${parent}/firefox-snapshot-${token}`,
    CBTE_GECKO_RESULT: `${parent}/firefox-result-${token}.json`, CBTE_GECKO_READER: '/trusted/Read-PushSubscription.js',
    CBTE_GECKO_UAID: '0123456789abcdef0123456789abcdef', CBTE_GECKO_VERSION: '160.0' };
function invoke(changes = {}, existing = false) {
    const values = { ...defaults, ...changes }; let touchedProfile = false;
    class File {
        initWithPath(name) { this.path = name; }
        get leafName() { return path.posix.basename(this.path); }
        get parent() { const file = new File(); file.path = path.posix.dirname(this.path); return file; }
        equals(other) { return this.path === other.path; }
        isDirectory() { return true; }
        exists() { return existing; }
    }
    const context = { Cc: { '@mozilla.org/file/local;1': { createInstance: () => new File() } }, Ci: { nsIFile: {}, nsIDirectoryService: {} },
        ChromeUtils: { generateQI: () => () => {} }, Services: { env: { get: name => values[name] },
            dirsvc: { QueryInterface: () => ({ registerProvider() { touchedProfile = true; throw new Error('SYNTHETIC_VALIDATION_REACHED'); } }) } } };
    let failure;
    try { vm.runInNewContext(source, context); } catch (error) { failure = error; }
    return { failure, touchedProfile };
}
test('Gecko bootstrap rejects unsafe file identities and malformed metadata before opening the profile', () => {
    for (const changes of [
        { CBTE_GECKO_SNAPSHOT: '/synthetic/setup/user-profile' },
        { CBTE_GECKO_RESULT: `/other/firefox-result-${token}.json` },
        { CBTE_GECKO_RESULT: `${parent}/firefox-result-${'b'.repeat(32)}.json` },
        { CBTE_GECKO_READER: '/trusted/other.js' }, { CBTE_GECKO_UAID: 'bad' },
        { CBTE_GECKO_VERSION: '160.0\nmalicious' }, { CBTE_GECKO_VERSION: 'x'.repeat(65) },
    ]) {
        const result = invoke(changes); assert.match(String(result.failure), /X_FIREFOX_MAC_READER_INVALID/);
        assert.equal(result.touchedProfile, false);
    }
    const existing = invoke({}, true); assert.match(String(existing.failure), /X_FIREFOX_MAC_READER_INVALID/);
    assert.equal(existing.touchedProfile, false);
    const valid = invoke(); assert.match(String(valid.failure), /SYNTHETIC_VALIDATION_REACHED/);
    assert.equal(valid.touchedProfile, true);
});
