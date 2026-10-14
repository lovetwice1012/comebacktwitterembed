'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer } = require('../../src/automation/x-setup-transfer');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { evaluateXRollout } = require('../../src/automation/x-rollout-policy');
const { createService } = require('../../src/automation/service');
const { newWorkflow } = require('../../src/automation/schema');
const entitlements = require('../../src/automation/entitlements');
const grants = require('../../src/automation/push-support-grants');

// Every SQL operation is restricted to the agreed disposable loopback fixture.
// No Square, X, Mozilla, Discord or production request is made by this file.
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('X binding SQL tests require disposable AUTOMATION_TEST_DB_PORT=33621');
const A = { userId: '222222222222222222' }, B = { userId: '333333333333333333' };
const C = { userId: '555555555555555555' }, D = { userId: '666666666666666666' }, ADMIN = { userId: '444444444444444444', isAdmin: true };
const NOW = Date.parse('2026-10-14T00:00:00Z');
const SCOPE = { environment: 'sandbox', merchantId: 'X-BINDING-SYNTHETIC' };
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const sealer = createTransferPublicSealer({ activeKeyId: 'binding-fixture', publicKeys: { 'binding-fixture': publicKey } });
const target = index => ({ accountId: String(10000 + index), accountHandle: `fixture${index}`, name: `対象 ${index}` });
const errorCode = code => error => error.code === code;
const queryRow = async (db, table, id) => (await db.queryDatabase(`SELECT * FROM ${table} WHERE id=?`, [id]))[0];

function file() {
    const ec = createECDH('prime256v1'); ec.generateKeys(); const point = ec.getPublicKey(undefined, 'uncompressed');
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0a1', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: randomUUID(), channelID: randomUUID(), pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-BINDING-ONLY', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: point.toString('base64url'), authenticationSecret: randomBytes(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'), d: ec.getPrivateKey().toString('base64url'), ext: true, key_ops: ['deriveBits'] } } };
}
async function fixture(work) {
    const db = await createTestDatabase(port);
    try {
        for (const actor of [A, B, C, D]) await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,0)', [actor.userId]);
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN,
            { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        await work(db);
    } finally { await db.close(); }
}
const setupFor = (db, options = {}) => createXSetup(db, { sealer, now: () => NOW, rolloutMode: 'public', ...options });
const quotaFor = (db, options = {}) => createXMonitorQuota(db, { registrationEnabled: true, now: () => NOW, rolloutMode: 'public', ...options });
async function importBody(setup, actor = A) {
    const session = await setup.startSession(actor, { consent: true });
    return { sessionId: session.sessionId, fileText: JSON.stringify(file()), consent: true };
}
async function importProfile(setup, actor = A) { return (await setup.importFile(actor, await importBody(setup, actor))).subscription; }
async function settingsFor(db, actor = A) {
    const service = createService(db), destination = await service.saveDestination(actor, { name: '保持する本人DM', kind: 'dm' });
    const workflow = await service.createWorkflow(actor, { definition: newWorkflow('保持する詳細ルール') });
    return { destinationId: destination.id, workflowId: workflow.id };
}
async function receiverAndInbox(db, profile) {
    await db.queryDatabase("INSERT INTO automation_x_push_receivers (subscription_id,state,subscription_revision,lease_expires_at_ms,updated_at_ms) VALUES (?,'listening',?,?,?)",
        [profile.id, profile.revision, NOW + 30000, NOW]);
    await db.queryDatabase("INSERT INTO automation_x_push_inbox (subscription_id,subscription_revision,version,data_ciphertext,headers_json,ack_code,status,received_at_ms) VALUES (?,?,'synthetic-binding','AA','{}',100,'received',?)",
        [profile.id, profile.revision, NOW]);
}
async function normalNotification(db, actor = A) {
    const source = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/example/repository',3600000,?)", [randomUUID(), NOW]);
    const result = await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_type,destination_key,enabled,created_at_ms) VALUES (?,?,'dm',?,1,?)", [actor.userId, source.insertId, `dm:${actor.userId}`, NOW]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, actor.userId, 'auto', String(result.insertId)));
    return { id: String(result.insertId), sourceId: String(source.insertId) };
}
function gateAfter(db, pattern) {
    let entered, release, used = false;
    const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    return { reached, release, db: { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (!used && pattern.test(sql)) { used = true; entered(); await gate; }
        return result;
    })) } };
}
async function bounded(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); })]); }
    finally { clearTimeout(timer); }
}

test('real SQL missing rollout defaults closed for intake and monitoring, with no subscription or session saved', { timeout: 30000 }, async () => fixture(async db => {
    const previous = process.env.X_NOTIFICATION_ROLLOUT;
    try {
        delete process.env.X_NOTIFICATION_ROLLOUT;
        const setup = createXSetup(db, { sealer, now: () => NOW }), quota = createXMonitorQuota(db, { registrationEnabled: true });
        assert.equal((await setup.status(A)).available, false);
        assert.equal((await setup.status(A)).rollout.reasonCode, 'X_ROLLOUT_DISABLED');
        assert.equal((await quota.summary(A)).featureEnabled, false);
        await assert.rejects(setup.startSession(A, { consent: true }), errorCode('X_ROLLOUT_DISABLED'));
        await assert.rejects(quota.register(A, target(1)), errorCode('X_ROLLOUT_DISABLED'));
        for (const table of ['automation_x_subscriptions', 'automation_x_setup_sessions', 'automation_x_monitors'])
            assert.equal((await db.queryDatabase(`SELECT * FROM ${table}`)).length, 0);
    } finally { if (previous === undefined) delete process.env.X_NOTIFICATION_ROLLOUT; else process.env.X_NOTIFICATION_ROLLOUT = previous; }
}));

test('real SQL supporter beta follows reviewed donor flag, independently of paid contract and newly verified donation grants', { timeout: 30000 }, async () => fixture(async db => {
    await db.queryDatabase('UPDATE users SET is_donor=1 WHERE user_id=?', [A.userId]);
    await db.withDatabaseTransaction(async query => {
        await entitlements.savePlanPolicy(query, ADMIN, { planId: 'BindingPaid', label: 'Paid SQL fixture', slotLimit: 9, minuteLimit: 9, dayLimit: 90, priority: 9, intervalMinutes: 15 });
        await entitlements.setUserPlan(query, ADMIN, B.userId, 'BindingPaid');
        await grants.migrateLegacyGrants(query, C.userId, { scope: SCOPE, now: NOW });
    });
    // Seed only a synthetic already-verified local ledger row; never initiate a payment.
    const attemptId = randomUUID();
    await db.queryDatabase(`INSERT INTO automation_square_donation_attempts
        (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,payment_id,verified,expires_at_ms,completed_at_ms,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,500,'JPY','fixture@example.invalid','Synthetic',0,'COMPLETED',?,1,0,?,?,?)`,
    [attemptId, C.userId, SCOPE.environment, SCOPE.merchantId, 'SYNTHETIC-LOCATION', 'SYNTHETIC-APP', `synthetic-${attemptId}`, NOW, NOW, NOW]);
    const applied = await db.withDatabaseTransaction(query => grants.applyVerifiedDonationGrant(query, attemptId, { scope: SCOPE, now: NOW }));
    assert.equal(applied.grant.slots, 1);
    assert.equal((await grants.getSupporterHolding(db.queryDatabase, C.userId, NOW, SCOPE)).isSupporter, true);
    assert.equal(Number((await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [C.userId]))[0].is_donor), 0);
    const setup = setupFor(db, { rolloutMode: 'supporters' }), quota = quotaFor(db, { rolloutMode: 'supporters' });
    assert.equal((await setup.status(A)).available, true); assert.equal((await quota.summary(A)).featureEnabled, true);
    await importProfile(setup, A); await quota.register(A, target(2));
    for (const actor of [B, C, D]) {
        assert.equal((await evaluateXRollout(db.queryDatabase, actor, { mode: 'supporters' })).eligible, false);
        assert.equal((await setup.status(actor)).available, false); assert.equal((await quota.summary(actor)).featureEnabled, false);
        await assert.rejects(setup.startSession(actor, { consent: true }), errorCode('X_ROLLOUT_SUPPORTERS_ONLY'));
        await assert.rejects(quota.register(actor, target(3)), errorCode('X_ROLLOUT_SUPPORTERS_ONLY'));
    }
    assert.equal((await quota.summary(B)).currentPlan.tier, 'paid');
}));

test('real SQL revocation after session preview prevents import without consuming the reusable confirmation', { timeout: 30000 }, async () => fixture(async db => {
    await db.queryDatabase('UPDATE users SET is_donor=1 WHERE user_id=?', [A.userId]);
    const setup = setupFor(db, { rolloutMode: 'supporters' }), body = await importBody(setup);
    assert.equal((await setup.validate(A, { sessionId: body.sessionId, fileText: body.fileText })).valid, true);
    const before = (await db.queryDatabase('SELECT * FROM automation_x_setup_sessions WHERE owner_user_id=?', [A.userId]))[0];
    await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [A.userId]);
    await assert.rejects(setup.importFile(A, body), errorCode('X_ROLLOUT_SUPPORTERS_ONLY'));
    assert.deepEqual((await db.queryDatabase('SELECT * FROM automation_x_setup_sessions WHERE owner_user_id=?', [A.userId]))[0], before);
    assert.equal(before.consumed_at_ms, null); assert.equal((await db.queryDatabase('SELECT * FROM automation_x_subscriptions')).length, 0);
    await db.queryDatabase('UPDATE users SET is_donor=1 WHERE user_id=?', [A.userId]);
    assert.equal((await setup.importFile(A, body)).duplicate, false);
}));

test('real SQL one owned profile binds multiple authors, profiles do not consume slots, and foreign bindings return owner-safe 404', { timeout: 30000 }, async () => fixture(async db => {
    const setup = setupFor(db), quota = quotaFor(db), profile = await importProfile(setup);
    assert.equal((await quota.summary(A)).personal.used, 0);
    const settings = await settingsFor(db), config = { ...settings, subscriptionId: profile.id };
    const first = await quota.register(A, { ...target(10), notificationSettings: config });
    const second = await quota.register(A, { ...target(11), notificationSettings: config });
    const spareProfile = await importProfile(setup), foreign = await importProfile(setup, B);
    const status = await setup.status(A), allowance = await quota.summary(A);
    assert.equal(status.subscriptions.length, 2);
    assert.equal(status.subscriptions.find(row => row.id === profile.id).boundMonitorCount, 2);
    assert.equal(status.subscriptions.find(row => row.id === spareProfile.id).boundMonitorCount, 0);
    assert.equal(allowance.personal.registeredCount, 2); assert.equal(allowance.personal.used, 2); assert.equal(allowance.x.used, 2);
    assert.equal(first.poolKind, 'free'); assert.equal(second.poolKind, 'free');
    await assert.rejects(quota.register(A, { ...target(12), notificationSettings: { subscriptionId: foreign.id } }), { code: 'NOT_FOUND', status: 404 });
    await assert.rejects(quota.update(A, first.id, { expectedRevision: first.revision, notificationSettings: { ...settings, subscriptionId: foreign.id } }), { code: 'NOT_FOUND', status: 404 });
    const unchanged = (await quota.list(A)).items.find(row => row.id === first.id);
    assert.equal(unchanged.revision, first.revision); assert.deepEqual(unchanged.notificationSettings, config);
    assert.deepEqual((await setup.status(B)).subscriptions.map(row => row.id), [foreign.id]);
    assert.equal((await quota.summary(A)).personal.used, 2);
}));

test('real SQL deleting receive material unbinds atomically, preserves normal notifications and reservations, and invalidates stale CAS', { timeout: 30000 }, async () => fixture(async db => {
    const setup = setupFor(db), quota = quotaFor(db), native = await normalNotification(db), profile = await importProfile(setup);
    const settings = await settingsFor(db), config = { ...settings, subscriptionId: profile.id };
    const targets = await Promise.all([10, 11].map(index => quota.register(A, { ...target(index), notificationSettings: config })));
    await receiverAndInbox(db, profile); await importBody(setup);
    const slotsBefore = await db.queryDatabase('SELECT * FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [A.userId]);
    const nativeBefore = await queryRow(db, 'auto_watch_targets', native.id), sourceBefore = await queryRow(db, 'auto_watch_sources', native.sourceId);
    const workflowBefore = await queryRow(db, 'automation_workflows', settings.workflowId), destinationBefore = await queryRow(db, 'automation_destinations', settings.destinationId);
    assert.deepEqual(await setup.remove(A, profile.id, { expectedRevision: profile.revision }), { deleted: true });
    for (const row of (await quota.list(A)).items) {
        const previous = targets.find(item => item.id === row.id);
        assert.deepEqual(row.notificationSettings, settings); assert.equal(row.subscriptionState, 'pending');
        assert.equal(row.revision, previous.revision + 1); assert.equal(row.enabled, previous.enabled); assert.equal(row.state, previous.state); assert.equal(row.poolKind, previous.poolKind);
        await assert.rejects(quota.update(A, row.id, { expectedRevision: previous.revision, name: 'stale edit' }), errorCode('X_MONITOR_REVISION_CONFLICT'));
    }
    assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [A.userId]), slotsBefore);
    assert.deepEqual(await queryRow(db, 'auto_watch_targets', native.id), nativeBefore); assert.deepEqual(await queryRow(db, 'auto_watch_sources', native.sourceId), sourceBefore);
    assert.deepEqual(await queryRow(db, 'automation_workflows', settings.workflowId), workflowBefore); assert.deepEqual(await queryRow(db, 'automation_destinations', settings.destinationId), destinationBefore);
    assert.equal((await quota.summary(A)).personal.used, 3);
    for (const table of ['automation_x_subscriptions', 'automation_x_push_receivers', 'automation_x_push_inbox', 'automation_x_setup_sessions']) assert.equal((await db.queryDatabase(`SELECT * FROM ${table}`)).length, 0);
}));

test('real SQL manual move waiting for owner observes subscription deletion revision and rejects stale CAS', { timeout: 30000 }, async () => fixture(async db => {
    const setup = setupFor(db), profile = await importProfile(setup), row = await quotaFor(db).register(A, { ...target(20), notificationSettings: { subscriptionId: profile.id } });
    const removal = gateAfter(db, /^SELECT user_id FROM users WHERE user_id=\? FOR UPDATE$/), moving = gateAfter(db, /^SELECT \* FROM automation_x_monitors WHERE id=\? AND state<>'deleted'/);
    const deleting = setupFor(removal.db).remove(A, profile.id, { expectedRevision: profile.revision });
    let move;
    try {
        await bounded(removal.reached, 'deletion never acquired owner lock');
        move = assert.rejects(quotaFor(moving.db).move(A, row.id, { poolKind: 'free', expectedRevision: row.revision }), errorCode('X_MONITOR_REVISION_CONFLICT'));
        await bounded(moving.reached, 'manual move never read pre-lock snapshot');
        moving.release(); removal.release();
        await bounded(Promise.all([deleting, move]), 'owner deletion/manual move did not finish');
        const saved = (await quotaFor(db).list(A)).items[0];
        assert.equal(saved.revision, row.revision + 1); assert.equal(saved.poolKind, row.poolKind); assert.deepEqual(saved.notificationSettings, {});
    } finally { moving.release(); removal.release(); await Promise.allSettled([deleting, ...(move ? [move] : [])]); }
}));

test('real SQL audit failure after encrypted delete rolls back binding, session deletion and receiver cascades', { timeout: 30000 }, async () => fixture(async db => {
    const setup = setupFor(db), profile = await importProfile(setup), row = await quotaFor(db).register(A, { ...target(30), notificationSettings: { subscriptionId: profile.id } });
    await receiverAndInbox(db, profile); await importBody(setup);
    const subscriptionBefore = await queryRow(db, 'automation_x_subscriptions', profile.id), monitorBefore = await queryRow(db, 'automation_x_monitors', row.id);
    const sessionsBefore = await db.queryDatabase('SELECT * FROM automation_x_setup_sessions'), receiversBefore = await db.queryDatabase('SELECT * FROM automation_x_push_receivers'), inboxBefore = await db.queryDatabase('SELECT * FROM automation_x_push_inbox');
    let triggered = false;
    const faulty = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (sql.startsWith('INSERT INTO automation_audit') && params[2] === 'x.setup.delete') {
            triggered = true; await query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='binding fixture audit failure'");
        }
        return result;
    })) };
    await assert.rejects(setupFor(faulty).remove(A, profile.id, { expectedRevision: profile.revision }), /binding fixture audit failure/);
    assert.equal(triggered, true); assert.deepEqual(await queryRow(db, 'automation_x_subscriptions', profile.id), subscriptionBefore);
    assert.deepEqual(await queryRow(db, 'automation_x_monitors', row.id), monitorBefore);
    assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_setup_sessions'), sessionsBefore);
    assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_push_receivers'), receiversBefore); assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_push_inbox'), inboxBefore);
    assert.equal((await db.queryDatabase("SELECT * FROM automation_audit WHERE action IN ('x.setup.unbind','x.setup.delete')")).length, 0);
}));

test('real SQL integrity accepts owned subscriptions, identifies foreign or missing bindings, and expired listening is stopped', { timeout: 30000 }, async () => fixture(async db => {
    const setup = setupFor(db), quota = quotaFor(db), profile = await importProfile(setup), foreign = await importProfile(setup, B);
    const row = await quota.register(A, { ...target(40), notificationSettings: { subscriptionId: profile.id } });
    assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
    for (const subscriptionId of [foreign.id, randomUUID()]) {
        await db.queryDatabase('UPDATE automation_x_monitors SET notification_settings_json=? WHERE id=?', [JSON.stringify({ subscriptionId }), row.id]);
        assert((await quota.integrity(ADMIN)).issues.some(issue => issue.code === 'INVALID_SUBSCRIPTION_BINDING' && issue.id === row.id));
    }
    await db.queryDatabase('UPDATE automation_x_monitors SET notification_settings_json=? WHERE id=?', [JSON.stringify({ subscriptionId: profile.id }), row.id]);
    await receiverAndInbox(db, profile);
    await db.queryDatabase('UPDATE automation_x_push_receivers SET lease_expires_at_ms=? WHERE subscription_id=?', [NOW - 1, profile.id]);
    const status = await setup.status(A);
    assert.equal(status.subscriptions[0].state, 'stored'); assert.equal(status.subscriptions[0].receiverState, 'stopped');
    assert.equal(status.subscriptions[0].boundMonitorCount, 1); assert.equal(status.subscriptions[0].lastReceivedAtMs, NOW);
    assert.deepEqual((await quota.integrity(ADMIN)).issues, []);
}));
