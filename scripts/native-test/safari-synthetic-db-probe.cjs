'use strict';

// CI-only research of the *synthetic* subscription created by our local
// Safari fixture. It never opens a user's Mac, emits no keys or endpoints,
// and does not claim that the APNs receive identity is transferable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const fault = code => Object.assign(new Error(code), { code });
const SCOPE = /^https?:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/$/;

function validateFixture(scope, expected) {
    const match = typeof scope === 'string' && SCOPE.exec(scope);
    if (!match || Number(match[1]) > 65535 || !expected || typeof expected !== 'object'
        || typeof expected.endpoint !== 'string' || expected.endpoint.length < 1 || expected.endpoint.length > 4096
        || !Buffer.isBuffer(expected.publicKey) || expected.publicKey.length !== 65
        || !Buffer.isBuffer(expected.auth) || expected.auth.length !== 16
        || !Buffer.isBuffer(expected.vapid) || expected.vapid.length !== 65)
        throw fault('FIXTURE_SAFARI_DB_INPUT_INVALID');
}

function capturedFixture(subscription, vapid) {
    function decode(value, length) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw fault('FIXTURE_SAFARI_DB_INPUT_INVALID');
        const bytes = Buffer.from(value, 'base64url');
        if (bytes.length !== length || bytes.toString('base64url') !== value) {
            bytes.fill(0); throw fault('FIXTURE_SAFARI_DB_INPUT_INVALID');
        }
        return bytes;
    }
    let publicKey, auth;
    try {
        if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.keys || !Buffer.isBuffer(vapid))
            throw fault('FIXTURE_SAFARI_DB_INPUT_INVALID');
        publicKey = decode(subscription.keys.p256dh, 65); auth = decode(subscription.keys.auth, 16);
        return { endpoint: subscription.endpoint, publicKey, auth, vapid: Buffer.from(vapid) };
    } catch (error) { publicKey?.fill(0); auth?.fill(0); throw error; }
}

function inspectSyntheticRecord(database, scope, expected) {
    validateFixture(scope, expected);
    let rows;
    try {
        // Only rows belonging to the exact local fixture scope are returned.
        // Keys and endpoint are used as bound comparison parameters and are
        // never selected; only fixed booleans and key lengths leave SQLite.
        rows = database.prepare(`SELECT (s.bundleID = 'com.apple.Safari') AS ownerSafari,
            (p.endpoint = ?) AS endpointMatches,
            (p.clientPublicKey = ?) AS publicKeyMatches,
            (p.sharedAuthSecret = ?) AS authMatches,
            (p.serverVAPIDPublicKey = ?) AS vapidMatches,
            length(p.clientPublicKey) AS publicLength,
            length(p.clientPrivateKey) AS privateLength,
            length(p.sharedAuthSecret) AS authLength,
            length(p.serverVAPIDPublicKey) AS vapidLength
            FROM Subscriptions p JOIN SubscriptionSets s ON s.rowID = p.subscriptionSetID
            WHERE p.scope = ? LIMIT 2`).all(expected.endpoint, expected.publicKey, expected.auth, expected.vapid, scope);
    } catch { throw fault('FIXTURE_SAFARI_DB_QUERY_FAILED'); }
    if (!Array.isArray(rows) || rows.length !== 1) throw fault('FIXTURE_SAFARI_DB_MATCH_NOT_UNIQUE');
    const row = rows[0];
    if (![row.ownerSafari, row.endpointMatches, row.publicKeyMatches, row.authMatches, row.vapidMatches].every(value => value === 0 || value === 1)
        || ![row.publicLength, row.privateLength, row.authLength, row.vapidLength].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096))
        throw fault('FIXTURE_SAFARI_DB_RESULT_INVALID');
    return { ownerSafari: row.ownerSafari === 1, endpointMatches: row.endpointMatches === 1,
        publicKeyMatches: row.publicKeyMatches === 1, authMatches: row.authMatches === 1, vapidMatches: row.vapidMatches === 1,
        publicLength: row.publicLength, privateLength: row.privateLength, authLength: row.authLength, vapidLength: row.vapidLength };
}

// This pure check may be tested with fixtures; it never opens any path.
function isSyntheticHostedEnvironment(platform, env, hasUid) {
    return platform === 'darwin' && env?.GITHUB_ACTIONS === 'true' && env?.RUNNER_ENVIRONMENT === 'github-hosted'
        && env?.CBTE_SAFARI_SYNTHETIC_DB_PROBE === '1' && env?.CBTE_SAFARI_PUSH_HOSTED === '1' && hasUid === true;
}

function inspectHostedSafariDatabase(scope, expected) {
    // Do not accept caller-provided platform or environment overrides for a
    // function that may open the current user's WebKit database.
    if (!isSyntheticHostedEnvironment(process.platform, process.env, typeof process.getuid === 'function'))
        throw fault('FIXTURE_SAFARI_DB_ENVIRONMENT_INVALID');
    validateFixture(scope, expected);
    const filename = path.join(os.homedir(), 'Library', 'Group Containers', 'group.com.apple.webkit.webpushd',
        'Library', 'WebKit', 'WebPush', 'PushDatabase.db');
    let before, database;
    try {
        before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.nlink !== 1)
            throw fault('FIXTURE_SAFARI_DB_UNAVAILABLE');
        // A missing shared-memory file alongside a live WAL could cause an
        // SQLite reader to create one. Do not open that configuration.
        let wal, shm;
        try { wal = fs.lstatSync(`${filename}-wal`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { shm = fs.lstatSync(`${filename}-shm`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const entry of [wal, shm].filter(Boolean))
            if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid() || entry.nlink !== 1)
                throw fault('FIXTURE_SAFARI_DB_UNAVAILABLE');
        if (wal && !shm) throw fault('FIXTURE_SAFARI_DB_UNAVAILABLE');
        database = new DatabaseSync(filename, { readOnly: true, timeout: 2000 });
        const result = inspectSyntheticRecord(database, scope, expected);
        const after = fs.lstatSync(filename);
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
            throw fault('FIXTURE_SAFARI_DB_UNAVAILABLE');
        return result;
    } catch (error) {
        if (typeof error?.code === 'string' && /^FIXTURE_SAFARI_DB_[A-Z_]+$/.test(error.code)) throw error;
        throw fault('FIXTURE_SAFARI_DB_UNAVAILABLE');
    } finally { try { database?.close(); } catch { /* A read-only diagnostic has already failed closed. */ } }
}
module.exports = { capturedFixture, inspectSyntheticRecord, inspectHostedSafariDatabase, isSyntheticHostedEnvironment };
