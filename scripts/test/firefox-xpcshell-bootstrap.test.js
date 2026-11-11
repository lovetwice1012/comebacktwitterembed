'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { encodeMacFirefoxReaderInput } = require('../../src/automation/firefox-mac-reader-protocol');
const source = fs.readFileSync(path.join(__dirname, '../../client/angelic-setup/mac/FirefoxXPCShellReader.js'), 'utf8');
const token = 'a'.repeat(32), parent = '/synthetic/setup';
const defaults = { CBTE_GECKO_SNAPSHOT: `${parent}/firefox-snapshot-${token}`,
    CBTE_GECKO_RESULT: `${parent}/firefox-result-${token}.json`, CBTE_GECKO_READER: '/trusted/Read-PushSubscription.js',
    CBTE_GECKO_READER_SHA256: 'aa'.repeat(32), CBTE_GECKO_UAID: '0123456789abcdef0123456789abcdef', CBTE_GECKO_VERSION: '160.0' };
function invoke(changes = {}, existing = false, linkedReader = false, inputLines = []) {
    const values = { ...defaults, ...changes }; let touchedProfile = false;
    let inputIndex = 0;
    class File {
        initWithPath(name) { this.path = name; }
        get leafName() { return path.posix.basename(this.path); }
        get parent() { const file = new File(); file.path = path.posix.dirname(this.path); return file; }
        equals(other) { return this.path === other.path; }
        isDirectory() { return true; }
        isFile() { return true; }
        isSymlink() { return linkedReader; }
        get fileSize() { return 10; }
        get lastModifiedTime() { return 10; }
        exists() { return existing; }
    }
    const context = { Cc: { '@mozilla.org/file/local;1': { createInstance: () => new File() },
        '@mozilla.org/network/file-input-stream;1': { createInstance: () => ({ init() {}, close() {} }) },
        '@mozilla.org/binaryinputstream;1': { createInstance: () => ({ setInputStream() {}, readByteArray: () => Array(10).fill(65) }) },
        '@mozilla.org/security/hash;1': { createInstance: () => ({ SHA256: 1, init() {}, update() {}, finish: () => String.fromCharCode(0xaa).repeat(32) }) } },
        Ci: { nsIFile: {}, nsIFileInputStream: {}, nsIBinaryInputStream: {}, nsICryptoHash: {}, nsIDirectoryService: {} },
        Cu: { importGlobalProperties() {} }, TextDecoder, Uint8Array,
        readline: () => inputLines[inputIndex++] ?? null,
        atob: value => Buffer.from(value, 'base64').toString('latin1'), btoa: value => Buffer.from(value, 'latin1').toString('base64'),
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
        { CBTE_GECKO_READER: '/trusted/other.js' }, { CBTE_GECKO_READER_SHA256: 'ab'.repeat(32) },
        { CBTE_GECKO_READER_SHA256: 'bad' }, { CBTE_GECKO_UAID: 'bad' },
        { CBTE_GECKO_VERSION: '160.0\nmalicious' }, { CBTE_GECKO_VERSION: 'x'.repeat(65) },
    ]) {
        const result = invoke(changes); assert.match(String(result.failure), /X_FIREFOX_MAC_READER_INVALID/);
        assert.equal(result.touchedProfile, false);
    }
    const existing = invoke({}, true); assert.match(String(existing.failure), /X_FIREFOX_MAC_READER_INVALID/);
    assert.equal(existing.touchedProfile, false);
    const linked = invoke({}, false, true); assert.match(String(linked.failure), /X_FIREFOX_MAC_READER_INVALID/);
    assert.equal(linked.touchedProfile, false);
    const valid = invoke(); assert.match(String(valid.failure), /SYNTHETIC_VALIDATION_REACHED/);
    assert.equal(valid.touchedProfile, true);
});
test('Gecko private stdin validates framing before opening the profile', () => {
    const input = { snapshotPath: defaults.CBTE_GECKO_SNAPSHOT, resultPath: defaults.CBTE_GECKO_RESULT,
        readerPath: defaults.CBTE_GECKO_READER, readerSha256: defaults.CBTE_GECKO_READER_SHA256,
        uaid: defaults.CBTE_GECKO_UAID, browserVersion: defaults.CBTE_GECKO_VERSION };
    const encoded = encodeMacFirefoxReaderInput(input), lines = encoded.toString('ascii').trimEnd().split('\n'); encoded.fill(0);
    const valid = invoke({ CBTE_GECKO_INPUT: 'stdin-v1' }, false, false, lines);
    assert.match(String(valid.failure), /SYNTHETIC_VALIDATION_REACHED/); assert.equal(valid.touchedProfile, true);
    const extra = Buffer.from(JSON.stringify({ ...input, extra: 'not-allowed' })).toString('base64');
    for (const broken of [['0'], ['65'], ['1'], ['1', 'bad!'], ['1', 'AA=='], ['1', extra], ['1', lines[1].slice(1)]]) {
        const result = invoke({ CBTE_GECKO_INPUT: 'stdin-v1' }, false, false, broken);
        assert.match(String(result.failure), /X_FIREFOX_MAC_READER_INVALID/); assert.equal(result.touchedProfile, false);
    }
});
test('Gecko executes the verified bytes even if the source path changes afterwards', () => {
    const safeSource = 'function ReadPushSubscription(){return {then(resolve){resolve({ok:false,errorCode:"SYNTHETIC"})}}}';
    const sourceBytes = Buffer.from(safeSource), values = { ...defaults,
        CBTE_GECKO_READER_SHA256: createHash('sha256').update(sourceBytes).digest('hex') };
    let diskSource = safeSource, written = '', exited = false, reopened = false;
    class File {
        initWithPath(name) { this.path = name; }
        get leafName() { return path.posix.basename(this.path); }
        get parent() { const file = new File(); file.path = path.posix.dirname(this.path); return file; }
        equals(other) { return this.path === other.path; }
        isDirectory() { return true; } isFile() { return true; } isSymlink() { return false; } exists() { return false; }
        get fileSize() { return sourceBytes.length; } get lastModifiedTime() { return 1; }
        clone() { const file = new File(); file.path = this.path; return file; }
    }
    const classes = {
        '@mozilla.org/file/local;1': { createInstance: () => new File() },
        '@mozilla.org/network/file-input-stream;1': { createInstance: () => ({ init() {}, close() {} }) },
        '@mozilla.org/binaryinputstream;1': { createInstance: () => ({ setInputStream() {}, readByteArray() {
            const captured = [...Buffer.from(diskSource)]; diskSource = 'throw new Error("REPLACEMENT_EXECUTED")'; return captured;
        } }) },
        '@mozilla.org/security/hash;1': { createInstance: () => ({ SHA256: 1, init() {}, update(bytes) { this.digest = createHash('sha256').update(Buffer.from(bytes)).digest(); },
            finish() { return this.digest.toString('latin1'); } }) },
        '@mozilla.org/network/file-output-stream;1': { createInstance: () => ({ init() {} }) },
        '@mozilla.org/intl/converter-output-stream;1': { createInstance: () => ({ init() {}, writeString(value) { written = value; }, close() {} }) },
    };
    const prefs = new Map(), services = { env: { get: name => values[name] }, appinfo: { OS: 'Darwin' }, io: { offline: false },
        prefs: { setBoolPref: (key, value) => prefs.set(key, value), getBoolPref: (key, fallback) => prefs.has(key) ? prefs.get(key) : fallback },
        dirsvc: { QueryInterface: () => ({ registerProvider() {} }), undefine() {} }, obs: { notifyObservers() {} },
        tm: { spinEventLoopUntil(_reason, done) { assert.equal(done(), true); } } };
    const context = { Cc: classes, Ci: {}, Cu: { importGlobalProperties() {} }, ChromeUtils: { generateQI: () => () => {} },
        Services: services, TextDecoder, Uint8Array, quit() { exited = true; }, load() { reopened = true; throw new Error('UNEXPECTED_REOPEN'); } };
    vm.runInNewContext(source, context);
    assert.equal(exited, true); assert.equal(reopened, false); assert.match(diskSource, /REPLACEMENT_EXECUTED/);
    assert.deepEqual(JSON.parse(written), { ok: false, errorCode: 'SYNTHETIC' });
});
