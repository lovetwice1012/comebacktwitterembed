/* Synthetic-only XPCShell probe; never use an ordinary browser profile. */
'use strict';
const directory = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
directory.initWithPath(Services.env.get('CBTE_SYNTHETIC_PROFILE'));
if (directory.leafName !== 'profile' || !directory.parent
    || !/^cbte-xpcshell-isolated-[0-9a-f]{32}$/.test(directory.parent.leafName))
    throw new Error('SYNTHETIC_PROFILE_REQUIRED');
const provider = {
    getFile(key, persistent) {
        persistent.value = true;
        return ['ProfD', 'ProfLD', 'ProfDS', 'ProfLDS', 'TmpD'].includes(key) ? directory.clone() : null;
    },
    QueryInterface: ChromeUtils.generateQI(['nsIDirectoryServiceProvider']),
};
Services.dirsvc.QueryInterface(Ci.nsIDirectoryService).registerProvider(provider);
try { Services.dirsvc.undefine('TmpD'); } catch { /* Key may not yet be set. */ }
Services.obs.notifyObservers(null, 'profile-do-change', 'xpcshell-do-get-profile');
Services.io.offline = true;
Services.prefs.setBoolPref('dom.push.enabled', false);
Cu.importGlobalProperties(['indexedDB', 'crypto', 'URL', 'TextEncoder']);
// XPCShell provides the OS but not an application version. This synthetic
// value exercises the reader only; a product must establish the real version.
const osName = Services.appinfo.OS;
Object.defineProperty(Services, 'appinfo', { value: { OS: osName, version: '160.0-synthetic' } });
load(Services.env.get('CBTE_SYNTHETIC_READER'));
function report(status) {
    const target = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    target.initWithPath(Services.env.get('CBTE_SYNTHETIC_RESULT'));
    if (target.leafName !== 'result.txt' || !target.parent.equals(directory.parent)) throw new Error('SYNTHETIC_RESULT_REQUIRED');
    const output = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    output.init(target, 0x8a, 0o600, 0);
    const writer = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
    writer.init(output, 'UTF-8'); writer.writeString(status); writer.close();
}
let done = false;
(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const authenticationSecret = crypto.getRandomValues(new Uint8Array(16));
    await new Promise((resolve, reject) => {
        const request = indexedDB.openForPrincipal(Services.scriptSecurityManager.getSystemPrincipal(), 'pushapi', 5);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore('pushapi', { keyPath: 'channelID' });
            store.createIndex('identifiers', ['scope', 'originAttributes'], { unique: true });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result, tx = db.transaction('pushapi', 'readwrite');
            tx.objectStore('pushapi').put({ channelID: '11111111-1111-4111-8111-111111111111', scope: 'https://x.com/',
                originAttributes: '', systemRecord: false,
                pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-NOT-A-SUBSCRIPTION',
                p256dhPublicKey: publicKey, p256dhPrivateKey: privateKey, authenticationSecret });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
    });
    const result = await ReadPushSubscription({ uaid: '22222222-2222-4222-8222-222222222222', expectedProfilePath: directory.path });
    if (!result.ok || result.otherSubscriptionCount !== 0 || result.export?.push?.scope !== 'https://x.com/')
        throw new Error(`READER_${result.errorCode || 'INVALID'}`);
    report('CBTE_SYNTHETIC_READ_OK'); done = true;
})().catch(error => { report(`CBTE_SYNTHETIC_READ_FAILED:${error.message}`); done = true; });
Services.tm.spinEventLoopUntil('cbte-synthetic-reader-test', () => done);
quit(0);
