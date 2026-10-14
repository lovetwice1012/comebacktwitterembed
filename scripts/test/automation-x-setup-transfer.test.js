'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { constants, createECDH, createHash, createSecretKey, generateKeyPairSync, privateDecrypt, randomBytes } = require('node:crypto');
const { AutomationError } = require('../../src/automation/service');
const { MAX_FILE_BYTES, parseTransferFile, identifyTransfer, createTransferSealer, createTransferWorkerVault, createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');

// Synthetic P-256 material only. These tests do not use profiles, X or a network.
function fixture() {
    const scalar = Buffer.alloc(32); scalar[31] = 1;
    const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(scalar);
    const point = ecdh.getPublicKey(undefined, 'uncompressed');
    return {
        format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '143.0.1', readMethod: 'gecko-indexeddb-readonly' },
        push: {
            uaid: '22222222-2222-4222-8222-222222222222', channelID: '11111111-1111-4111-8111-111111111111',
            pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-ONLY', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: point.toString('base64url'), authenticationSecret: Buffer.alloc(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'), d: scalar.toString('base64url'), ext: true, key_ops: ['deriveBits'] },
        },
    };
}
const context = { subscriptionId: '33333333-3333-4333-8333-333333333333', ownerUserId: '123456789012345678', revision: 1 };
function safeFailure(callback, code = 'X_SETUP_INVALID_FILE', status = 422) {
    assert.throws(callback, error => {
        assert.ok(error instanceof AutomationError);
        assert.equal(error.code, code); assert.equal(error.status, status);
        const rendered = JSON.stringify(error) + error.message + error.stack;
        for (const secret of [fixture().push.pushEndpoint, fixture().push.p256dhPrivateKey.d, 'PRIVATE-SENTINEL']) assert.ok(!rendered.includes(secret));
        return true;
    });
}
function rejectsChanged(change) { const file = fixture(); change(file); safeFailure(() => parseTransferFile(JSON.stringify(file))); }

test('accepts exactly the reader schema and preserves either original UAID representation', () => {
    const file = fixture();
    assert.deepEqual(parseTransferFile(JSON.stringify(file)), file);
    file.push.uaid = file.push.uaid.replace(/-/g, '');
    file.push.scope = 'https://x.com/i/notifications';
    assert.deepEqual(parseTransferFile(JSON.stringify(file)), file);
    const identities = identifyTransfer(file);
    assert.match(identities.uaidHash, /^[a-f0-9]{64}$/);
    assert.equal(identities.uaidHash, createHash('sha256').update(file.push.uaid).digest('hex'));
});

test('identity uses canonical field order and normalized UAID collision identity', () => {
    const file = fixture();
    const reversed = Object.fromEntries(Object.entries(file).reverse());
    reversed.push = Object.fromEntries(Object.entries(file.push).reverse());
    assert.deepEqual(identifyTransfer(reversed), identifyTransfer(file));
    const compact = fixture(); compact.push.uaid = compact.push.uaid.replace(/-/g, '');
    assert.equal(identifyTransfer(compact).uaidHash, identifyTransfer(file).uaidHash);
    assert.equal(identifyTransfer(compact).channelHash, identifyTransfer(file).channelHash);
    compact.push.authenticationSecret = Buffer.alloc(16, 1).toString('base64url');
    assert.notEqual(identifyTransfer(compact).contentHash, identifyTransfer(file).contentHash);
});

test('rejects non-string input, malformed JSON, trailing input and excess nesting safely', () => {
    for (const value of [null, undefined, 1, {}, Buffer.from('{}'), '', '{', 'null', '[]', 'true', '1', '{}{}', '{"x":}', '{"x":01}', '{"x":truex}', '{"x":"\\q"}', '[1,]', '{"x":1,}', '\ufeff{}']) safeFailure(() => parseTransferFile(value));
    safeFailure(() => parseTransferFile('['.repeat(14) + '0' + ']'.repeat(14)));
    safeFailure(() => parseTransferFile('{"PRIVATE-SENTINEL":'));
});

test('rejects duplicate keys at every nesting level, including escaped aliases', () => {
    const text = JSON.stringify(fixture());
    for (const bad of [
        text.replace('"version":1', '"version":1,"version":1'),
        text.replace('"kind":"firefox-pushdb"', '"kind":"firefox-pushdb","kind":"firefox-pushdb"'),
        text.replace('"uaid":', '"uaid":"22222222222242228222222222222222","\\u0075aid":'),
        text.replace('"kty":"EC"', '"kty":"EC","\\u006bty":"EC"'),
        '{"extra":[{"v":1,"\\u0076":2}]}',
    ]) safeFailure(() => parseTransferFile(bad));
});

test('rejects prototype pollution fields, omitted fields and unknown data at every schema level', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', '\\u005f_proto__']) safeFailure(() => parseTransferFile('{"' + name + '":{}}'));
    for (const path of [[], ['provenance'], ['push'], ['push', 'p256dhPrivateKey']]) {
        for (const name of ['cookies', 'history', 'PRIVATE-SENTINEL']) rejectsChanged(file => { let target = file; for (const key of path) target = target[key]; target[name] = 'PRIVATE-SENTINEL'; });
        const original = fixture(); let target = original; for (const key of path) target = target[key];
        for (const name of Object.keys(target)) rejectsChanged(file => { let changed = file; for (const key of path) changed = changed[key]; delete changed[name]; });
    }
});

test('enforces UTF-8 byte limit before parsing and accepts exactly the limit', () => {
    const text = JSON.stringify(fixture());
    assert.deepEqual(parseTransferFile(text + ' '.repeat(MAX_FILE_BYTES - Buffer.byteLength(text))), fixture());
    safeFailure(() => parseTransferFile(text + ' '.repeat(MAX_FILE_BYTES - Buffer.byteLength(text) + 1)), 'X_SETUP_FILE_TOO_LARGE', 413);
    safeFailure(() => parseTransferFile('あ'.repeat(10923)), 'X_SETUP_FILE_TOO_LARGE', 413);
});

test('enforces provenance types, constants and bounded browser version', () => {
    for (const [field, values] of Object.entries({ kind: ['other', null], adapterVersion: ['1.0.1', 1], readMethod: ['sqlite', null], browserVersion: ['', 'a'.repeat(65), '143.0\n', '日本語', 143] })) {
        for (const value of values) rejectsChanged(file => { file.provenance[field] = value; });
    }
    for (const value of [0, '1', true, 2]) rejectsChanged(file => { file.version = value; });
    rejectsChanged(file => { file.format = 'other'; });
});

test('enforces lowercase ids and empty origin attributes', () => {
    for (const id of ['', null, 'A'.repeat(32), '2'.repeat(31), '2'.repeat(33), '22222222-2222-4222-8222-22222222222g', ' 22222222222242228222222222222222']) rejectsChanged(file => { file.push.uaid = id; });
    for (const id of ['', '1'.repeat(32), '11111111-1111-4111-8111-11111111111A']) rejectsChanged(file => { file.push.channelID = id; });
    for (const attributes of [null, {}, '^userContextId=1', ' ']) rejectsChanged(file => { file.push.originAttributes = attributes; });
});

test('rejects endpoint URL bypasses and noncanonical URLs', () => {
    for (const endpoint of [
        'http://updates.push.services.mozilla.com/p', 'https://updates.push.services.mozilla.com/',
        'https://updates.push.services.mozilla.com', 'https://updates.push.services.mozilla.com:443/p',
        'https://updates.push.services.mozilla.com:444/p', 'https://user@updates.push.services.mozilla.com/p',
        'https://updates.push.services.mozilla.com.evil.example/p', 'https://updates.push.services.mozilla.com./p',
        'https://updates.push.services.mozilla.com@evil.example/p', 'https://UPDATES.push.services.mozilla.com/p',
        'https://updates.push.services.mozilla.com/a/../p', 'https://updates.push.services.mozilla.com\\p',
        'https://updates.push.services.mozilla.com/p?', 'https://updates.push.services.mozilla.com/p#',
        'https://updates.push.services.mozilla.com/p?token=PRIVATE-SENTINEL', 'https://updates.push.services.mozilla.com/p#secret',
        'https://updates.push.services.mozilla.com/p\n', ' https://updates.push.services.mozilla.com/p',
        'https://updates.push.services.mozilla.com/' + 'p'.repeat(4096), null,
    ]) rejectsChanged(file => { file.push.pushEndpoint = endpoint; });
});

test('restricts scope to canonical X HTTPS URLs without attributes', () => {
    for (const scope of ['https://twitter.com/', 'http://x.com/', 'https://x.com:443/', 'https://x.com:8443/', 'https://user@x.com/', 'https://x.com.evil.example/', 'https://X.com/', 'https://x.com', 'https://x.com/?', 'https://x.com/#', 'https://x.com/./', 'https://x.com/\t', null]) rejectsChanged(file => { file.push.scope = scope; });
});

test('rejects noncanonical base64url, wrong lengths, wrong JWK metadata and malformed points', () => {
    for (const field of ['p256dhPublicKey', 'authenticationSecret']) {
        for (const value of ['', null, fixture().push[field] + '=', '+'.repeat(fixture().push[field].length), fixture().push[field].slice(1)]) rejectsChanged(file => { file.push[field] = value; });
    }
    // Nonzero pad bits can decode to the same bytes; only canonical encoding passes.
    rejectsChanged(file => { file.push.authenticationSecret = file.push.authenticationSecret.slice(0, -1) + 'B'; });
    for (const field of ['x', 'y', 'd']) {
        for (const value of ['', null, 'A'.repeat(42), 'A'.repeat(43) + '=', 'A'.repeat(42) + 'B']) rejectsChanged(file => { file.push.p256dhPrivateKey[field] = value; });
    }
    for (const [field, values] of Object.entries({ kty: ['RSA'], crv: ['P-384'], ext: [false, 'true'], key_ops: [null, 'deriveBits', [], ['deriveBits', 'deriveBits'], ['deriveKey']] })) {
        for (const value of values) rejectsChanged(file => { file.push.p256dhPrivateKey[field] = value; });
    }
    rejectsChanged(file => { const point = Buffer.from(file.push.p256dhPublicKey, 'base64url'); point[0] = 2; file.push.p256dhPublicKey = point.toString('base64url'); });
});

test('validates scalar range and exact public/private point agreement, including Q versus -Q', () => {
    for (const scalar of [0n, 2n, 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n, (1n << 256n) - 1n]) rejectsChanged(file => { file.push.p256dhPrivateKey.d = Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex').toString('base64url'); });
    rejectsChanged(file => { file.push.p256dhPrivateKey.x = Buffer.alloc(32).toString('base64url'); });
    rejectsChanged(file => {
        const point = Buffer.from(file.push.p256dhPublicKey, 'base64url');
        const prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
        const opposite = Buffer.from((prime - BigInt('0x' + point.subarray(33).toString('hex'))).toString(16).padStart(64, '0'), 'hex');
        opposite.copy(point, 33); file.push.p256dhPublicKey = point.toString('base64url'); file.push.p256dhPrivateKey.y = opposite.toString('base64url');
    });
    rejectsChanged(file => { file.push.p256dhPrivateKey.x = file.push.p256dhPrivateKey.y = Buffer.alloc(32).toString('base64url'); file.push.p256dhPublicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url'); });
});

test('object APIs reject accessors and extra array properties without serializing secret data', () => {
    const file = fixture(); Object.defineProperty(file.push, 'uaid', { get() { throw new Error('PRIVATE-SENTINEL'); }, enumerable: true });
    safeFailure(() => identifyTransfer(file));
    const extra = fixture(); extra.push.p256dhPrivateKey.key_ops.extra = 'PRIVATE-SENTINEL';
    safeFailure(() => identifyTransfer(extra));
});

test('web sealer exposes seal only and authenticated worker round-trips with fresh random nonces', () => {
    const options = { activeKeyId: 'v1', keys: { v1: randomBytes(32) } };
    const sealer = createTransferSealer(options), worker = createTransferWorkerVault(options);
    assert.deepEqual(Object.keys(sealer), ['seal']); assert.ok(Object.isFrozen(sealer));
    const first = sealer.seal(fixture(), context), second = sealer.seal(fixture(), context);
    assert.equal(first.algorithm, 'A256GCM'); assert.equal(first.version, 1); assert.equal(first.keyId, 'v1');
    assert.notEqual(first.iv, second.iv); assert.notEqual(first.ciphertext, second.ciphertext);
    assert.deepEqual(worker.open(first, context), fixture());
    assert.deepEqual(worker.open(JSON.parse(JSON.stringify(second)), context), fixture());
    const serialized = JSON.stringify(first);
    for (const secret of [fixture().push.uaid, fixture().push.pushEndpoint, fixture().push.p256dhPrivateKey.d]) assert.ok(!serialized.includes(secret));
});

test('ciphertext, tag, nonce, key metadata, owner, subscription and revision are authenticated', () => {
    const worker = createTransferWorkerVault({ activeKeyId: 'v1', keys: { v1: Buffer.alloc(32, 1), v2: Buffer.alloc(32, 2) } });
    const envelope = worker.seal(fixture(), context);
    for (const field of ['iv', 'tag', 'ciphertext']) {
        const tampered = { ...envelope }; const bytes = Buffer.from(tampered[field], 'base64url'); bytes[0] ^= 1; tampered[field] = bytes.toString('base64url');
        safeFailure(() => worker.open(tampered, context), 'X_SETUP_DECRYPT_FAILED', 503);
    }
    for (const [field, values] of Object.entries({ version: [0, '1', 2], algorithm: ['A256CBC', 'none'], keyId: ['missing', 'v2', '', '../v1'], iv: ['', envelope.iv + '='], tag: ['', envelope.tag + '='], ciphertext: ['', envelope.ciphertext + '=', 'a'.repeat(44000)] })) {
        for (const value of values) safeFailure(() => worker.open({ ...envelope, [field]: value }, context), 'X_SETUP_DECRYPT_FAILED', 503);
    }
    for (const changed of [{ ...context, ownerUserId: '999' }, { ...context, subscriptionId: '44444444-4444-4444-8444-444444444444' }, { ...context, revision: 2 }, { ...context, revision: 0 }, { ...context, extra: 'PRIVATE-SENTINEL' }]) safeFailure(() => worker.open(envelope, changed), 'X_SETUP_DECRYPT_FAILED', 503);
    safeFailure(() => worker.open({ ...envelope, plaintext: 'PRIVATE-SENTINEL' }, context), 'X_SETUP_DECRYPT_FAILED', 503);
});

test('supports decrypt-only old keys during key rotation and fails closed after removal', () => {
    const oldKey = randomBytes(32), newKey = randomBytes(32);
    const original = createTransferSealer({ activeKeyId: 'old', keys: { old: oldKey } }).seal(fixture(), context);
    const rotated = createTransferWorkerVault({ activeKeyId: 'current', keys: new Map([['old', oldKey], ['current', newKey]]) });
    assert.deepEqual(rotated.open(original, context), fixture());
    assert.equal(rotated.seal(fixture(), context).keyId, 'current');
    const removed = createTransferWorkerVault({ activeKeyId: 'current', keys: { current: newKey } });
    safeFailure(() => removed.open(original, context), 'X_SETUP_DECRYPT_FAILED', 503);
    const sameKeyDifferentId = createTransferWorkerVault({ activeKeyId: 'alias', keys: { alias: oldKey } });
    safeFailure(() => sameKeyDifferentId.open({ ...original, keyId: 'alias' }, context), 'X_SETUP_DECRYPT_FAILED', 503);
});

test('requires real 256-bit keys, clones caller keys and validates all binding fields', () => {
    for (const options of [undefined, {}, { activeKeyId: 'missing', keys: { v1: Buffer.alloc(32) } }, { activeKeyId: 'v1', keys: {} }, { activeKeyId: 'v1', keys: { v1: Buffer.alloc(31) } }, { activeKeyId: 'v1', keys: { v1: Buffer.alloc(32).toString('base64url') } }, { activeKeyId: '../key', keys: { '../key': Buffer.alloc(32) } }]) safeFailure(() => createTransferSealer(options), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    const key = randomBytes(32), saved = Buffer.from(key);
    const sealer = createTransferSealer({ activeKeyId: 'v1', keys: { v1: key } }); key.fill(0);
    const worker = createTransferWorkerVault({ activeKeyId: 'v1', keys: { v1: saved } });
    assert.deepEqual(worker.open(sealer.seal(fixture(), context), context), fixture());
    for (const changed of [null, {}, { ...context, ownerUserId: 123 }, { ...context, ownerUserId: '' }, { ...context, subscriptionId: '1'.repeat(32) }, { ...context, revision: 0 }, { ...context, revision: 1.5 }, { ...context, revision: Number.MAX_SAFE_INTEGER + 1 }]) safeFailure(() => sealer.seal(fixture(), changed), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    const invalid = fixture(); invalid.push.p256dhPrivateKey.d = 'PRIVATE-SENTINEL';
    safeFailure(() => sealer.seal(invalid, context));
});

let rsaOld, rsaCurrent;
test.before(() => {
    rsaOld = generateKeyPairSync('rsa', { modulusLength: 3072 });
    rsaCurrent = generateKeyPairSync('rsa', { modulusLength: 3072 });
});

test('hybrid web role owns public material only and worker role owns private material only', () => {
    const sealer = createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: { rsa1: rsaOld.publicKey } });
    const worker = createTransferPrivateWorkerVault({ activeKeyId: 'rsa1', privateKeys: { rsa1: rsaOld.privateKey } });
    assert.deepEqual(Object.keys(sealer), ['seal']); assert.ok(Object.isFrozen(sealer));
    assert.deepEqual(Object.keys(worker), ['open']); assert.ok(Object.isFrozen(worker));
    const envelope = sealer.seal(fixture(), context);
    assert.equal(envelope.version, 2); assert.equal(envelope.algorithm, 'RSA-OAEP-256+A256GCM');
    assert.equal(Buffer.from(envelope.wrappedKey, 'base64url').length, 384);
    assert.deepEqual(worker.open(JSON.parse(JSON.stringify(envelope)), context), fixture());
    assert.equal(rsaOld.publicKey.export({ format: 'jwk' }).d, undefined);
    safeFailure(() => createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: { rsa1: rsaOld.privateKey } }), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    safeFailure(() => createTransferPrivateWorkerVault({ activeKeyId: 'rsa1', privateKeys: { rsa1: rsaOld.publicKey } }), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    for (const secret of [fixture().push.uaid, fixture().push.pushEndpoint, fixture().push.p256dhPrivateKey.d]) assert.ok(!JSON.stringify(envelope).includes(secret));
});

test('hybrid accepts one public/private PEM block, never a private PEM in the public role', () => {
    for (const publicType of ['spki', 'pkcs1']) {
        const publicPem = rsaOld.publicKey.export({ format: 'pem', type: publicType }).toString();
        const sealer = createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: new Map([['rsa1', publicPem]]) });
        for (const privateType of ['pkcs8', 'pkcs1']) {
            const privatePem = rsaOld.privateKey.export({ format: 'pem', type: privateType }).toString();
            const worker = createTransferPrivateWorkerVault({ activeKeyId: 'rsa1', privateKeys: { rsa1: privatePem } });
            assert.deepEqual(worker.open(sealer.seal(fixture(), context), context), fixture());
            safeFailure(() => createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: { rsa1: privatePem } }), 'X_SETUP_VAULT_UNAVAILABLE', 503);
            safeFailure(() => createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: { rsa1: publicPem + privatePem } }), 'X_SETUP_VAULT_UNAVAILABLE', 503);
        }
    }
});

test('hybrid wrapping uses OAEP-SHA256, bound labels and a fresh 256-bit data key per envelope', () => {
    const sealer = createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: { rsa1: rsaOld.publicKey } });
    const first = sealer.seal(fixture(), context), second = sealer.seal(fixture(), context);
    assert.notEqual(first.iv, second.iv); assert.notEqual(first.wrappedKey, second.wrappedKey); assert.notEqual(first.ciphertext, second.ciphertext);
    // Independently unwrap with the documented wire protocol rather than the
    // worker helper, proving its required hash and context label are usable.
    const label = Buffer.from(JSON.stringify(['x-notification-subscription-vault', 2, 'RSA-OAEP-256+A256GCM', 'rsa1', context.subscriptionId, context.ownerUserId, context.revision]));
    const options = { key: rsaOld.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label };
    const firstKey = privateDecrypt(options, Buffer.from(first.wrappedKey, 'base64url'));
    const secondKey = privateDecrypt(options, Buffer.from(second.wrappedKey, 'base64url'));
    assert.equal(firstKey.length, 32); assert.equal(secondKey.length, 32); assert.ok(!firstKey.equals(secondKey));
    assert.throws(() => privateDecrypt({ ...options, oaepHash: 'sha1' }, Buffer.from(first.wrappedKey, 'base64url')));
    assert.throws(() => privateDecrypt({ ...options, oaepLabel: Buffer.from('other-context') }, Buffer.from(first.wrappedKey, 'base64url')));
    firstKey.fill(0); secondKey.fill(0);
});

test('hybrid tampering, swapped wrapped data keys and context swaps fail safely', () => {
    const sealer = createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: { rsa1: rsaOld.publicKey } });
    const worker = createTransferPrivateWorkerVault({ activeKeyId: 'rsa1', privateKeys: { rsa1: rsaOld.privateKey } });
    const envelope = sealer.seal(fixture(), context), second = sealer.seal(fixture(), context);
    for (const field of ['wrappedKey', 'iv', 'tag', 'ciphertext']) {
        const changed = Buffer.from(envelope[field], 'base64url'); changed[0] ^= 1;
        for (const value of [changed.toString('base64url'), '', null, envelope[field] + '=', envelope[field].slice(1)]) safeFailure(() => worker.open({ ...envelope, [field]: value }, context), 'X_SETUP_DECRYPT_FAILED', 503);
    }
    for (const [field, values] of Object.entries({ version: [1, '2', 3], algorithm: ['A256GCM', 'none'], keyId: ['missing', '', '../rsa1'], ciphertext: ['a'.repeat(44000)] })) {
        for (const value of values) safeFailure(() => worker.open({ ...envelope, [field]: value }, context), 'X_SETUP_DECRYPT_FAILED', 503);
    }
    safeFailure(() => worker.open({ ...envelope, wrappedKey: second.wrappedKey }, context), 'X_SETUP_DECRYPT_FAILED', 503);
    for (const changed of [{ ...context, ownerUserId: '999' }, { ...context, subscriptionId: '44444444-4444-4444-8444-444444444444' }, { ...context, revision: 2 }, { ...context, revision: 0 }, { ...context, extra: 'PRIVATE-SENTINEL' }]) safeFailure(() => worker.open(envelope, changed), 'X_SETUP_DECRYPT_FAILED', 503);
    safeFailure(() => worker.open({ ...envelope, plaintext: 'PRIVATE-SENTINEL' }, context), 'X_SETUP_DECRYPT_FAILED', 503);
    const wrongKey = createTransferPrivateWorkerVault({ activeKeyId: 'rsa1', privateKeys: { rsa1: rsaCurrent.privateKey } });
    safeFailure(() => wrongKey.open(envelope, context), 'X_SETUP_DECRYPT_FAILED', 503);
    const legacy = createTransferSealer({ activeKeyId: 'aes1', keys: { aes1: Buffer.alloc(32) } }).seal(fixture(), context);
    safeFailure(() => worker.open(legacy, context), 'X_SETUP_DECRYPT_FAILED', 503);
});

test('hybrid rotation decrypts old envelopes only while the matching private key is retained', () => {
    const old = createTransferPublicSealer({ activeKeyId: 'old', publicKeys: { old: rsaOld.publicKey } }).seal(fixture(), context);
    const currentSealer = createTransferPublicSealer({ activeKeyId: 'current', publicKeys: { current: rsaCurrent.publicKey } });
    const rotated = createTransferPrivateWorkerVault({ activeKeyId: 'current', privateKeys: new Map([['old', rsaOld.privateKey], ['current', rsaCurrent.privateKey]]) });
    assert.deepEqual(rotated.open(old, context), fixture());
    const current = currentSealer.seal(fixture(), context);
    assert.equal(current.keyId, 'current'); assert.deepEqual(rotated.open(current, context), fixture());
    const removed = createTransferPrivateWorkerVault({ activeKeyId: 'current', privateKeys: { current: rsaCurrent.privateKey } });
    safeFailure(() => removed.open(old, context), 'X_SETUP_DECRYPT_FAILED', 503);
    const renamed = createTransferPrivateWorkerVault({ activeKeyId: 'renamed', privateKeys: { renamed: rsaOld.privateKey } });
    safeFailure(() => renamed.open({ ...old, keyId: 'renamed' }, context), 'X_SETUP_DECRYPT_FAILED', 503);
});

test('hybrid requires RSA-3072 through RSA-4096 and rejects secret, EC, malformed and absent keys', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    for (const material of [small.publicKey, ec.publicKey, createSecretKey(Buffer.alloc(32)), 'PRIVATE-SENTINEL', Buffer.alloc(32)]) safeFailure(() => createTransferPublicSealer({ activeKeyId: 'rsa1', publicKeys: { rsa1: material } }), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    for (const material of [small.privateKey, ec.privateKey, createSecretKey(Buffer.alloc(32)), 'PRIVATE-SENTINEL']) safeFailure(() => createTransferPrivateWorkerVault({ activeKeyId: 'rsa1', privateKeys: { rsa1: material } }), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    for (const options of [undefined, {}, { activeKeyId: 'missing', publicKeys: { rsa1: rsaOld.publicKey } }, { activeKeyId: 'rsa1', publicKeys: {} }, { activeKeyId: '../rsa1', publicKeys: { '../rsa1': rsaOld.publicKey } }]) safeFailure(() => createTransferPublicSealer(options), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    const upper = generateKeyPairSync('rsa', { modulusLength: 4096 });
    const sealer = createTransferPublicSealer({ activeKeyId: 'upper', publicKeys: { upper: upper.publicKey } });
    const worker = createTransferPrivateWorkerVault({ activeKeyId: 'upper', privateKeys: { upper: upper.privateKey } });
    const envelope = sealer.seal(fixture(), context);
    assert.equal(Buffer.from(envelope.wrappedKey, 'base64url').length, 512);
    assert.deepEqual(worker.open(envelope, context), fixture());
    safeFailure(() => sealer.seal(fixture(), { ...context, revision: 0 }), 'X_SETUP_VAULT_UNAVAILABLE', 503);
    const invalid = fixture(); invalid.push.p256dhPrivateKey.d = 'PRIVATE-SENTINEL';
    safeFailure(() => sealer.seal(invalid, context));
});
