'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// この試験は合成データ専用です。製品JSをメモリー上で実行し、IndexedDBのイベントだけを
// 最小限の偽物で再現します。実Firefox、実プロファイル、X、ネットワークは使いません。
// IndexedDBの実保存形式やWindows ACLの証拠は、別のネイティブ試験で確認してください。
const readerSource = fs.readFileSync(path.join(__dirname, '../../client/angelic-setup/Read-PushSubscription.js'), 'utf8');
const profilePath = 'C:\\synthetic-only\\reader';
const uaid = '22222222-2222-4222-8222-222222222222';
const channelID = '11111111-1111-4111-8111-111111111111';
let fixtureRecord;
let otherPrivateJwk;

test.before(async () => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const otherPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    otherPrivateJwk = await webcrypto.subtle.exportKey('jwk', otherPair.privateKey);
    fixtureRecord = {
        channelID, scope: 'https://x.com/', originAttributes: '', systemRecord: false,
        pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-NOT-A-SUBSCRIPTION',
        p256dhPublicKey: new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)),
        p256dhPrivateKey: await webcrypto.subtle.exportKey('jwk', pair.privateKey),
        authenticationSecret: webcrypto.getRandomValues(new Uint8Array(16)),
    };
});

function record(changes = {}) {
    return Object.assign(structuredClone(fixtureRecord), changes);
}

function mockDatabase(records, counters) {
    return {
        version: 5,
        objectStoreNames: { length: 1, contains: name => name === 'pushapi' },
        close() { counters.databaseClosed++; },
        transaction(name, mode) {
            assert.equal(name, 'pushapi');
            assert.equal(mode, 'readonly');
            counters.transactions++;
            let pending = 0, aborted = false, completed = false;
            const transaction = {
                abort() {
                    if (aborted || completed) return;
                    aborted = true;
                    setImmediate(() => transaction.onabort?.({ preventDefault() {} }));
                },
            };
            // callback内で追加されるget/continueも、同じtransactionが完了する前に実行します。
            function schedule(callback) {
                pending++;
                setImmediate(() => {
                    if (aborted) return;
                    callback();
                    pending--;
                    if (!pending) setImmediate(() => {
                        if (!pending && !aborted && !completed) {
                            completed = true;
                            transaction.oncomplete?.();
                        }
                    });
                });
            }
            function request(callback) {
                const result = {};
                schedule(() => callback(result));
                return result;
            }
            // 複合indexに現れない壊れたrecordもstore.countには含めます。
            const indexedRecords = records.filter(item => typeof item.scope === 'string' && typeof item.originAttributes === 'string');
            const store = {
                keyPath: 'channelID', autoIncrement: false,
                indexNames: { contains: index => index === 'identifiers' },
                count: () => request(result => {
                    result.result = records.length;
                    result.onsuccess?.();
                }),
                get: key => request(result => {
                    counters.valueReads++;
                    result.result = records.find(item => item.channelID === key);
                    result.onsuccess?.();
                }),
                index(index) {
                    assert.equal(index, 'identifiers');
                    return {
                        unique: true, keyPath: ['scope', 'originAttributes'],
                        openKeyCursor() {
                            let cursorIndex = 0;
                            const result = {};
                            function deliver() {
                                const item = indexedRecords[cursorIndex++];
                                const cursor = item ? {
                                    key: [item.scope, item.originAttributes], primaryKey: item.channelID,
                                    continue() { schedule(deliver); },
                                } : null;
                                // 製品がmetadata選別中に.valueへ触れたら、その場で試験を失敗させます。
                                if (cursor) Object.defineProperty(cursor, 'value', {
                                    get() { counters.metadataValueReads++; throw new Error('Metadata cursor must never read record values'); },
                                });
                                result.onsuccess?.({ target: { result: cursor } });
                            }
                            schedule(deliver);
                            return result;
                        },
                    };
                },
            };
            transaction.objectStore = storeName => {
                assert.equal(storeName, 'pushapi');
                return store;
            };
            return transaction;
        },
    };
}

async function invoke(records, { offline = true, pushEnabled = false, actualProfile = profilePath, input } = {}) {
    const counters = { databaseOpens: 0, databaseClosed: 0, transactions: 0, valueReads: 0, metadataValueReads: 0, logs: 0, networkCalls: 0 };
    const database = mockDatabase(records, counters);
    const blockedNetwork = () => { counters.networkCalls++; throw new Error('Network is forbidden in this synthetic test'); };
    const context = {
        URL, Uint8Array, ArrayBuffer, crypto: webcrypto,
        fetch: blockedNetwork, WebSocket: blockedNetwork, XMLHttpRequest: blockedNetwork,
        console: Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map(name => [name, () => { counters.logs++; }])),
        Ci: { nsIFile: {} },
        Services: {
            dirsvc: { get: () => ({ path: actualProfile }) },
            scriptSecurityManager: { getSystemPrincipal: () => ({ syntheticPrincipal: true }) },
            io: { offline }, prefs: { getBoolPref: () => pushEnabled }, appinfo: { version: '160.0a1' },
        },
        ChromeUtils: {
            importESModule(modulePath) {
                assert.equal(modulePath, 'resource://gre/modules/Timer.sys.mjs');
                return { setTimeout, clearTimeout };
            },
            base64URLEncode: bytes => Buffer.from(bytes).toString('base64url'),
            base64URLDecode: text => new Uint8Array(Buffer.from(text, 'base64url')).buffer,
        },
        indexedDB: {
            openForPrincipal(principal, name, version) {
                assert.equal(principal.syntheticPrincipal, true);
                assert.equal(name, 'pushapi'); assert.equal(version, 5);
                counters.databaseOpens++;
                const result = {};
                setImmediate(() => { result.result = database; result.onsuccess?.(); });
                return result;
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(readerSource, context, { filename: 'Read-PushSubscription.js' });
    const response = await context.ReadPushSubscription(input || { uaid, expectedProfilePath: profilePath });
    assert.equal(counters.logs, 0, 'The reader must never print subscription data or errors');
    assert.equal(counters.networkCalls, 0, 'The reader must not use network APIs');
    assert.equal(counters.metadataValueReads, 0, 'Metadata selection must never access cursor.value');
    return { response, counters };
}

async function rejected(records, errorCode, valueReads = 1, options) {
    const { response, counters } = await invoke(records, options);
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, errorCode);
    assert.deepEqual(Object.keys(response).sort(), ['errorCode', 'ok']);
    assert.equal(counters.valueReads, valueReads);
    if (counters.databaseOpens) assert.equal(counters.databaseClosed, 1);
    return counters;
}

test('valid synthetic subscription reads exactly one value and exports only known fields', async () => {
    const { response, counters } = await invoke([record({
        cookie: 'SYNTHETIC-COOKIE-MUST-NOT-EXPORT', history: 'SYNTHETIC-HISTORY-MUST-NOT-EXPORT',
    })]);
    assert.equal(response.ok, true);
    assert.equal(counters.valueReads, 1); assert.equal(counters.transactions, 1); assert.equal(counters.databaseClosed, 1);
    assert.deepEqual(Object.keys(response).sort(), ['export', 'ok', 'otherSubscriptionCount']);
    assert.equal(response.otherSubscriptionCount, 0);
    assert.deepEqual(Object.keys(response.export).sort(), ['format', 'provenance', 'push', 'version']);
    assert.equal(response.export.format, 'x-notification-subscription'); assert.equal(response.export.version, 1);
    assert.deepEqual(Object.keys(response.export.push).sort(), [
        'authenticationSecret', 'channelID', 'originAttributes', 'p256dhPrivateKey', 'p256dhPublicKey', 'pushEndpoint', 'scope', 'uaid',
    ]);
    // 等値判定だけを出し、失敗時にも秘密鍵そのものをassertの差分へ載せません。
    assert.ok(response.export.push.p256dhPrivateKey.d === fixtureRecord.p256dhPrivateKey.d, 'Synthetic private scalar must be preserved');
    assert.ok(response.export.push.p256dhPublicKey === Buffer.from(fixtureRecord.p256dhPublicKey).toString('base64url'), 'Synthetic public key must be preserved');
    assert.ok(response.export.push.authenticationSecret === Buffer.from(fixtureRecord.authenticationSecret).toString('base64url'), 'Synthetic auth must be preserved');
    assert.equal(JSON.stringify(response).includes('MUST-NOT-EXPORT'), false);
});

test('other origin without X rejects before any secret value read', async () => {
    await rejected([record({ scope: 'https://example.invalid/' })], 'X_EXPORT_NO_SUBSCRIPTION', 0);
});
test('mixed X and other-origin subscriptions export only X and return a separate local warning count', async () => {
    const other = record({ channelID: '33333333-3333-4333-8333-333333333333', scope: 'https://example.invalid/' });
    // Foreign key values throw on access; counting must use only the metadata key cursor.
    for (const name of ['p256dhPrivateKey', 'p256dhPublicKey', 'authenticationSecret']) Object.defineProperty(other, name, {
        get() { throw new Error('A foreign subscription key must never be read'); },
    });
    for (const records of [[record(), other], [other, record()]]) {
        const { response, counters } = await invoke(records);
        assert.equal(response.ok, true); assert.equal(response.otherSubscriptionCount, 1);
        assert.equal(response.export.push.channelID, channelID); assert.equal(counters.valueReads, 1);
        assert.deepEqual(Object.keys(response.export).sort(), ['format', 'provenance', 'push', 'version']);
        assert.equal(JSON.stringify(response).includes('example.invalid'), false);
        assert.equal(JSON.stringify(response).includes(other.channelID), false);
    }
});
test('63 foreign subscriptions plus one X are counted without reading foreign values', async () => {
    const foreign = Array.from({ length: 63 }, (_, index) => record({
        channelID: `${String(index + 10).padStart(8, '0')}-3333-4333-8333-333333333333`, scope: `https://example.invalid/${index}/`,
    }));
    const { response, counters } = await invoke([...foreign, record()]);
    assert.equal(response.ok, true); assert.equal(response.otherSubscriptionCount, 63); assert.equal(counters.valueReads, 1);
});
for (const [name, scope, originAttributes] of [
    ['query/fragment', 'https://example.invalid/worker/?lang=ja#scope', ''],
    ['localhost HTTP', 'http://localhost:8080/worker/', ''],
    ['foreign container', 'https://example.invalid/', '^userContextId=1'],
]) test(`foreign ${name} metadata is counted without reading its value or exporting its origin`, async () => {
    const foreign = { channelID: '33333333-3333-4333-8333-333333333333', scope, originAttributes };
    for (const name of ['p256dhPrivateKey', 'p256dhPublicKey', 'authenticationSecret']) Object.defineProperty(foreign, name, {
        get() { throw new Error('Foreign data was read'); },
    });
    const { response, counters } = await invoke([foreign, record()]);
    assert.equal(response.ok, true); assert.equal(response.otherSubscriptionCount, 1); assert.equal(counters.valueReads, 1);
    assert.equal(JSON.stringify(response).includes(scope), false);
});
test('unknown system scope rejects rather than being counted as a recognized foreign website', async () => {
    await rejected([record(), { channelID: '33333333-3333-4333-8333-333333333333', scope: 'resource://synthetic-system/', originAttributes: '' }], 'X_EXPORT_INVALID_SCOPE', 0);
});
test('a profile over the bounded metadata count rejects before any value read', async () => {
    await rejected(Array.from({ length: 65 }, () => record()), 'X_EXPORT_TOO_MANY_SUBSCRIPTIONS', 0);
});
test('invalid foreign scope metadata rejects before any value read', async () => {
    await rejected([record(), record({ channelID: '33333333-3333-4333-8333-333333333333', scope: 'not-a-scope' })], 'X_EXPORT_INVALID_SCOPE', 0);
});
test('container origin attributes reject before any secret value read', async () => {
    await rejected([record({ originAttributes: '^userContextId=1' })], 'X_EXPORT_OTHER_SUBSCRIPTIONS', 0);
});
test('an unindexed hidden record rejects before any secret value read', async () => {
    await rejected([record(), { channelID: '33333333-3333-4333-8333-333333333333' }], 'X_EXPORT_DATABASE_FORMAT', 0);
});
test('multiple X subscriptions reject before any secret value read', async () => {
    await rejected([record(), record({ channelID: '33333333-3333-4333-8333-333333333333', scope: 'https://x.com/second/' })], 'X_EXPORT_TOO_MANY_SUBSCRIPTIONS', 0);
});
test('empty subscription store rejects without a value read', async () => {
    await rejected([], 'X_EXPORT_NO_SUBSCRIPTION', 0);
});
test('invalid channel ID rejects during metadata selection', async () => {
    await rejected([record({ channelID: 'not-a-channel-id' })], 'X_EXPORT_INVALID_ID', 0);
});
for (const [name, changes] of [
    ['system record', { systemRecord: true }],
    ['missing explicit system flag', { systemRecord: undefined }],
]) test(`${name} rejects`, async () => { await rejected([record(changes)], 'X_EXPORT_INVALID_RECORD'); });

for (const [name, pushEndpoint] of [
    ['other host', 'https://example.invalid/SYNTHETIC'],
    ['host suffix trick', 'https://updates.push.services.mozilla.com.example.invalid/SYNTHETIC'],
    ['insecure protocol', 'http://updates.push.services.mozilla.com/SYNTHETIC'],
    ['root endpoint', 'https://updates.push.services.mozilla.com/'],
    ['query', 'https://updates.push.services.mozilla.com/SYNTHETIC?secret=value'],
    ['fragment', 'https://updates.push.services.mozilla.com/SYNTHETIC#fragment'],
    ['URL credentials', 'https://user:password@updates.push.services.mozilla.com/SYNTHETIC'],
]) test(`endpoint ${name} rejects`, async () => { await rejected([record({ pushEndpoint })], 'X_EXPORT_INVALID_ENDPOINT'); });

test('private scalar zero rejects', async () => {
    await rejected([record({ p256dhPrivateKey: { ...fixtureRecord.p256dhPrivateKey, d: Buffer.alloc(32).toString('base64url') } })], 'X_EXPORT_INVALID_KEYS');
});
test('private scalar equal to the P-256 curve order rejects', async () => {
    const order = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex').toString('base64url');
    await rejected([record({ p256dhPrivateKey: { ...fixtureRecord.p256dhPrivateKey, d: order } })], 'X_EXPORT_INVALID_KEYS');
});
test('a different private scalar with the original public point rejects', async () => {
    await rejected([record({ p256dhPrivateKey: { ...fixtureRecord.p256dhPrivateKey, d: otherPrivateJwk.d } })], 'X_EXPORT_INVALID_KEYS');
});
test('negating the public point without changing its private scalar rejects', async () => {
    // ECDHではQと-Qから同じx座標が得られるため、raw/JWK同士の一致だけでは不十分です。
    const prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    const originalY = BigInt('0x' + Buffer.from(fixtureRecord.p256dhPrivateKey.y, 'base64url').toString('hex'));
    const negatedY = Buffer.from((prime - originalY).toString(16).padStart(64, '0'), 'hex');
    const publicKey = new Uint8Array(fixtureRecord.p256dhPublicKey);
    publicKey.set(negatedY, 33);
    await rejected([record({ p256dhPublicKey: publicKey, p256dhPrivateKey: { ...fixtureRecord.p256dhPrivateKey, y: negatedY.toString('base64url') } })], 'X_EXPORT_INVALID_KEYS');
});
test('wrong authentication secret length rejects', async () => {
    await rejected([record({ authenticationSecret: new Uint8Array(15) })], 'X_EXPORT_INVALID_KEYS');
});
test('unknown private JWK field rejects', async () => {
    await rejected([record({ p256dhPrivateKey: { ...fixtureRecord.p256dhPrivateKey, unexpected: 'SYNTHETIC' } })], 'X_EXPORT_INVALID_KEYS');
});
test('unexpected private JWK key operation rejects', async () => {
    await rejected([record({ p256dhPrivateKey: { ...fixtureRecord.p256dhPrivateKey, key_ops: ['sign'] } })], 'X_EXPORT_INVALID_KEYS');
});
test('public raw key and JWK coordinates mismatch rejects', async () => {
    const publicKey = new Uint8Array(fixtureRecord.p256dhPublicKey);
    publicKey[1] ^= 1;
    await rejected([record({ p256dhPublicKey: publicKey })], 'X_EXPORT_INVALID_KEYS');
});
test('online context rejects before opening a database', async () => {
    assert.equal((await rejected([record()], 'X_EXPORT_OFFLINE_REQUIRED', 0, { offline: false })).databaseOpens, 0);
});
test('enabled Push service rejects before opening a database', async () => {
    assert.equal((await rejected([record()], 'X_EXPORT_PUSH_MUST_BE_DISABLED', 0, { pushEnabled: true })).databaseOpens, 0);
});
test('wrong reader profile rejects before opening a database', async () => {
    assert.equal((await rejected([record()], 'X_EXPORT_PROFILE_MISMATCH', 0, { actualProfile: 'C:\\synthetic-only\\different-reader' })).databaseOpens, 0);
});
test('extra input field rejects before opening a database', async () => {
    assert.equal((await rejected([record()], 'X_EXPORT_ARGUMENTS_INVALID', 0, { input: { uaid, expectedProfilePath: profilePath, extra: 'SYNTHETIC' } })).databaseOpens, 0);
});
