/*
 * Experimental local Firefox XPCShell reader. A trusted parent must verify
 * the Firefox signature, script hashes, snapshot ownership and private output
 * directory, sanitize the environment, and stop the entire child process tree.
 * This script does not upload or log the subscription data.
 */
'use strict';
const localFile = value => {
    const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    file.initWithPath(value); return file;
};
const snapshot = localFile(Services.env.get('CBTE_GECKO_SNAPSHOT'));
const resultFile = localFile(Services.env.get('CBTE_GECKO_RESULT'));
const readerFile = localFile(Services.env.get('CBTE_GECKO_READER'));
const uaid = Services.env.get('CBTE_GECKO_UAID');
const browserVersion = Services.env.get('CBTE_GECKO_VERSION');
const token = /^firefox-snapshot-([0-9a-f]{32})$/.exec(snapshot.leafName);
if (!token || !snapshot.parent || !resultFile.parent || !resultFile.parent.equals(snapshot.parent)
    || resultFile.leafName !== `firefox-result-${token[1]}.json` || readerFile.leafName !== 'Read-PushSubscription.js'
    || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.test(uaid)
    || !/^[0-9A-Za-z._+-]{1,64}$/.test(browserVersion) || !snapshot.isDirectory() || resultFile.exists())
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
load(readerFile.path);
function writeResult(value) {
    const text = JSON.stringify(value);
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
