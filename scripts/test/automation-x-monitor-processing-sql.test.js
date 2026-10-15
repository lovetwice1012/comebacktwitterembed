'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { inspectXMonitorProcessing } = require('../../src/automation/x-processing-settings');
const entitlements = require('../../src/automation/entitlements');
const capacity = require('../../src/automation/push-capacity');
const cadence = require('../../src/automation/monitor-cadence');
const { createService, hash } = require('../../src/automation/service');
const { createQueue } = require('../../src/automation/queue');
const { createDonorAdmin } = require('../../src/automation/donor-admin');
const { dispatch } = require('../../src/automation/api');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('Per-monitor realtime SQL requires disposable AUTOMATION_TEST_DB_PORT=33621');
const ADMIN = { userId: '444444444444444444', isAdmin: true };
const owner = index => ({ userId: String(222222223000000000n + BigInt(index)) });
const account = index => ({ accountHandle: `rt_fixture_${index}`, name: `Realtime fixture ${index}` });
const options = { registrationEnabled: true, rolloutMode: 'public' };
const apiFor = db => createXMonitorQuota(db, options);
const raw = async (db, id) => (await db.queryDatabase('SELECT * FROM automation_x_monitors WHERE id=?', [id]))[0];
const extra = async (db, user) => db.queryDatabase("SELECT * FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind='x' ORDER BY slot_index", [user.userId]);
const usage = (db, user) => entitlements.getEntitlementSummary(db, user.userId);
const current = async (api, user, id) => (await api.list(user)).items.find(row => row.id === id);
async function pools(db, free = 50, supporter = 100) {
    return db.withDatabaseTransaction(async query => {
        const old = await capacity.getPoolPolicy(query, ADMIN);
        await capacity.savePoolPolicy(query, ADMIN, { freePoolLimit: free, supporterPoolLimit: supporter, expectedUpdatedAtMs: old.updatedAtMs });
    });
}
async function manual(db, user, slots, donor = false) {
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,?,?) ON DUPLICATE KEY UPDATE is_donor=VALUES(is_donor),additional_auto_extract_slots=VALUES(additional_auto_extract_slots)', [user.userId, donor ? 1 : 0, slots]);
}
async function paid(db, user, realtime = true, limit = 10) {
    const planId = `rtplan${user.userId.slice(-6)}`;
    await db.withDatabaseTransaction(async query => {
        await entitlements.savePlanPolicy(query, ADMIN, { planId, label: 'Configured realtime plan', slotLimit: limit, minuteLimit: 7, dayLimit: 31, priority: 13, intervalMinutes: 15 });
        const old = await capacity.getPlanCapacity(query, ADMIN, planId);
        await capacity.savePlanCapacity(query, ADMIN, planId, { eligible: true, specialSlotLimit: 3, realtimeEnabled: realtime, expectedUpdatedAtMs: old.updatedAtMs });
        await entitlements.setUserPlan(query, ADMIN, user.userId, planId);
    });
    return planId;
}
async function native(db, user) {
    await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [user.userId]);
    const source = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/synthetic/realtime-fixture',3600000,0)", [randomUUID()]);
    const target = await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_type,destination_key,enabled,created_at_ms) VALUES (?,?,'dm',?,1,0)", [user.userId, source.insertId, `dm:${user.userId}`]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, user.userId, 'auto', String(target.insertId)));
    return String(target.insertId);
}
function faultAfter(db, pattern) {
    let injected = false;
    return { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (!injected && pattern.test(sql)) { injected = true; await query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic realtime transaction failure'"); }
        return result;
    })) };
}
async function afterRestart(db, user, id) {
    const code = `
      const mysql=require('mysql');const [schema,port,owner,id]=process.argv.slice(1);
      if(!/^cbte_automation_test_[0-9a-f]{20}$/.test(schema)||Number(port)!==33621)throw new Error('Invalid disposable fixture');
      const connection=mysql.createConnection({host:'127.0.0.1',port:Number(port),user:'root',password:process.env.AUTOMATION_TEST_DB_PASSWORD||'',database:schema,supportBigNumbers:true,bigNumberStrings:true,multipleStatements:false});
      const query=(sql,args=[])=>new Promise((resolve,reject)=>connection.query(sql,args,(error,rows)=>error?reject(error):resolve(rows)));
      (async()=>{try{const row=(await query('SELECT * FROM automation_x_monitors WHERE id=? AND owner_user_id=?',[id,owner]))[0];
        const result=await require('./src/automation/x-processing-settings').inspectXMonitorProcessing(query,row);
        process.stdout.write(JSON.stringify(result));}finally{await new Promise(resolve=>connection.end(resolve));}})().catch(()=>{process.stderr.write('SYNTHETIC_RESTART_CHECK_FAILED');process.exitCode=1;});`;
    const result = await promisify(execFile)(process.execPath, ['-e', code, db.schema, String(port), user.userId, id], { cwd: require('node:path').resolve(__dirname, '../..'), timeout: 30000, windowsHide: true });
    return JSON.parse(result.stdout);
}
async function receiveFixture(db, api, user, row) {
    const subscriptionId = randomUUID(), now = Date.now();
    await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,1,?,?)', [subscriptionId, user.userId, hash(randomUUID()), hash(randomUUID()), hash(randomUUID()), '{}', 'synthetic-realtime-key', 'synthetic-browser', now, now]);
    await db.queryDatabase("INSERT INTO automation_x_push_receivers (subscription_id,state,subscription_revision,updated_at_ms) VALUES (?,'listening',1,?)", [subscriptionId, now]);
    const bound = await api.update(user, row.id, { expectedRevision: row.revision, notificationSettings: { subscriptionId } });
    const inbox = await db.queryDatabase("INSERT INTO automation_x_push_inbox (subscription_id,subscription_revision,version,data_ciphertext,headers_json,ack_code,status,received_at_ms) VALUES (?,1,?,'SYNTHETIC','{}',100,'received',?)", [subscriptionId, randomUUID(), now]);
    const payload = { notificationType: 'tweet', url: `https://x.com/${row.accountHandle}/status/1234567890123456789`, author: { handle: row.accountHandle }, title: 'Synthetic public post', text: 'Synthetic queue fixture' };
    return { bound, input: { ownerUserId: user.userId, monitorId: row.id, subscriptionId, inboxEventId: String(inbox.insertId), payload } };
}

test('per-monitor realtime uses existing physical slots, current privileges and atomic owner-safe choices', { timeout: 180000 }, async t => {
    const db = await createTestDatabase(port), api = apiFor(db);
    t.after(() => db.close());
    await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));

    await t.test('a free owner explicitly reserves five personal slots and one global pool entry for realtime', async () => {
        const user = owner(1);
        const preview = (await api.summary(user)).registrationProcessing;
        assert.equal(preview.poolKind, 'free'); assert.equal(preview.realtimeSlotCost, 5); assert.equal(preview.canEnableRealtime, true);
        const row = await api.register(user, { ...account(1), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal(row.processing.effectiveMode, 'realtime'); assert.equal(row.processing.realtimeSource, 'slots'); assert.equal(row.processing.slotCost, 5);
        assert.equal(row.poolKind, 'free'); assert.equal(row.quality.priority, 0); assert.equal(row.quality.minuteLimit, 5); assert.equal(row.quality.dayLimit, 24);
        assert.equal((await usage(db, user)).usedSlots, 5); assert.equal((await extra(db, user)).length, 4);
        assert.equal((await api.summary(user)).x.used, 1);
        const again = await api.register(user, { ...account(1), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal(again.id, row.id); assert.equal((await usage(db, user)).usedSlots, 5);
    });

    await t.test('explicit realtime requires the reviewed cost and invalid cost input changes no allocation', async () => {
        const user = owner(2);
        for (const expectedRealtimeSlotCost of [undefined, 2, '5', true]) await assert.rejects(api.register(user, { ...account(2), processingMode: 'realtime', expectedRealtimeSlotCost }), { code: 'X_MONITOR_INVALID_INPUT' });
        assert.equal((await api.list(user)).items.length, 0); assert.equal((await extra(db, user)).length, 0);
    });

    await t.test('an existing native notification prevents an unqualified five-slot realtime registration atomically', async () => {
        const user = owner(3); await native(db, user);
        await assert.rejects(api.register(user, { ...account(3), processingMode: 'realtime', expectedRealtimeSlotCost: 5 }), { code: 'X_REALTIME_SLOT_LIMIT' });
        assert.equal((await api.list(user)).items.length, 0); assert.equal((await usage(db, user)).usedSlots, 1); assert.equal((await extra(db, user)).length, 0);
        assert.equal((await api.register(user, account(3))).processing.effectiveMode, 'batch');
    });

    await t.test('a plan flag gives one-slot realtime without changing rate limits or requiring a batch interval', async () => {
        const user = owner(4), planId = await paid(db, user);
        await db.queryDatabase('UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id=?', [planId]);
        const row = await api.register(user, { ...account(4), processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        assert.equal(row.processing.effectiveMode, 'realtime'); assert.equal(row.processing.realtimeSource, 'plan'); assert.equal(row.processing.configured, true);
        assert.equal(row.processing.intervalMinutes, null); assert.equal(row.processing.slotCost, 1); assert.equal((await extra(db, user)).length, 0);
        assert.deepEqual([row.quality.priority, row.quality.minuteLimit, row.quality.dayLimit], [13, 7, 31]);
    });

    await t.test('a one-slot preview becoming five slots returns conflict before creating or charging extra slots', async () => {
        const user = owner(5), planId = await paid(db, user);
        assert.equal((await api.summary(user)).registrationProcessing.realtimeSlotCost, 1);
        await db.queryDatabase('UPDATE automation_push_plan_policy SET realtime_enabled=0 WHERE plan_id=?', [planId]);
        await assert.rejects(api.register(user, { ...account(5), processingMode: 'realtime', expectedRealtimeSlotCost: 1 }), { code: 'X_REALTIME_COST_CONFLICT', status: 409 });
        assert.equal((await api.list(user)).items.length, 0); assert.equal((await extra(db, user)).length, 0);
    });

    await t.test('only the existing donor flag plus a qualified supporter pool gives supporter realtime', async () => {
        const usedFree = Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_x_monitors WHERE pool_kind='free' AND state<>'deleted'"))[0].n);
        await pools(db, usedFree, 100);
        const old = owner(6); await manual(db, old, 2, true);
        const row = await api.register(old, { ...account(6), processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        assert.equal(row.poolKind, 'supporter'); assert.equal(row.processing.realtimeSource, 'supporter'); assert.equal(row.processing.slotCost, 1); assert.equal(row.quality.planId, 'supporter');
        const newer = owner(7); await manual(db, newer, 2, false);
        assert.equal((await api.summary(newer)).registrationProcessing.realtimeSlotCost, 5);
        await assert.rejects(api.register(newer, { ...account(7), processingMode: 'realtime', expectedRealtimeSlotCost: 1 }), { code: 'X_REALTIME_COST_CONFLICT' });
        const five = await api.register(newer, { ...account(7), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal(five.processing.realtimeSource, 'slots'); assert.equal(five.processing.slotCost, 5);
        await pools(db);
    });

    await t.test('new allocation stays free-first even when a donor could get cheaper realtime in the supporter pool', async () => {
        const user = owner(8); await manual(db, user, 1, true);
        const preview = (await api.summary(user)).registrationProcessing;
        assert.equal(preview.poolKind, 'free'); assert.equal(preview.realtimeSlotCost, 5);
        const row = await api.register(user, { ...account(8), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal(row.poolKind, 'free'); assert.equal(row.processing.realtimeSource, 'slots');
    });

    await t.test('explicit batch releases four boosts, preserves metadata and deletion releases the base only once', async () => {
        const user = owner(9), service = createService(db), destination = await service.saveDestination(user, { name: 'Synthetic DM', kind: 'dm' });
        const first = await api.register(user, { ...account(9), notificationSettings: { destinationId: destination.id }, processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        const edited = await api.update(user, first.id, { expectedRevision: first.revision, name: '変更した表示名', notificationSettings: { destinationId: destination.id } });
        assert.equal(edited.processing.explicitMode, 'realtime'); assert.equal(edited.processing.slotCost, 5); assert.equal(edited.notificationSettings.processingMode, 'realtime');
        const batch = await api.update(user, first.id, { expectedRevision: edited.revision, processingMode: 'batch' });
        assert.equal(batch.processing.effectiveMode, 'batch'); assert.equal(batch.processing.slotCost, 1); assert.equal(batch.poolKind, first.poolKind); assert.equal(batch.accountHandle, first.accountHandle);
        assert.equal(batch.notificationSettings.destinationId, destination.id); assert.equal((await extra(db, user)).length, 0);
        await api.release(user, first.id, { expectedRevision: batch.revision });
        assert.equal((await usage(db, user)).usedSlots, 0); assert.equal((await api.release(user, first.id)).released, false);
    });

    await t.test('two concurrent explicit realtime choices cannot double-book the same four remaining physical slots', async () => {
        const user = owner(10); await manual(db, user, 1, false);
        const one = await api.register(user, account(10)), two = await api.register(user, account(11));
        const results = await Promise.allSettled([one, two].map(row => api.update(user, row.id, { expectedRevision: row.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 5 })));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.code, 'X_REALTIME_SLOT_LIMIT');
        assert.equal((await extra(db, user)).length, 4); assert.equal((await usage(db, user)).usedSlots, 6);
    });

    await t.test('a plan upgrade preserves five reserved slots until the owner explicitly re-saves realtime at one slot', async () => {
        const user = owner(12), row = await api.register(user, { ...account(12), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        await paid(db, user);
        const upgraded = await current(api, user, row.id);
        assert.equal(upgraded.processing.slotCost, 5); assert.equal(upgraded.processing.realtimeSlotCost, 1); assert.equal(upgraded.processing.realtimeSource, 'plan');
        const saved = await api.update(user, row.id, { expectedRevision: upgraded.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        assert.equal(saved.processing.slotCost, 1); assert.equal((await extra(db, user)).length, 0);
    });

    await t.test('plan privilege loss preserves the explicit choice without silently adding four slots during metadata edits', async () => {
        const user = owner(13), planId = await paid(db, user), row = await api.register(user, { ...account(13), processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        await db.queryDatabase('UPDATE automation_push_plan_policy SET realtime_enabled=0 WHERE plan_id=?', [planId]);
        const edited = await api.update(user, row.id, { expectedRevision: row.revision, name: '特典変更後' });
        assert.equal(edited.processing.requestedMode, 'realtime'); assert.equal(edited.processing.effectiveMode, 'batch'); assert.equal(edited.processing.slotCost, 1);
        assert.equal((await extra(db, user)).length, 0);
        await assert.rejects(api.update(user, row.id, { expectedRevision: edited.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 1 }), { code: 'X_REALTIME_COST_CONFLICT' });
        assert.equal((await current(api, user, row.id)).revision, edited.revision);
    });

    await t.test('downgrade retains out-of-limit boost reservations but uses batch until explicit OFF returns them', async () => {
        const user = owner(21); await paid(db, user, false);
        for (let index = 0; index < 4; index++) await native(db, user);
        const row = await api.register(user, { ...account(21), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal((await usage(db, user)).usedSlots, 9);
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, user.userId, null));
        await api.reconcile(user);
        const downgraded = await current(api, user, row.id);
        assert.equal(downgraded.state, 'ready'); assert.equal(downgraded.processing.requestedMode, 'realtime'); assert.equal(downgraded.processing.effectiveMode, 'batch');
        assert.equal(downgraded.processing.slotCost, 5); assert.equal(downgraded.processing.canEnableRealtime, false); assert.equal((await extra(db, user)).length, 4);
        const off = await api.update(user, row.id, { expectedRevision: downgraded.revision, processingMode: 'batch' });
        assert.equal(off.processing.slotCost, 1); assert.equal((await usage(db, user)).usedSlots, 5);
    });

    await t.test('revoking only the old donor flag removes its realtime privilege without erasing the supporter holding or buying slots', async () => {
        const user = owner(22); await manual(db, user, 2, true);
        const first = await api.register(user, account(22));
        const inSupporter = await api.move(user, first.id, { expectedRevision: first.revision, poolKind: 'supporter' });
        const realtime = await api.update(user, first.id, { expectedRevision: inSupporter.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [user.userId]);
        const revoked = await current(api, user, first.id);
        assert.equal(realtime.processing.realtimeSource, 'supporter'); assert.equal(revoked.poolKind, 'supporter');
        assert.equal(revoked.processing.effectiveMode, 'batch'); assert.equal(revoked.processing.requestedMode, 'realtime'); assert.equal(revoked.processing.slotCost, 1);
        assert.equal((await extra(db, user)).length, 0);
    });

    await t.test('manual moves can release existing boosts on gaining the donor privilege but never add them on losing it', async () => {
        const user = owner(14); await manual(db, user, 2, true);
        const row = await api.register(user, { ...account(14), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        const moved = await api.move(user, row.id, { expectedRevision: row.revision, poolKind: 'supporter' });
        assert.equal(moved.processing.slotCost, 1); assert.equal(moved.processing.realtimeSource, 'supporter'); assert.equal((await extra(db, user)).length, 0);
        const back = await api.move(user, row.id, { expectedRevision: moved.revision, poolKind: 'free' });
        assert.equal(back.poolKind, 'free'); assert.equal(back.processing.requestedMode, 'realtime'); assert.equal(back.processing.effectiveMode, 'batch'); assert.equal((await extra(db, user)).length, 0);
    });

    await t.test('a manual move waiting for the owner reads a donor revocation after the mutex instead of an old snapshot', async () => {
        const user = owner(26); await manual(db, user, 2, true);
        const first = await api.register(user, { ...account(26), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        let releaseOwner, ownerLocked, ownerAttempted;
        const locked = new Promise(resolve => { ownerLocked = resolve; }), attempted = new Promise(resolve => { ownerAttempted = resolve; });
        const release = new Promise(resolve => { releaseOwner = resolve; });
        const holding = db.withDatabaseTransaction(async query => {
            await entitlements.lockOwner(query, user.userId); ownerLocked(); await release;
            await query('UPDATE users SET is_donor=0,additional_auto_extract_slots=0 WHERE user_id=?', [user.userId]);
        });
        await locked;
        const waiting = apiFor({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, args) => {
            if (sql.startsWith('INSERT INTO users') && args[0] === user.userId) ownerAttempted();
            return query(sql, args);
        })) });
        const moving = waiting.move(user, first.id, { expectedRevision: first.revision, poolKind: 'supporter' });
        await attempted; releaseOwner(); await holding;
        await assert.rejects(moving, { code: 'X_MONITOR_DESTINATION_INELIGIBLE' });
        const preserved = await current(api, user, first.id);
        assert.equal(preserved.poolKind, 'free'); assert.equal(preserved.revision, first.revision); assert.equal((await extra(db, user)).length, 4);
    });

    await t.test('an inherited owner default remains compatible and an explicit monitor mode wins without changing the owner', async () => {
        const user = owner(15); await paid(db, user);
        await db.queryDatabase("UPDATE users SET x_notification_processing_mode='realtime' WHERE user_id=?", [user.userId]);
        const inherited = await api.register(user, account(15)); assert.equal(inherited.processing.modeSource, 'owner'); assert.equal(inherited.processing.effectiveMode, 'realtime');
        const off = await api.update(user, inherited.id, { expectedRevision: inherited.revision, processingMode: 'batch' });
        assert.equal(off.processing.modeSource, 'monitor'); assert.equal(off.processing.effectiveMode, 'batch');
        assert.equal((await db.queryDatabase('SELECT x_notification_processing_mode FROM users WHERE user_id=?', [user.userId]))[0].x_notification_processing_mode, 'realtime');
    });

    await t.test('reconstruction reads the same physical reservation and corrupted partial boosts fail closed until explicit repair', async () => {
        const user = owner(16), row = await api.register(user, { ...account(16), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        const restarted = await current(apiFor(db), user, row.id); assert.deepEqual(restarted.processing, row.processing);
        assert.deepEqual(await afterRestart(db, user, row.id), row.processing);
        await db.queryDatabase("DELETE FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind='x' AND target_id=? ORDER BY slot_index LIMIT 1", [user.userId, row.id]);
        const broken = await inspectXMonitorProcessing(db.queryDatabase, await raw(db, row.id));
        assert.equal(broken.effectiveMode, 'batch'); assert.equal(broken.canEnableRealtime, true);
        assert((await api.integrity(ADMIN)).issues.some(issue => issue.code === 'INVALID_X_REALTIME_SLOT_COUNT' && issue.id === row.id));
        const repaired = await api.update(user, row.id, { expectedRevision: row.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal(repaired.processing.effectiveMode, 'realtime'); assert.equal((await extra(db, user)).length, 4);
    });

    await t.test('a failure after boost insertion rolls back monitor, physical allocations and audit atomically', async () => {
        const user = owner(17), broken = apiFor(faultAfter(db, /^INSERT INTO automation_notification_boost_slots/));
        const before = (await api.summary(user)).pools.free.used;
        await assert.rejects(broken.register(user, { ...account(17), processingMode: 'realtime', expectedRealtimeSlotCost: 5 }));
        assert.equal((await api.list(user)).items.length, 0); assert.equal((await extra(db, user)).length, 0); assert.equal((await usage(db, user)).usedSlots, 0);
        assert.equal((await api.summary(user)).pools.free.used, before);
    });

    await t.test('an audit failure during OFF rolls back boost release and the original monitor revision', async () => {
        const user = owner(18), row = await api.register(user, { ...account(18), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        const broken = apiFor(faultAfter(db, /^INSERT INTO automation_audit/));
        await assert.rejects(broken.update(user, row.id, { expectedRevision: row.revision, processingMode: 'batch' }));
        const preserved = await current(api, user, row.id); assert.equal(preserved.revision, row.revision); assert.equal(preserved.processing.effectiveMode, 'realtime'); assert.equal((await extra(db, user)).length, 4);
    });

    await t.test('HTTP dispatch accepts only the session owner, requires monitor CAS and never trusts nested mode or client capacity', async () => {
        const user = owner(19), row = await api.register(user, account(19));
        const services = { db, xQuota: api, service: { withOperation: (_actor, _group, work) => work() } };
        const request = body => ({ method: 'PATCH', path: ['x-monitors', row.id], body });
        await assert.rejects(dispatch(request({ expectedRevision: row.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 5 }), owner(20), services), { code: 'NOT_FOUND' });
        await assert.rejects(dispatch(request({ expectedRevision: row.revision - 1, processingMode: 'realtime', expectedRealtimeSlotCost: 5 }), user, services), { status: 409 });
        await assert.rejects(dispatch(request({ expectedRevision: row.revision, notificationSettings: { processingMode: 'realtime' } }), user, services), { code: 'X_MONITOR_INVALID_INPUT' });
        await assert.rejects(db.withDatabaseTransaction(query => cadence.reserve(query, user.userId, 'x', row.id, { slotCost: 2, expectedUpdatedAtMs: null })), { code: 'X_MONITOR_INVALID_INPUT' });
        assert.equal((await extra(db, user)).length, 0);
    });

    await t.test('administrator usage counts the four X boosts and explicit OFF updates the same existing allowance', async () => {
        const user = owner(25), row = await api.register(user, { ...account(25), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        const admin = createDonorAdmin(db, { env: {} });
        assert.equal((await admin.get(ADMIN, user.userId)).entitlement.usedSlots, 5);
        await api.update(user, row.id, { expectedRevision: row.revision, processingMode: 'batch' });
        assert.equal((await admin.get(ADMIN, user.userId)).entitlement.usedSlots, 1);
    });

    await t.test('queue admission rechecks realtime qualification under its lock and batch replay still deduplicates', async () => {
        const user = owner(23), planId = await paid(db, user), row = await api.register(user, { ...account(23), processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        const fixture = await receiveFixture(db, api, user, row), queue = createQueue(db, {}, { rolloutMode: 'public' });
        await db.queryDatabase('UPDATE automation_push_plan_policy SET realtime_enabled=0 WHERE plan_id=?', [planId]);
        const stale = await queue.routeX({ ...fixture.input, processingMode: 'realtime' });
        assert.equal(stale.state, 'pending'); assert.equal(stale.code, 'X_REALTIME_NOT_ELIGIBLE');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_runs WHERE owner_user_id=?', [user.userId]))[0].n), 0);
        const batch = await queue.routeX({ ...fixture.input, processingMode: 'batch' }); assert.equal(batch.state, 'routed');
        const again = await queue.routeX({ ...fixture.input, processingMode: 'batch' }); assert.equal(again.runId, batch.runId);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_runs WHERE owner_user_id=?', [user.userId]))[0].n), 1);
        await assert.rejects(queue.routeX({ ...fixture.input, processingMode: 'client-bypass' }), { code: 'X_NOTIFICATION_INBOX_INVALID' });
    });

    await t.test('five-slot realtime queues with no batch interval and retains the one-slot message rate limits', async () => {
        const user = owner(24);
        await db.queryDatabase("UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id='free'");
        try {
            const row = await api.register(user, { ...account(24), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
            const fixture = await receiveFixture(db, api, user, row), queue = createQueue(db, {}, { rolloutMode: 'public' });
            const routed = await queue.routeX({ ...fixture.input, processingMode: 'realtime' }); assert.equal(routed.state, 'routed');
            assert.equal((await queue.routeX({ ...fixture.input, processingMode: 'realtime' })).runId, routed.runId);
            const actual = await entitlements.resolveNotificationEntitlement(db, { ownerUserId: user.userId, targetKind: 'x', targetId: row.id });
            assert.deepEqual([actual.priority, actual.minuteLimit, actual.dayLimit], [0, 5, 24]);
        } finally { await db.queryDatabase("UPDATE automation_notification_plans SET confirmation_interval_minutes=5 WHERE plan_id='free'"); }
    });
});
