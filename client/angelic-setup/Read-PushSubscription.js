/*
 * Firefoxの隔離コピーでだけ動かす、通知情報の読み取り専用アダプターです。
 * 固定のFirefox AutoConfigから読み込み、次の関数を一度だけ呼びます。
 * await ReadPushSubscription({ uaid, expectedProfilePath })
 * 戻り値はPromiseです。リモート制御用のポートやコールバックは必要ありません。
 *
 * 実行前にPowerShell側で確認すること:
 * - 元は、このツールが作成・所有を確認した専用プロファイルで、Firefoxが停止済み。
 * - 作業用コピーはPush DB関連だけ。Cookie・保存パスワード・履歴をコピーしない。
 * - 作業用Firefoxの通信を制限し、第三者が制御接続を使えないことを確認する。
 * - 戻り値は秘密情報として扱い、画面・標準出力・ログへ出さず保護した新規ファイルへ保存。
 * このJSだけでOSの通信制限や元プロファイルの所有権を証明するものではありません。
 *
 * 読み取りはGecko自身のIndexedDBで行います。PushServiceの起動、購読の登録・解除、
 * 履歴参照、外部通信、アップロード、ファイル保存は一切行いません。
 * このファイルの利用条件は、同梱のLICENSEを参照してください。
 */
/* exported ReadPushSubscription */
async function ReadPushSubscription(input) {
    'use strict';
    return new Promise(resolve => {
    const ERROR_CODES = new Set([
        'X_EXPORT_ARGUMENTS_INVALID', 'X_EXPORT_CONTEXT_UNAVAILABLE', 'X_EXPORT_PROFILE_MISMATCH',
        'X_EXPORT_OFFLINE_REQUIRED', 'X_EXPORT_PUSH_MUST_BE_DISABLED', 'X_EXPORT_BROWSER_UNSUPPORTED',
        'X_EXPORT_DATABASE_MISSING', 'X_EXPORT_DATABASE_VERSION', 'X_EXPORT_DATABASE_FORMAT',
        'X_EXPORT_DATABASE_BUSY', 'X_EXPORT_DATABASE_FAILED', 'X_EXPORT_NO_SUBSCRIPTION',
        'X_EXPORT_OTHER_SUBSCRIPTIONS', 'X_EXPORT_TOO_MANY_SUBSCRIPTIONS', 'X_EXPORT_INVALID_RECORD',
        'X_EXPORT_INVALID_ID', 'X_EXPORT_INVALID_SCOPE', 'X_EXPORT_INVALID_ENDPOINT',
        'X_EXPORT_INVALID_KEYS', 'X_EXPORT_CRYPTO_UNAVAILABLE', 'X_EXPORT_TIMEOUT',
        'X_EXPORT_OPERATION_FAILED',
    ]);
    const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
    const ADAPTER_VERSION = '1.0.0';
    const MAX_METADATA_RECORDS = 64;
    // P-256の秘密scalarは0より大きく、曲線の位数より小さい必要があります。
    const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    let database = null;
    let completed = false;
    let timers;
    try { timers = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs'); }
    catch { resolve({ ok: false, errorCode: 'X_EXPORT_CONTEXT_UNAVAILABLE' }); return; }

    function fail(code) { throw Object.assign(new Error(code), { exportCode: code }); }
    function finish(result) {
        if (completed) return;
        completed = true;
        if (database) { try { database.close(); } catch { /* 終了時に秘密情報をログへ出さない。 */ } }
        resolve(result);
    }
    const timer = timers.setTimeout(() => finish({ ok: false, errorCode: 'X_EXPORT_TIMEOUT' }), 15000);

    function ownObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            && Object.prototype.toString.call(value) === '[object Object]';
    }
    function exactFields(value, fields, code) {
        if (!ownObject(value)) fail(code);
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const names = Object.keys(descriptors);
        if (names.length !== fields.length || Object.getOwnPropertySymbols(value).length
            || names.some(name => !fields.includes(name) || !Object.hasOwn(descriptors[name], 'value'))) fail(code);
    }
    function safePath(value) {
        if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.length > 32767
            || /[\u0000-\u001f]/.test(value) || value.slice(2).includes(':')) fail('X_EXPORT_ARGUMENTS_INVALID');
        const normalized = value.replace(/\//g, '\\').replace(/\\+$/, '');
        if (normalized.slice(3).split('\\').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part))) fail('X_EXPORT_ARGUMENTS_INVALID');
        return normalized.toLowerCase();
    }
    function validUaid(value) {
        if (typeof value !== 'string' || !(/^[0-9a-f]{32}$/.test(value) || UUID.test(value))) fail('X_EXPORT_INVALID_ID');
        // ハイフンを取り除くなど、保存されたUAIDを書き換える処理はしません。
        return value;
    }
    function canonicalUrl(value, code) {
        if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) fail(code);
        let parsed;
        try { parsed = new URL(value); } catch { fail(code); }
        if (parsed.href !== value || parsed.protocol !== 'https:' || parsed.username || parsed.password
            || parsed.port || parsed.hash || parsed.search) fail(code);
        return parsed;
    }
    function validScope(value) {
        const scope = canonicalUrl(value, 'X_EXPORT_INVALID_SCOPE');
        if (scope.origin !== 'https://x.com') fail('X_EXPORT_OTHER_SUBSCRIPTIONS');
        return value;
    }
    function encode(bytes) {
        return ChromeUtils.base64URLEncode(bytes, { pad: false });
    }
    function decode(value, length) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)
            || value.length !== Math.ceil(length * 4 / 3)) fail('X_EXPORT_INVALID_KEYS');
        let bytes;
        try { bytes = new Uint8Array(ChromeUtils.base64URLDecode(value, { padding: 'reject' })); }
        catch { fail('X_EXPORT_INVALID_KEYS'); }
        if (bytes.length !== length || encode(bytes) !== value) fail('X_EXPORT_INVALID_KEYS');
        return bytes;
    }
    function rawBytes(value, length) {
        const brand = Object.prototype.toString.call(value);
        let bytes;
        if (brand === '[object ArrayBuffer]') bytes = new Uint8Array(value);
        else if (brand === '[object Uint8Array]' && ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else fail('X_EXPORT_INVALID_KEYS');
        if (bytes.length !== length) fail('X_EXPORT_INVALID_KEYS');
        return new Uint8Array(bytes);
    }
    function equal(left, right) {
        if (left.length !== right.length) return false;
        let difference = 0;
        for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
        return difference === 0;
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            let rejectedCode = null;
            let request;
            try {
                // system principalのpushapiだけを開き、Xページの別DBへ接続しません。
                request = indexedDB.openForPrincipal(Services.scriptSecurityManager.getSystemPrincipal(), 'pushapi', 5);
            } catch { reject(Object.assign(new Error(), { exportCode: 'X_EXPORT_DATABASE_FAILED' })); return; }
            request.onupgradeneeded = event => {
                // 未作成DBや別schemaを更新して「読み取り成功」に見せません。
                rejectedCode = event.oldVersion === 0 ? 'X_EXPORT_DATABASE_MISSING' : 'X_EXPORT_DATABASE_VERSION';
                try { request.transaction.abort(); } catch { /* 既に中止済みなら追加操作不要。 */ }
            };
            request.onblocked = () => reject(Object.assign(new Error(), { exportCode: 'X_EXPORT_DATABASE_BUSY' }));
            request.onerror = event => {
                event.preventDefault();
                const code = rejectedCode || (request.error?.name === 'VersionError' ? 'X_EXPORT_DATABASE_VERSION' : 'X_EXPORT_DATABASE_FAILED');
                reject(Object.assign(new Error(), { exportCode: code }));
            };
            request.onsuccess = () => {
                const opened = request.result;
                if (completed || rejectedCode) { opened.close(); return; }
                if (opened.version !== 5 || opened.objectStoreNames.length !== 1 || !opened.objectStoreNames.contains('pushapi')) {
                    opened.close(); reject(Object.assign(new Error(), { exportCode: 'X_EXPORT_DATABASE_FORMAT' })); return;
                }
                database = opened;
                database.onversionchange = () => { database.close(); finish({ ok: false, errorCode: 'X_EXPORT_DATABASE_VERSION' }); };
                resolve(database);
            };
        });
    }

    function readOnlyXRecord(db) {
        return new Promise((resolve, reject) => {
            let transaction;
            let failureCode = null;
            let total = null;
            let cursorFinished = false;
            let valueRequested = false;
            let record;
            const metadata = [];
            let selectedMetadata;
            function stop(code) {
                if (!failureCode) failureCode = code;
                try { transaction.abort(); } catch { reject(Object.assign(new Error(), { exportCode: failureCode })); }
            }
            try {
                transaction = db.transaction('pushapi', 'readonly');
                // schema不一致ですぐabortする場合にも、必ず理由を返せるよう先に設定します。
                transaction.oncomplete = () => {
                    if (!valueRequested || !record) { reject(Object.assign(new Error(), { exportCode: 'X_EXPORT_INVALID_RECORD' })); return; }
                    resolve({ record, metadata: selectedMetadata, otherSubscriptionCount: metadata.length - 1 });
                };
                transaction.onabort = event => { event.preventDefault(); reject(Object.assign(new Error(), { exportCode: failureCode || 'X_EXPORT_DATABASE_FAILED' })); };
                transaction.onerror = event => { event.preventDefault(); stop('X_EXPORT_DATABASE_FAILED'); };
                const store = transaction.objectStore('pushapi');
                if (store.keyPath !== 'channelID' || store.autoIncrement || !store.indexNames.contains('identifiers')) { stop('X_EXPORT_DATABASE_FORMAT'); return; }
                const identifiers = store.index('identifiers');
                if (!identifiers.unique || !Array.isArray(identifiers.keyPath) || identifiers.keyPath.length !== 2
                    || identifiers.keyPath[0] !== 'scope' || identifiers.keyPath[1] !== 'originAttributes') { stop('X_EXPORT_DATABASE_FORMAT'); return; }

                function requestValueAfterMetadata() {
                    if (failureCode || valueRequested || total === null || !cursorFinished) return;
                    if (total !== metadata.length) { stop('X_EXPORT_DATABASE_FORMAT'); return; }
                    if (!total) { stop('X_EXPORT_NO_SUBSCRIPTION'); return; }
                    const xSubscriptions = metadata.filter(item => item.isX);
                    if (!xSubscriptions.length) { stop('X_EXPORT_NO_SUBSCRIPTION'); return; }
                    if (xSubscriptions.length !== 1) { stop('X_EXPORT_TOO_MANY_SUBSCRIPTIONS'); return; }
                    selectedMetadata = xSubscriptions[0];
                    valueRequested = true;
                    // 全recordの索引検査後、同じreadonly transactionでXの1件だけを読みます。
                    // 他サイトは索引の件数確認だけです。値・秘密鍵・通知本文は読みません。
                    const get = store.get(selectedMetadata.channelID);
                    get.onerror = event => { event.preventDefault(); stop('X_EXPORT_DATABASE_FAILED'); };
                    get.onsuccess = () => { record = get.result; };
                }
                const count = store.count();
                count.onerror = event => { event.preventDefault(); stop('X_EXPORT_DATABASE_FAILED'); };
                count.onsuccess = () => {
                    total = count.result;
                    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_METADATA_RECORDS) { stop('X_EXPORT_TOO_MANY_SUBSCRIPTIONS'); return; }
                    requestValueAfterMetadata();
                };
                // openKeyCursorなので、この段階でcursor.valueや他購読の鍵を読みません。
                const cursor = identifiers.openKeyCursor();
                cursor.onerror = event => { event.preventDefault(); stop('X_EXPORT_DATABASE_FAILED'); };
                cursor.onsuccess = event => {
                    const current = event.target.result;
                    if (!current) { cursorFinished = true; requestValueAfterMetadata(); return; }
                    try {
                        const key = current.key;
                        if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'string' || typeof key[1] !== 'string'
                            || key[0].length < 1 || key[0].length > 4096 || key[1].length > 4096
                            || /[\u0000-\u0020\u007f]/.test(key[0]) || /[\u0000-\u001f\u007f]/.test(key[1])) fail('X_EXPORT_INVALID_SCOPE');
                        let scope;
                        try { scope = new URL(key[0]); } catch { fail('X_EXPORT_INVALID_SCOPE'); }
                        // 他サイトは索引の件数だけを扱うため、X用のURL制約を押し付けません。
                        // 通常のHTTP(S) originならquery/fragment/localhost/containerも数えます。
                        // 不明なsystem scopeなどは分類したことにせず、安全に停止します。
                        if (!['https:', 'http:'].includes(scope.protocol) || !scope.hostname || scope.username || scope.password) fail('X_EXPORT_INVALID_SCOPE');
                        const isX = scope.origin === 'https://x.com';
                        if (isX) {
                            if (key[1] !== '') fail('X_EXPORT_OTHER_SUBSCRIPTIONS');
                            validScope(key[0]);
                        }
                        if (typeof current.primaryKey !== 'string' || !UUID.test(current.primaryKey)) fail('X_EXPORT_INVALID_ID');
                        metadata.push({ scope: key[0], channelID: current.primaryKey, isX });
                        if (metadata.length > MAX_METADATA_RECORDS) fail('X_EXPORT_TOO_MANY_SUBSCRIPTIONS');
                        current.continue();
                    } catch (error) { stop(ERROR_CODES.has(error?.exportCode) ? error.exportCode : 'X_EXPORT_DATABASE_FORMAT'); }
                };
            } catch { if (transaction) stop('X_EXPORT_DATABASE_FAILED'); else reject(Object.assign(new Error(), { exportCode: 'X_EXPORT_DATABASE_FAILED' })); }
        });
    }

    async function validateKeys(record) {
        const publicKey = rawBytes(record.p256dhPublicKey, 65);
        const auth = rawBytes(record.authenticationSecret, 16);
        const jwk = record.p256dhPrivateKey;
        exactFields(jwk, ['kty', 'crv', 'x', 'y', 'd', 'ext', 'key_ops'], 'X_EXPORT_INVALID_KEYS');
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.ext !== true || !Array.isArray(jwk.key_ops)
            || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'deriveBits') fail('X_EXPORT_INVALID_KEYS');
        const x = decode(jwk.x, 32), y = decode(jwk.y, 32), d = decode(jwk.d, 32);
        const scalar = BigInt('0x' + Array.from(d, byte => byte.toString(16).padStart(2, '0')).join(''));
        if (scalar <= 0n || scalar >= P256_ORDER) fail('X_EXPORT_INVALID_KEYS');
        const expectedPublic = new Uint8Array(65);
        expectedPublic[0] = 4; expectedPublic.set(x, 1); expectedPublic.set(y, 33);
        if (publicKey[0] !== 4 || !equal(publicKey, expectedPublic)) fail('X_EXPORT_INVALID_KEYS');
        if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.getRandomValues !== 'function') fail('X_EXPORT_CRYPTO_UNAVAILABLE');
        try {
            // ECDSAの自己challengeで秘密scalarと公開点の対応も確認します。
            // ECDHのx座標だけの比較では、Qと-Qの取り違えを見落とすためです。
            // 署名・challengeは結果にもログにも入れず、原JWKのkey_opsも変更しません。
            const verificationKey = await crypto.subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const signingKey = await crypto.subtle.importKey('jwk', {
                kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: false, key_ops: ['sign'],
            }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, challenge);
            if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verificationKey, signature, challenge)) fail('X_EXPORT_INVALID_KEYS');
        } catch { fail('X_EXPORT_INVALID_KEYS'); }
        return {
            p256dhPublicKey: encode(publicKey), authenticationSecret: encode(auth),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true, key_ops: ['deriveBits'] },
        };
    }

    (async () => {
        exactFields(input, ['uaid', 'expectedProfilePath'], 'X_EXPORT_ARGUMENTS_INVALID');
        const uaid = validUaid(input.uaid);
        if (typeof Services === 'undefined' || typeof ChromeUtils === 'undefined' || typeof Ci === 'undefined'
            || typeof indexedDB === 'undefined' || typeof indexedDB.openForPrincipal !== 'function') fail('X_EXPORT_CONTEXT_UNAVAILABLE');
        const actualProfile = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
        if (safePath(actualProfile) !== safePath(input.expectedProfilePath)) fail('X_EXPORT_PROFILE_MISMATCH');
        if (Services.io.offline !== true) fail('X_EXPORT_OFFLINE_REQUIRED');
        if (Services.prefs.getBoolPref('dom.push.enabled', true) !== false) fail('X_EXPORT_PUSH_MUST_BE_DISABLED');
        const browserVersion = Services.appinfo.version;
        if (typeof browserVersion !== 'string' || !/^[0-9A-Za-z._+-]{1,64}$/.test(browserVersion)) fail('X_EXPORT_BROWSER_UNSUPPORTED');
        const db = await openDatabase();
        if (completed) return;
        const selected = await readOnlyXRecord(db);
        const record = selected.record;
        if (!ownObject(record) || record.systemRecord !== false || record.scope !== selected.metadata.scope
            || record.channelID !== selected.metadata.channelID || record.originAttributes !== '') fail('X_EXPORT_INVALID_RECORD');
        const scope = validScope(record.scope);
        const endpoint = canonicalUrl(record.pushEndpoint, 'X_EXPORT_INVALID_ENDPOINT');
        if (endpoint.hostname !== 'updates.push.services.mozilla.com' || endpoint.pathname === '/') fail('X_EXPORT_INVALID_ENDPOINT');
        const keys = await validateKeys(record);
        if (completed) return;
        const exported = {
            format: 'x-notification-subscription', version: 1,
            provenance: { kind: 'firefox-pushdb', adapterVersion: ADAPTER_VERSION, browserVersion, readMethod: 'gecko-indexeddb-readonly' },
            push: { uaid, channelID: record.channelID, pushEndpoint: record.pushEndpoint, scope, originAttributes: '', ...keys },
        };
        // 出力は既知項目だけです。raw record、余分な購読、診断例外をコピーしません。
        if (JSON.stringify(exported).length > 16384) fail('X_EXPORT_INVALID_RECORD');
        // 件数はローカルの確認画面だけに返します。X用のファイル形式へ混ぜません。
        // UAIDは同じプロファイルの他サイト通知にも共用されるため、PowerShellはこの件数で
        // 保存直前の説明と明示同意を行います。同意は他サイト通知の利用許可ではありません。
        finish({ ok: true, export: exported, otherSubscriptionCount: selected.otherSubscriptionCount });
    })().catch(error => finish({ ok: false, errorCode: ERROR_CODES.has(error?.exportCode) ? error.exportCode : 'X_EXPORT_OPERATION_FAILED' }))
        .finally(() => timers.clearTimeout(timer));
    });
}
