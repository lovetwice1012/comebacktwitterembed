/*
 * Experimental local Firefox XPCShell reader. A trusted parent must verify
 * the Firefox signature, script hashes, snapshot ownership and private output
 * directory, sanitize the environment, and stop the entire child process tree.
 * This script does not upload or log the subscription data.
 */
/* global Cc, Ci, Cu, Services, ChromeUtils, quit, readline, atob, btoa */
'use strict';
function readConfiguration() {
    if (Services.env.get('CBTE_GECKO_INPUT') !== 'stdin-v1') return {
        snapshotPath: Services.env.get('CBTE_GECKO_SNAPSHOT'), resultPath: Services.env.get('CBTE_GECKO_RESULT'),
        readerPath: Services.env.get('CBTE_GECKO_READER'), readerSha256: Services.env.get('CBTE_GECKO_READER_SHA256'),
        uaid: Services.env.get('CBTE_GECKO_UAID'), browserVersion: Services.env.get('CBTE_GECKO_VERSION'),
    };
    const count = readline();
    if (typeof count !== 'string' || !/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(count)) throw new Error('X_FIREFOX_MAC_READER_INVALID');
    let encoded = '';
    for (let index = 0; index < Number(count); index++) {
        const line = readline();
        if (typeof line !== 'string' || !/^[A-Za-z0-9+/=]{1,512}$/.test(line)) throw new Error('X_FIREFOX_MAC_READER_INVALID');
        encoded += line;
    }
    let bytes;
    try {
        const binary = atob(encoded);
        if (!binary.length || binary.length > 24576 || btoa(binary) !== encoded) throw new Error();
        bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        Cu.importGlobalProperties(['TextDecoder']);
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).sort().join(',') !== 'browserVersion,readerPath,readerSha256,resultNonce,resultPath,snapshotPath,uaid'
            || Object.values(value).some(item => typeof item !== 'string') || !/^[0-9a-f]{64}$/.test(value.resultNonce)) throw new Error();
        return value;
    } catch { throw new Error('X_FIREFOX_MAC_READER_INVALID'); }
    finally { bytes?.fill(0); }
}
const configuration = readConfiguration();
const localFile = value => {
    const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    file.initWithPath(value); return file;
};
const snapshot = localFile(configuration.snapshotPath);
const resultFile = localFile(configuration.resultPath);
const readerFile = localFile(configuration.readerPath);
const expectedReaderHash = configuration.readerSha256;
const uaid = configuration.uaid;
const browserVersion = configuration.browserVersion;
const token = /^firefox-snapshot-([0-9a-f]{32})$/.exec(snapshot.leafName);
if (!token || !snapshot.parent || !resultFile.parent || !resultFile.parent.equals(snapshot.parent)
    || resultFile.leafName !== `firefox-result-${token[1]}.json` || readerFile.leafName !== 'Read-PushSubscription.js'
    || !/^[0-9a-f]{64}$/.test(expectedReaderHash)
    || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.test(uaid)
    || !/^[0-9A-Za-z._+-]{1,64}$/.test(browserVersion) || !snapshot.isDirectory() || resultFile.exists())
    throw new Error('X_FIREFOX_MAC_READER_INVALID');
// The parent supplies the digest from its verified package manifest. Reject
// missing, linked, oversized or altered reader scripts before opening a DB.
if (!readerFile.isFile() || readerFile.isSymlink() || readerFile.fileSize < 1 || readerFile.fileSize > 1024 * 1024)
    throw new Error('X_FIREFOX_MAC_READER_INVALID');
const beforeSize = readerFile.fileSize, beforeModified = readerFile.lastModifiedTime;
const input = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
let readerDigest, readerSource;
try {
    input.init(readerFile, 0x01, 0, 0);
    const binary = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
    binary.setInputStream(input);
    const bytes = binary.readByteArray(beforeSize);
    if (bytes.length !== beforeSize) throw new Error('X_FIREFOX_MAC_READER_INVALID');
    const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256); hash.update(bytes, bytes.length);
    readerDigest = Array.from(hash.finish(false), ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    Cu.importGlobalProperties(['TextDecoder']);
    readerSource = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    bytes.fill(0);
} finally { input.close(); }
if (readerDigest !== expectedReaderHash || readerFile.fileSize !== beforeSize || readerFile.lastModifiedTime !== beforeModified)
    throw new Error('X_FIREFOX_MAC_READER_INVALID');
const provider = {
    getFile(key, persistent) {
        persistent.value = true;
        return ['ProfD', 'ProfLD', 'ProfDS', 'ProfLDS', 'TmpD'].includes(key) ? snapshot.clone() : null;
    },
    QueryInterface: ChromeUtils.generateQI(['nsIDirectoryServiceProvider']),
};
Services.dirsvc.QueryInterface(Ci.nsIDirectoryService).registerProvider(provider);
try { Services.dirsvc.undefine('TmpD'); } catch { /* Not initialized yet. */ }
Services.io.offline = true;
Services.prefs.setBoolPref('dom.push.enabled', false);
Services.prefs.setBoolPref('network.manage-offline-status', false);
Services.prefs.setBoolPref('network.disable.non-local-connections', true);
Services.obs.notifyObservers(null, 'profile-do-change', 'xpcshell-do-get-profile');
if (Services.io.offline !== true || Services.prefs.getBoolPref('dom.push.enabled', true) !== false)
    throw new Error('X_FIREFOX_MAC_READER_INVALID');
Cu.importGlobalProperties(['indexedDB', 'crypto', 'URL', 'TextEncoder']);
const osName = Services.appinfo.OS;
if (!['Darwin', 'WINNT'].includes(osName)) throw new Error('X_FIREFOX_MAC_READER_INVALID');
// XPCShell does not expose the Firefox application version. The parent must
// derive this value from the verified, signed application before launching.
Object.defineProperty(Services, 'appinfo', { value: { OS: osName, version: browserVersion } });
// Execute the exact bytes that were hashed; do not reopen the path after the
// check. The caller must still verify this bootstrap and its manifest.
const ReadPushSubscription = new Function(`${readerSource}\nreturn ReadPushSubscription;`)();
readerSource = null;
function writeResult(value) {
    const text = JSON.stringify(configuration.resultNonce ? { ...value, proof: configuration.resultNonce } : value);
    if (text.length > 32768) throw new Error('X_FIREFOX_MAC_READER_INVALID');
    const stream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    stream.init(resultFile, 0x8a, 0o600, 0);
    const writer = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
    writer.init(stream, 'UTF-8'); writer.writeString(text); writer.close();
}
let done = false;
function finish(value) { try { writeResult(value); } finally { done = true; } }
ReadPushSubscription({ uaid, expectedProfilePath: snapshot.path }).then(result => {
    finish(result);
}, () => { finish({ ok: false, errorCode: 'X_EXPORT_OPERATION_FAILED' }); });
Services.tm.spinEventLoopUntil('x-notification-local-reader', () => done);
quit(0);
