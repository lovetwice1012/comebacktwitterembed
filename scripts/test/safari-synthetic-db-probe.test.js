'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { capturedFixture, inspectSyntheticRecord, inspectHostedSafariDatabase, isSyntheticHostedEnvironment } = require('../native-test/safari-synthetic-db-probe.cjs');

function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE SubscriptionSets (rowID INTEGER PRIMARY KEY, bundleID TEXT); CREATE TABLE Subscriptions (subscriptionSetID INTEGER, scope TEXT, endpoint TEXT, clientPublicKey BLOB, clientPrivateKey BLOB, sharedAuthSecret BLOB, serverVAPIDPublicKey BLOB)');
    db.exec("INSERT INTO SubscriptionSets VALUES (1, 'com.apple.Safari'), (2, 'unrelated-private-owner')");
    const expected = { endpoint: 'https://example.invalid/fixture', publicKey: Buffer.alloc(65, 1), auth: Buffer.alloc(16, 2), vapid: Buffer.alloc(65, 3) };
    const scope = 'https://127.0.0.1:4321/';
    const insert = db.prepare('INSERT INTO Subscriptions VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run(1, scope, expected.endpoint, expected.publicKey, Buffer.alloc(32, 4), expected.auth, expected.vapid);
    insert.run(2, 'https://unrelated.invalid/', 'https://private.invalid/', Buffer.alloc(65, 5), Buffer.alloc(32, 6), Buffer.alloc(16, 7), Buffer.alloc(65, 8));
    return { db, scope, expected, insert };
}
test('selects only the synthetic scope and returns comparison booleans and lengths', () => {
    const { db, scope, expected } = fixture();
    try {
        const result = inspectSyntheticRecord(db, scope, expected);
        assert.deepEqual(result, { ownerSafari: true, endpointMatches: true, publicKeyMatches: true, authMatches: true,
            vapidMatches: true, publicLength: 65, privateLength: 32, authLength: 16, vapidLength: 65 });
        assert(!JSON.stringify(result).includes('unrelated-private-owner') && !JSON.stringify(result).includes(expected.endpoint));
        assert.equal(inspectSyntheticRecord(db, scope, { ...expected, auth: Buffer.alloc(16, 9) }).authMatches, false);
    } finally { db.close(); }
});
test('rejects ambiguous or unsafe scopes without exposing database contents', () => {
    const { db, scope, expected, insert } = fixture();
    try {
        assert.throws(() => inspectSyntheticRecord(db, 'https://x.com/', expected), { code: 'FIXTURE_SAFARI_DB_INPUT_INVALID' });
        insert.run(2, scope, expected.endpoint, expected.publicKey, Buffer.alloc(32, 4), expected.auth, expected.vapid);
        assert.throws(() => inspectSyntheticRecord(db, scope, expected), { code: 'FIXTURE_SAFARI_DB_MATCH_NOT_UNIQUE' });
        assert.throws(() => inspectSyntheticRecord(db, 'http://localhost:65536/', expected), { code: 'FIXTURE_SAFARI_DB_INPUT_INVALID' });
    } finally { db.close(); }
});
test('does not inspect any real host without disposable hosted CI guards', () => {
    const expected = { endpoint: 'https://example.invalid/', publicKey: Buffer.alloc(65), auth: Buffer.alloc(16), vapid: Buffer.alloc(65) };
    const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', CBTE_SAFARI_SYNTHETIC_DB_PROBE: '1', CBTE_SAFARI_PUSH_HOSTED: '1' };
    assert.equal(isSyntheticHostedEnvironment('darwin', hosted, true), true);
    assert.equal(isSyntheticHostedEnvironment('win32', hosted, true), false);
    assert.equal(isSyntheticHostedEnvironment('darwin', { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, true), false);
    assert.equal(isSyntheticHostedEnvironment('darwin', hosted, false), false);
    if (!isSyntheticHostedEnvironment(process.platform, process.env, typeof process.getuid === 'function'))
        // Passing a forged third argument cannot change the real-host gate.
        assert.throws(() => inspectHostedSafariDatabase('http://127.0.0.1:4321/', expected, { platform: 'darwin', env: hosted }),
            { code: 'FIXTURE_SAFARI_DB_ENVIRONMENT_INVALID' });
});
test('captured subscription keys are bounded and decoded without returning raw errors', () => {
    const subscription = { endpoint: 'https://example.invalid/', keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
    const expected = capturedFixture(subscription, Buffer.alloc(65, 3));
    assert.equal(expected.publicKey.length, 65); assert.equal(expected.auth.length, 16); assert.equal(expected.vapid.length, 65);
    for (const invalid of ['', '***', Buffer.alloc(15).toString('base64url')])
        assert.throws(() => capturedFixture({ ...subscription, keys: { ...subscription.keys, auth: invalid } }, Buffer.alloc(65)), { code: 'FIXTURE_SAFARI_DB_INPUT_INVALID' });
    expected.publicKey.fill(0); expected.auth.fill(0); expected.vapid.fill(0);
});
test('SQLite read-only mode rejects writes and preserves a disposable fixture file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-safari-db-unit-'));
    const filename = path.join(directory, 'fixture.db');
    let writer, reader;
    try {
        writer = new DatabaseSync(filename);
        writer.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1)');
        writer.close(); writer = undefined;
        const before = fs.readFileSync(filename);
        reader = new DatabaseSync(filename, { readOnly: true, timeout: 1000 });
        assert.equal(reader.prepare('SELECT v FROM t').get().v, 1);
        assert.throws(() => reader.exec('INSERT INTO t VALUES (2)'));
        reader.close(); reader = undefined;
        assert.deepEqual(fs.readFileSync(filename), before);
    } finally {
        try { writer?.close(); } catch { /* Test fixture is disposable. */ }
        try { reader?.close(); } catch { /* Test fixture is disposable. */ }
        try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.rmdirSync(directory);
    }
});
