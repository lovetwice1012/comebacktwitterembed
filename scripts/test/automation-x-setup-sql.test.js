'use strict';
// This disposable fixture deliberately exercises the public rollout stage.
process.env.X_NOTIFICATION_ROLLOUT = 'public';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXSetup, sealerFromEnvironment, SESSION_TTL_MS } = require('../../src/automation/x-setup');
const { createTransferPublicSealer, createTransferPrivateWorkerVault } = require('../../src/automation/x-setup-transfer');
const { dispatch } = require('../../src/automation/api');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const A = { userId: '222222222222222222' }, B = { userId: '333333333333333333', isAdmin: true };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const vaultConfig = { activeKeyId: 'fixture1', publicKeys: { fixture1: publicKey } };
const sealer = createTransferPublicSealer(vaultConfig);
function fixture() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0a1', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: randomUUID(), channelID: randomUUID(), pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/fixture-secret-endpoint', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
            authenticationSecret: randomBytes(16).toString('base64url'), p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true, key_ops: ['deriveBits'] } } };
}
async function setup(t, work) {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    try { await work(db); } finally { await db.close(); }
}
async function payload(service, actor, file = fixture()) {
    const session = await service.startSession(actor, { consent: true });
    return { sessionId: session.sessionId, fileText: JSON.stringify(file), consent: true };
}
const code = expected => error => error.code === expected;

test('file intake requires explicit config, consent, ownership and bounded one-time sessions', async t => setup(t, async db => {
    let clock = 10000;
    const service = createXSetup(db, { sealer, now: () => clock });
    const disabled = createXSetup(db, { sealer: null });
    assert.equal((await disabled.status(A)).available, false);
    await assert.rejects(disabled.startSession(A, { consent: true }), code('X_SETUP_NOT_CONFIGURED'));
    assert.equal(sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '1', X_NOTIFICATION_INTAKE_KEY_ID: 'k', X_NOTIFICATION_INTAKE_PUBLIC_KEY: 'bad' }), null);
    assert.equal(sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '0' }), null);
    assert.equal(typeof sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '1', X_NOTIFICATION_INTAKE_KEY_ID: 'k', X_NOTIFICATION_INTAKE_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }).seal, 'function');
    assert.equal(sealerFromEnvironment({ X_NOTIFICATION_INTAKE_ENABLED: '1', X_NOTIFICATION_INTAKE_KEY_ID: 'k', X_NOTIFICATION_INTAKE_PUBLIC_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }), null);
    await assert.rejects(service.startSession(A, { consent: false }), code('X_SETUP_CONSENT_REQUIRED'));
    await assert.rejects(service.startSession(A, { consent: true, ownerUserId: B.userId }), code('X_SETUP_INVALID_INPUT'));
    await assert.rejects(service.status({ userId: '' }), code('AUTH_REQUIRED'));
    const file = fixture(), body = await payload(service, A, file);
    const preview = { sessionId: body.sessionId, fileText: body.fileText };
    assert.equal((await service.validate(A, preview)).valid, true);
    assert.equal((await service.validate(A, preview)).valid, true, 'preview does not consume token');
    await assert.rejects(service.validate(B, preview), code('X_SETUP_SESSION_INVALID'));
    const rows = await db.queryDatabase('SELECT * FROM automation_x_setup_sessions');
    assert.equal(rows.length, 1); assert(!JSON.stringify(rows).includes(body.sessionId));
    clock += SESSION_TTL_MS;
    await assert.rejects(service.importFile(A, body), code('X_SETUP_SESSION_EXPIRED'));
    const next = await payload(service, A, file);
    await assert.rejects(service.importFile(A, body), code('X_SETUP_SESSION_INVALID'));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_setup_sessions')).length, 1);
    await service.importFile(A, next);
    await assert.rejects(service.importFile(A, next), code('X_SETUP_SESSION_USED'));
}));

test('encrypted import survives service restart, never returns or audits secrets, and shares no quota', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer }), file = fixture();
    file.provenance.browserVersion = '1'.repeat(64);
    const body = await payload(service, A, file);
    const imported = await service.importFile(A, body);
    assert.equal(imported.duplicate, false); assert.equal(imported.subscription.state, 'stored');
    const restarted = createXSetup(db, { sealer: createTransferPublicSealer(vaultConfig) });
    const result = await restarted.status(A);
    assert.deepEqual(result.subscriptions, [imported.subscription]); assert.equal(result.receiverEnabled, false);
    assert.equal((await restarted.status(B)).subscriptions.length, 0);
    const row = (await db.queryDatabase('SELECT * FROM automation_x_subscriptions'))[0];
    assert(!row.sealed_json.includes(file.push.uaid));
    const worker = createTransferPrivateWorkerVault({ activeKeyId: 'fixture1', privateKeys: { fixture1: privateKey } });
    assert.deepEqual(worker.open(JSON.parse(row.sealed_json), { subscriptionId: row.id, ownerUserId: A.userId, revision: Number(row.revision) }), file);
    const exposed = JSON.stringify({ result, imported, rows: await db.queryDatabase('SELECT * FROM automation_audit'), sessions: await db.queryDatabase('SELECT * FROM automation_x_setup_sessions') });
    for (const secret of [file.push.uaid, file.push.channelID, file.push.pushEndpoint, file.push.authenticationSecret, file.push.p256dhPrivateKey.d, body.sessionId]) assert(!exposed.includes(secret));
    assert.equal((await db.queryDatabase('SELECT * FROM automation_notification_slots')).length, 0);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_monitors')).length, 0);
    const duplicate = await restarted.importFile(A, await payload(restarted, A, file));
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.subscription.id, row.id);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 1);
    await assert.rejects(restarted.importFile(B, await payload(restarted, B, file)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
    const changed = structuredClone(file); changed.push.authenticationSecret = randomBytes(16).toString('base64url');
    await assert.rejects(restarted.importFile(A, await payload(restarted, A, changed)), code('X_SETUP_SUBSCRIPTION_CONFLICT'));
}));

test('concurrent same-session, same-owner and cross-owner imports cannot duplicate or steal registration', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer }), file = fixture();
    const body = await payload(service, A, file);
    const same = await Promise.allSettled([service.importFile(A, body), service.importFile(A, body)]);
    assert.equal(same.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(same.find(row => row.status === 'rejected').reason.code, 'X_SETUP_SESSION_USED');
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 1);
    const another = fixture();
    const bodies = await Promise.all([payload(service, A, another), payload(service, B, another)]);
    const crossed = await Promise.allSettled([service.importFile(A, bodies[0]), service.importFile(B, bodies[1])]);
    assert.equal(crossed.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(crossed.find(row => row.status === 'rejected').reason.code, 'X_SETUP_SUBSCRIPTION_CONFLICT');
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 2);
}));

test('receipt status counts stay scoped to each owned subscription and expose no encrypted material', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    const first = (await service.importFile(A, await payload(service, A))).subscription;
    const second = (await service.importFile(A, await payload(service, A))).subscription;
    const foreign = (await service.importFile(B, await payload(service, B))).subscription;
    const empty = { received: 0, routed: 0, unsupported: 0, decryptionFailed: 0, unmatched: 0 };
    assert.deepEqual(first.receiptCounts, empty);
    const ciphertext = 'SYNTHETIC_PRIVATE_RECEIPT_CIPHERTEXT', header = 'SYNTHETIC_PRIVATE_RECEIPT_HEADER';
    async function record(subscription, state, receivedAtMs) {
        await db.queryDatabase(`INSERT INTO automation_x_push_inbox
            (subscription_id,subscription_revision,version,data_ciphertext,headers_json,ack_code,status,received_at_ms)
            VALUES (?,1,?,?,?,?,?,?)`, [subscription.id, randomUUID(), ciphertext, JSON.stringify({ encryption: header }),
            state === 'decryption_failed' ? 101 : 100, state, receivedAtMs]);
    }
    await record(first, 'received', 1000); await record(first, 'received', 2000);
    await record(first, 'routed', 3000); await record(first, 'unsupported', 4000); await record(first, 'decryption_failed', 5000);
    await record(first, 'unmatched', 5000); await record(first, 'unmatched', 5000);
    await record(second, 'routed', 6000);
    for (let index = 0; index < 7; index++) await record(foreign, 'unsupported', 7000 + index);
    for (let index = 0; index < 3; index++) await record(foreign, 'unmatched', 7100 + index);
    const before = await db.queryDatabase('SELECT id,status,received_at_ms,routed_at_ms FROM automation_x_push_inbox ORDER BY id');
    const own = await service.status(A), other = await service.status(B);
    assert.equal(own.subscriptions.length, 2);
    const one = own.subscriptions.find(item => item.id === first.id), two = own.subscriptions.find(item => item.id === second.id);
    assert.deepEqual(one.receiptCounts, { received: 2, routed: 1, unsupported: 1, decryptionFailed: 1, unmatched: 2 });
    assert.deepEqual(two.receiptCounts, { ...empty, routed: 1 });
    assert.equal(one.lastReceivedAtMs, 5000); assert.equal(two.lastReceivedAtMs, 6000);
    assert.deepEqual(other.subscriptions.map(item => item.id), [foreign.id]);
    assert.deepEqual(other.subscriptions[0].receiptCounts, { ...empty, unsupported: 7, unmatched: 3 });
    assert.equal(own.subscriptions.some(item => item.id === foreign.id), false);
    for (const secret of [ciphertext, header, foreign.id, B.userId]) assert(!JSON.stringify(own).includes(secret));
    assert.deepEqual(await db.queryDatabase('SELECT id,status,received_at_ms,routed_at_ms FROM automation_x_push_inbox ORDER BY id'), before,
        'status reads do not alter receipt state or delivery admission');
    await db.queryDatabase("UPDATE automation_x_push_inbox SET status='routed',routed_at_ms=8000 WHERE subscription_id=? AND status='received'", [first.id]);
    const updated = (await service.status(A)).subscriptions.find(item => item.id === first.id);
    assert.deepEqual(updated.receiptCounts, { received: 0, routed: 3, unsupported: 1, decryptionFailed: 1, unmatched: 2 });
    assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
}));

test('receipt status query failure propagates instead of reporting misleading zero counts', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    await service.importFile(A, await payload(service, A));
    const broken = createXSetup({ ...db, queryDatabase: async (sql, params) => {
        if (sql.includes('AS unsupported_count')) throw Object.assign(new Error('fixture receipt query failure'), { code: 'ER_FIXTURE_READ' });
        return db.queryDatabase(sql, params);
    } }, { sealer });
    await assert.rejects(broken.status(A), { code: 'ER_FIXTURE_READ' });
    assert.deepEqual((await service.status(A)).subscriptions[0].receiptCounts, { received: 0, routed: 0, unsupported: 0, decryptionFailed: 0, unmatched: 0 });
}));

test('DB/audit failure rolls back encrypted material, token consumption and deletion atomically', async t => setup(t, async db => {
    let broken = true;
    const faulty = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (broken && sql.startsWith('INSERT INTO automation_audit')) throw new Error('fixture DB failure');
        return query(sql, params);
    })) };
    const service = createXSetup(faulty, { sealer }), body = await payload(service, A);
    await assert.rejects(service.importFile(A, body), /fixture DB failure/);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_setup_sessions'))[0].consumed_at_ms, null);
    broken = false;
    const imported = await service.importFile(A, body), item = imported.subscription;
    const stalePreview = await payload(service, A, fixture());
    broken = true;
    await assert.rejects(service.remove(A, item.id, { expectedRevision: item.revision }), /fixture DB failure/);
    assert.equal((await service.status(A)).subscriptions.length, 1);
    broken = false;
    const disabled = createXSetup(db, { sealer: null });
    await assert.rejects(disabled.remove(B, item.id, { expectedRevision: item.revision }), code('NOT_FOUND'));
    await assert.rejects(disabled.remove(A, item.id, { expectedRevision: item.revision + 1 }), code('REVISION_CONFLICT'));
    assert.deepEqual(await disabled.remove(A, item.id, { expectedRevision: item.revision }), { deleted: true });
    assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    await assert.rejects(service.importFile(A, stalePreview), code('X_SETUP_SESSION_INVALID'));
    await assert.rejects(disabled.remove(A, item.id, { expectedRevision: item.revision }), code('NOT_FOUND'));
}));

test('dispatcher keeps setup private, server-owned and rate-limited with safe invalid input recovery', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    let operations = 0;
    const services = { db, xSetup: service, service: { withOperation: async (actor, group, work) => { operations++; return work(); } } };
    const request = (method, route, body) => ({ method, path: route.split('/'), body });
    await assert.rejects(dispatch(request('GET', 'x-setup'), { ...A, guildId: '111111111111111111' }, services), code('X_SETUP_PRIVATE_ONLY'));
    const { sessionId } = await dispatch(request('POST', 'x-setup/sessions', { consent: true }), A, services);
    await assert.rejects(dispatch(request('POST', 'x-setup/validate', { sessionId, fileText: '{"cookies":[]}' }), A, services), code('X_SETUP_INVALID_FILE'));
    const valid = await dispatch(request('POST', 'x-setup/validate', { sessionId, fileText: JSON.stringify(fixture()) }), A, services);
    assert.equal(valid.valid, true); assert.equal(operations, 3);
    await assert.rejects(dispatch(request('POST', 'x-setup/sessions', { consent: true }), A, { db, xSetup: service }), code('AUTOMATION_RATE_LIMIT_UNAVAILABLE'));
}));

test('owner list cursor is bounded and never exposes vault fields', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    // Metadata-only fixtures deliberately do not claim encrypted imports. They
    // exercise pagination without weakening the production importer or limits.
    for (let index = 1; index <= 101; index++) {
        const suffix = index.toString(16).padStart(12, '0'), fingerprint = index.toString(16).padStart(64, '0');
        await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,0,0)',
            [`00000000-0000-0000-0000-${suffix}`, A.userId, fingerprint, fingerprint, fingerprint, 'opaque fixture', 'fixture1', '160.0a1']);
    }
    const first = await service.status(A);
    assert.equal(first.subscriptions.length, 100); assert.equal(typeof first.nextCursor, 'string');
    const second = await service.status(A, { afterId: first.nextCursor });
    assert.equal(second.subscriptions.length, 1); assert.equal(second.nextCursor, null);
    assert(!JSON.stringify(first).includes('opaque fixture'));
    await assert.rejects(service.status(A, { afterId: 'other query' }), code('INVALID_CURSOR'));
}));

test('intake status shares the default batch policy and never enables the receiver flag implicitly', async t => setup(t, async db => {
    const keys = ['X_NOTIFICATION_RECEIVER_ENABLED', 'X_NOTIFICATION_PROCESSING_POLICY'];
    const previous = keys.map(key => process.env[key]);
    try {
        delete process.env.X_NOTIFICATION_PROCESSING_POLICY;
        delete process.env.X_NOTIFICATION_RECEIVER_ENABLED;
        assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, false);
        process.env.X_NOTIFICATION_RECEIVER_ENABLED = '1';
        assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, true, 'an explicit receiver flag uses the approved batch default');
        for (const mode of ['realtime', 'per-event', 'unknown']) {
            process.env.X_NOTIFICATION_PROCESSING_POLICY = mode;
            assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, false);
        }
        process.env.X_NOTIFICATION_PROCESSING_POLICY = 'batch';
        process.env.X_NOTIFICATION_RECEIVER_ENABLED = '0';
        assert.equal((await createXSetup(db, { sealer }).status(A)).receiverEnabled, false);
    } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
}));

test('additive SQL migration is repeatable and disabling intake preserves existing subscriptions and ordinary data', async t => setup(t, async db => {
    const service = createXSetup(db, { sealer });
    const imported = await service.importFile(A, await payload(service, A));
    const before = await db.queryDatabase('SELECT user_id,additional_auto_extract_slots,is_donor FROM users');
    const migration = readFileSync(path.resolve(__dirname, '../../migrations/20261014_add_x_notification_intake.sql'), 'utf8');
    const statements = migration.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    // Git may check JS templates and SQL files out with different line endings.
    // Preserve the exact SQL text check while treating CRLF and LF alike.
    const canonicalSql = value => value.replace(/\r\n/g, '\n').trim();
    const expected = require('../../src/automation/x-setup-schema.sql').SCHEMA.map(canonicalSql);
    assert.deepEqual(statements.map(canonicalSql), expected);
    for (const ending of ['\n', '\r\n']) {
        const variant = migration.replace(/\r\n/g, '\n').replace(/\n/g, ending);
        const parsed = variant.replace(/^--.*$/gm, '').split(';').map(canonicalSql).filter(Boolean);
        assert.deepEqual(parsed, expected, `migration SQL stays identical with ${JSON.stringify(ending)} lines`);
    }
    for (let repeat = 0; repeat < 2; repeat++) for (const statement of statements) await db.queryDatabase(statement);
    assert.deepEqual(await db.queryDatabase('SELECT user_id,additional_auto_extract_slots,is_donor FROM users'), before);
    const rolledBack = createXSetup(db, { sealer: null });
    assert.deepEqual((await rolledBack.status(A)).subscriptions, [imported.subscription]);
    assert.equal((await rolledBack.status(A)).available, false);
    await rolledBack.remove(A, imported.subscription.id, { expectedRevision: 1 });
    assert.equal((await rolledBack.status(A)).subscriptions.length, 0);
}));
