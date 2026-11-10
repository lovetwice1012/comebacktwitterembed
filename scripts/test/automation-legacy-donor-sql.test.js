'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const entitlements = require('../../src/automation/entitlements');
const { snapshotLegacyBenefits, activateLegacyCutover, isLegacyDonor } = require('../../src/automation/legacy-donor-benefits');
const { applyApprovedPlanPolicies } = require('../../src/automation/plan-redesign');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('This test requires disposable AUTOMATION_TEST_DB_PORT=33621');

test('legacy donor cutover preserves old holdings, floors, paid plans, and rollback', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port);
    const admin = { userId: '900', isAdmin: true };
    try {
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,2),(?,0,1,1),(?,0,0,1)', ['100', '200', '300']);
        await db.queryDatabase('UPDATE users SET auto_watch_interval_minutes=5 WHERE user_id=?', ['100']);
        await db.withDatabaseTransaction(async query => {
            await entitlements.savePlanPolicy(query, admin, { planId: 'free', label: '無料', slotLimit: 3, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 180 });
            await entitlements.savePlanPolicy(query, admin, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 7, dayLimit: 36, priority: 1, intervalMinutes: 30 });
            await entitlements.savePlanPolicy(query, admin, { planId: 'basic', label: 'Basic', slotLimit: 10, minuteLimit: 20, dayLimit: 72, priority: 4, intervalMinutes: 10 });
            await entitlements.setUserPlan(query, admin, '200', 'basic');
        });
        await assert.rejects(db.withDatabaseTransaction(async query => {
            await snapshotLegacyBenefits(query, { ownerIds: ['100'], actor: admin, now: 10 });
            await activateLegacyCutover(query, { ownerIds: ['100'], actor: admin, now: 10 });
        }), { code: 'LEGACY_DONOR_COHORT_MISMATCH' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_legacy_donor_benefits'))[0].n), 0);
        await db.withDatabaseTransaction(async query => {
            await snapshotLegacyBenefits(query, { ownerIds: ['100', '200'], actor: admin, now: 20 });
            await activateLegacyCutover(query, { ownerIds: ['100', '200'], actor: admin, now: 20 });
        });
        const old = await entitlements.inspectXPlan(db.queryDatabase, '100');
        assert.equal(old.planId, 'free'); assert.equal(old.baseSlotLimit, 5); assert.equal(old.slotLimit, 7);
        assert.equal(old.minuteLimit, 7); assert.equal(old.dayLimit, 36); assert.equal(old.priority, 1); assert.equal(old.intervalMinutes, 5);
        const paid = await entitlements.inspectXPlan(db.queryDatabase, '200');
        assert.equal(paid.planId, 'basic'); assert.equal(paid.slotLimit, 11); assert.equal(paid.intervalMinutes, 10);
        const newer = await entitlements.inspectXPlan(db.queryDatabase, '300');
        assert.equal(newer.planId, 'free'); assert.equal(newer.slotLimit, 4); assert.equal(newer.intervalMinutes, 180);
        await db.queryDatabase('UPDATE users SET is_donor=1 WHERE user_id=?', ['300']);
        assert.equal(await isLegacyDonor(db.queryDatabase, '300'), false);
        assert.equal(await isLegacyDonor(db.queryDatabase, '100'), true);
        const insertedOld = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'1000','old','old',1,'ready','supporter',?,'pending',1,1,1)", ['100', JSON.stringify({ processingMode: 'realtime' })]);
        const insertedNew = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,'2000','new','new',1,'ready','supporter',?,'pending',1,1,1)", ['300', JSON.stringify({ processingMode: 'realtime' })]);
        for (const [owner, id] of [['100', insertedOld.insertId], ['300', insertedNew.insertId]])
            await db.withDatabaseTransaction(query => entitlements.assignSlot(query, owner, 'x', String(id)));
        const processing = require('../../src/automation/x-processing-settings');
        const oldMonitor = (await db.queryDatabase('SELECT * FROM automation_x_monitors WHERE id=?', [insertedOld.insertId]))[0];
        const newMonitor = (await db.queryDatabase('SELECT * FROM automation_x_monitors WHERE id=?', [insertedNew.insertId]))[0];
        const oldMode = await processing.inspectXMonitorProcessing(db.queryDatabase, oldMonitor);
        const newMode = await processing.inspectXMonitorProcessing(db.queryDatabase, newMonitor);
        assert.equal(oldMode.realtimeSlotCost, 1); assert.equal(oldMode.effectiveMode, 'realtime'); assert.equal(oldMode.realtimeSource, 'supporter');
        assert.equal(newMode.realtimeSlotCost, 5); assert.equal(newMode.effectiveMode, 'batch');
        const cadence = require('../../src/automation/monitor-cadence');
        assert.equal((await cadence.runtimeCadence(db.queryDatabase, '100', 'auto', '1', 5 * 60000)).intervalMs, 5 * 60000);
        assert.equal((await cadence.runtimeCadence(db.queryDatabase, '200', 'auto', '1', 120 * 60000)).intervalMs, 10 * 60000);
        assert.equal((await cadence.runtimeCadence(db.queryDatabase, '300', 'auto', '1', 5 * 60000)).intervalMs, 180 * 60000);
        await assert.rejects(db.withDatabaseTransaction(query => snapshotLegacyBenefits(query, { ownerIds: ['300'], actor: admin, now: 30 })), { code: 'LEGACY_DONOR_CUTOVER_COMPLETE' });
    } finally { await db.close(); }
});

test('approved plan switch is transactional and keeps the frozen donor floor', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), admin = { userId: '900', isAdmin: true };
    try {
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,2)', ['100']);
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,0)', ['200']);
        const source = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,next_check_at_ms,last_checked_at_ms,created_at_ms) VALUES ('github','fixture','https://github.com/fixture',300000,300000,1000,1)");
        const target = await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_key,destination_type,created_at_ms,last_polled_at_ms,next_poll_at_ms,last_notification_window_at_ms,baseline_at_ms) VALUES (?,?,'dm','dm',1,1000,301000,1000,1)", ['200', source.insertId]);
        const item = await db.queryDatabase("INSERT INTO auto_watch_items (source_id,content_key,content_url,discovered_at_ms) VALUES (?,'one','https://example.com/one',2000)", [source.insertId]);
        await db.queryDatabase("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,cadence_due_at_ms) VALUES (?,?,'pending',301000,301000)", [item.insertId, target.insertId]);
        const priceSource = await db.queryDatabase("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,state_json,initialized_at_ms,poll_interval_ms,next_check_at_ms,last_checked_at_ms,created_at_ms) VALUES ('steam','app:730','https://store.steampowered.com/app/730','ja','{\"priceAmount\":2000,\"currency\":\"JPY\"}',1,3600000,3601000,1000,1)");
        await db.queryDatabase("INSERT INTO price_watch_targets (source_id,user_id,destination_type,destination_key,watch_mode,rule_key,baseline_at_ms,created_at_ms) VALUES (?,?,'dm','dm:200','change','all',1,1)", [priceSource.insertId, '200']);
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 7, dayLimit: 36, priority: 1, intervalMinutes: 30 }));
        await db.queryDatabase("INSERT INTO automation_square_checkouts (id,owner_user_id,environment,merchant_id,plan_id,variation_id,catalog_version,amount,currency,cadence,plan_json,email,name,state,expires_at_ms,created_at_ms,updated_at_ms) VALUES ('11111111-1111-4111-8111-111111111111','100','sandbox','merchant','old','v','1',100,'JPY','MONTHLY','{}','x@example.test','x','QUOTED',100,1,1)");
        await assert.rejects(db.withDatabaseTransaction(query => applyApprovedPlanPolicies(query, { actor: admin, ownerIds: ['100'], now: 10 })), { code: 'PLAN_REDESIGN_SUBSCRIPTIONS_EXIST' });
        await db.queryDatabase('UPDATE automation_square_checkouts SET expires_at_ms=1');
        await assert.rejects(db.withDatabaseTransaction(async query => {
            await applyApprovedPlanPolicies(query, { actor: admin, ownerIds: ['100'], now: 10 });
            throw new Error('ROLLBACK_TEST');
        }), /ROLLBACK_TEST/);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_legacy_donor_cutover'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_price_watch_cadence'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT next_poll_at_ms FROM auto_watch_targets WHERE id=?', [target.insertId]))[0].next_poll_at_ms), 301000);
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_notification_plans WHERE plan_id='subscription_basic'"))[0].n), 0);
        const result = await db.withDatabaseTransaction(query => applyApprovedPlanPolicies(query, { actor: admin, ownerIds: ['100'], now: 20 }));
        assert.deepEqual(result, { planCount: 5, donorCount: 1, squareBindingsEnabled: false });
        assert.equal((await db.queryDatabase('SELECT state FROM automation_square_checkouts'))[0].state, 'QUOTED');
        const plans = await db.queryDatabase('SELECT plan_id,slot_limit,confirmation_interval_minutes FROM automation_notification_plans ORDER BY plan_id');
        assert.equal(plans.find(row => row.plan_id === 'subscription_community').slot_limit, 50);
        assert.equal(Number((await db.queryDatabase('SELECT next_poll_at_ms FROM auto_watch_targets WHERE id=?', [target.insertId]))[0].next_poll_at_ms), 1000 + 180 * 60000);
        const pending = (await db.queryDatabase('SELECT next_attempt_at_ms,cadence_due_at_ms FROM auto_watch_deliveries WHERE target_id=?', [target.insertId]))[0];
        assert.equal(Number(pending.next_attempt_at_ms), 1000 + 180 * 60000);
        assert.equal(Number(pending.cadence_due_at_ms), 1000 + 180 * 60000);
        const donor = await entitlements.inspectXPlan(db.queryDatabase, '100');
        assert.equal(donor.planId, 'free'); assert.equal(donor.slotLimit, 7); assert.equal(donor.intervalMinutes, 30);
        const policies = await db.queryDatabase('SELECT plan_id,special_slot_limit,realtime_enabled FROM automation_push_plan_policy ORDER BY plan_id');
        assert.equal(policies.find(row => row.plan_id === 'subscription_basic').special_slot_limit, 10);
        assert.equal(policies.find(row => row.plan_id === 'subscription_ultra').realtime_enabled, 1);
        assert.equal(policies.find(row => row.plan_id === 'subscription_lite').realtime_enabled, 0);
    } finally { await db.close(); }
});

test('native scheduling resolves a verified Square plan and administrator override like X', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), admin = { userId: '900', isAdmin: true };
    const square = require('../../src/automation/square-billing'), originalScope = square.getSquareScope;
    try {
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1),(?,0,0)', ['100', '200']);
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 7, dayLimit: 36, priority: 1, intervalMinutes: 30 }));
        await db.withDatabaseTransaction(query => applyApprovedPlanPolicies(query, { actor: admin, ownerIds: ['100'], now: 20 }));
        await db.queryDatabase("INSERT INTO automation_square_subscriptions (owner_user_id,environment,merchant_id,plan_id,variation_id,customer_id,subscription_id,checkout_id,state,valid_until_at_ms,verified,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,'ACTIVE',?,1,?)", ['200', 'sandbox', 'merchant', 'subscription_basic', 'v', 'c', 's', '11111111-1111-4111-8111-111111111111', Date.now() + 3600000, Date.now()]);
        square.getSquareScope = () => ({ configured: true, environment: 'sandbox', merchantId: 'merchant' });
        const { currentPlanInterval } = require('../../src/automation/plan-interval');
        assert.equal(await currentPlanInterval(db.queryDatabase, '200'), 10);
        assert.equal((await entitlements.inspectXPlan(db.queryDatabase, '200')).intervalMinutes, 10);
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, admin, '200', 'subscription_lite'));
        assert.equal(await currentPlanInterval(db.queryDatabase, '200'), 60);
        assert.equal((await entitlements.inspectXPlan(db.queryDatabase, '200')).intervalMinutes, 60);
    } finally { square.getSquareScope = originalScope; await db.close(); }
});
