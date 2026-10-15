'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXProcessingSettings } = require('../../src/automation/x-processing-settings');
const capacity = require('../../src/automation/push-capacity');
const entitlements = require('../../src/automation/entitlements');
const { dispatch } = require('../../src/automation/api');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const U = { userId: '222222222222222222' }, V = { userId: '333333333333333333' };
const ADMIN = { userId: '666666666666666666', isAdmin: true };

test('real SQL owner processing preferences, explicit plan permission, atomic changes and safe migration', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port), query = db.queryDatabase;
    t.after(() => db.close());
    const settings = createXProcessingSettings(db, { rolloutMode: 'supporters' });
    const services = { db, xProcessingSettings: settings, service: { withOperation: (_actor, _group, work) => work() } };
    const request = (method, body = {}) => ({ method, path: ['x-processing-settings'], body });
    for (const owner of [U, V]) await query('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,2)', [owner.userId]);
    await db.withDatabaseTransaction(async q => {
        await entitlements.savePlanPolicy(q, ADMIN, { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 30 });
        await entitlements.savePlanPolicy(q, ADMIN, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 7, dayLimit: 48, priority: 1, intervalMinutes: 45 });
        await entitlements.savePlanPolicy(q, ADMIN, { planId: 'ConfiguredPlan', label: '名前に依存しないプラン', slotLimit: 9, minuteLimit: 3, dayLimit: 12, priority: 17, intervalMinutes: 15 });
        await entitlements.savePlanPolicy(q, ADMIN, { planId: 'BasicPlus', label: 'Basic+', slotLimit: 9, minuteLimit: 3, dayLimit: 12, priority: 17, intervalMinutes: 15 });
        await entitlements.setUserPlan(q, ADMIN, U.userId, 'ConfiguredPlan');
        await entitlements.setUserPlan(q, ADMIN, V.userId, 'BasicPlus');
    });
    async function flag(planId, realtimeEnabled) {
        return db.withDatabaseTransaction(async q => {
            const previous = await capacity.getPlanCapacity(q, ADMIN, planId);
            return capacity.savePlanCapacity(q, ADMIN, planId, { eligible: false, specialSlotLimit: 0, realtimeEnabled, expectedUpdatedAtMs: previous.updatedAtMs });
        });
    }
    await t.test('GET defaults to batch and a plan name cannot grant realtime', async () => {
        const status = await dispatch(request('GET'), U, services);
        assert.equal(status.requestedMode, 'batch'); assert.equal(status.effectiveMode, 'batch'); assert.equal(status.intervalMinutes, 15);
        assert.equal(status.realtimeAllowed, false); assert.equal(status.rollout.eligible, true);
        await assert.rejects(dispatch(request('PUT', { mode: 'realtime', expectedMode: 'batch' }), V, services), { code: 'X_REALTIME_PLAN_REQUIRED', status: 403 });
    });
    await t.test('admin explicit permission is independent of special slots and optional old-client edits preserve it', async () => {
        const policy = await flag('ConfiguredPlan', true);
        assert.equal(policy.eligible, false); assert.equal(policy.specialSlotLimit, 0); assert.equal(policy.realtimeEnabled, true);
        const preserved = await db.withDatabaseTransaction(q => capacity.savePlanCapacity(q, ADMIN, 'ConfiguredPlan', { eligible: false, specialSlotLimit: 0, expectedUpdatedAtMs: policy.updatedAtMs }));
        assert.equal(preserved.realtimeEnabled, true);
        await assert.rejects(db.withDatabaseTransaction(q => capacity.savePlanCapacity(q, U, 'ConfiguredPlan', { eligible: false, specialSlotLimit: 0, realtimeEnabled: true, expectedUpdatedAtMs: preserved.updatedAtMs })), { status: 403 });
    });
    await t.test('two concurrent mode changes have one CAS winner with one audit and no slot debit', async () => {
        const before = await entitlements.inspectXPlan(query, U.userId);
        const result = await Promise.allSettled([0, 1].map(() => dispatch(request('PUT', { mode: 'realtime', expectedMode: 'batch' }), U, services)));
        assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
        assert.equal(result.find(row => row.status === 'rejected').reason.code, 'X_PROCESSING_CONFLICT');
        const status = await settings.get(U); assert.equal(status.effectiveMode, 'realtime'); assert.equal(status.realtimeAllowed, true);
        assert.deepEqual(await entitlements.inspectXPlan(query, U.userId), before);
        assert.equal(Number((await query('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
        assert.equal(Number((await query("SELECT COUNT(*) n FROM automation_audit WHERE action='x.processing.mode'"))[0].n), 1);
        assert.equal((await settings.get(V)).requestedMode, 'batch');
    });
    await t.test('explicit realtime works with a NULL batch interval and preference survives service reconstruction', async () => {
        await query("UPDATE automation_notification_plans SET confirmation_interval_minutes=NULL WHERE plan_id='ConfiguredPlan'");
        const restarted = createXProcessingSettings(db, { rolloutMode: 'supporters' });
        const status = await restarted.get(U);
        assert.equal(status.requestedMode, 'realtime'); assert.equal(status.effectiveMode, 'realtime'); assert.equal(status.intervalMinutes, null); assert.equal(status.configured, true);
    });
    await t.test('revoking a plan flag keeps preference and falls back without altering any registration', async () => {
        await query("UPDATE automation_notification_plans SET confirmation_interval_minutes=15 WHERE plan_id='ConfiguredPlan'");
        await flag('ConfiguredPlan', false);
        const status = await settings.get(U);
        assert.equal(status.requestedMode, 'realtime'); assert.equal(status.effectiveMode, 'batch'); assert.equal(status.reasonCode, 'X_REALTIME_PLAN_REQUIRED');
        assert.equal(status.intervalMinutes, 15);
        await settings.save(U, { mode: 'batch', expectedMode: 'realtime' });
        assert.equal((await settings.get(U)).requestedMode, 'batch');
    });
    await t.test('downgrade and expiry remove current eligibility while retaining the requested choice', async () => {
        await flag('ConfiguredPlan', true); await settings.save(U, { mode: 'realtime', expectedMode: 'batch' });
        await db.withDatabaseTransaction(q => entitlements.setUserPlan(q, ADMIN, U.userId, null));
        let status = await settings.get(U); assert.equal(status.effectiveMode, 'batch'); assert.equal(status.requestedMode, 'realtime'); assert.equal(status.planId, 'supporter'); assert.equal(status.intervalMinutes, 45);
        await db.withDatabaseTransaction(q => entitlements.setUserPlan(q, ADMIN, U.userId, 'ConfiguredPlan', { expiresAtMs: Date.now() + 60000 }));
        await query('UPDATE automation_notification_entitlements SET expires_at_ms=? WHERE owner_user_id=?', [Date.now() - 1, U.userId]);
        status = await settings.get(U); assert.equal(status.realtimeAllowed, false); assert.equal(status.requestedMode, 'realtime');
        await db.withDatabaseTransaction(q => entitlements.setUserPlan(q, ADMIN, U.userId, 'ConfiguredPlan'));
        assert.equal((await settings.get(U)).effectiveMode, 'realtime');
    });
    await t.test('owner can return to batch after donor access is revoked and closed rollout cannot enable realtime', async () => {
        await query('UPDATE users SET is_donor=0 WHERE user_id=?', [U.userId]);
        const status = await settings.save(U, { mode: 'batch', expectedMode: 'realtime' });
        assert.equal(status.requestedMode, 'batch'); assert.equal(status.rollout.eligible, false);
        await assert.rejects(settings.save(U, { mode: 'realtime', expectedMode: 'batch' }), { code: 'X_ROLLOUT_SUPPORTERS_ONLY', status: 403 });
        await query('UPDATE users SET is_donor=1 WHERE user_id=?', [U.userId]);
    });
    await t.test('audit failure rolls back the preference and idempotent saves add no audit', async () => {
        const broken = createXProcessingSettings({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(q => work(async (sql, params) => {
            if (sql.startsWith('INSERT INTO automation_audit')) await q("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='safe audit fixture'");
            return q(sql, params);
        })) }, { rolloutMode: 'supporters' });
        await assert.rejects(broken.save(U, { mode: 'realtime', expectedMode: 'batch' }));
        assert.equal((await settings.get(U)).requestedMode, 'batch');
        const before = (await query('SELECT COUNT(*) n FROM automation_audit'))[0].n;
        await settings.save(U, { mode: 'batch', expectedMode: 'batch' });
        assert.equal((await query('SELECT COUNT(*) n FROM automation_audit'))[0].n, before);
    });
    await t.test('migration preserves old counters and adds safe defaults without granting any plan', async () => {
        const source = path.join(__dirname, '../../migrations/20261014_add_x_realtime_processing.sql');
        const schema = require('../../src/db_schema');
        await query('ALTER TABLE users DROP COLUMN x_notification_processing_mode');
        await query('ALTER TABLE automation_push_plan_policy DROP COLUMN realtime_enabled');
        await query('ALTER TABLE automation_x_push_receivers DROP COLUMN process_window_mode');
        const statements = schema._internal.splitSqlStatements(fs.readFileSync(source, 'utf8'));
        for (let pass = 0; pass < 2; pass++) for (const sql of statements)
            if (!await schema._internal.shouldSkipMigrationStatement(query, sql)) await query(sql);
        const owners = await query('SELECT x_notification_processing_mode,additional_auto_extract_slots,is_donor FROM users ORDER BY user_id');
        assert(owners.every(row => row.x_notification_processing_mode === 'batch' && Number(row.additional_auto_extract_slots) === 2 && Number(row.is_donor) === 1));
        const plans = await query('SELECT realtime_enabled FROM automation_push_plan_policy');
        assert(plans.every(row => Number(row.realtime_enabled) === 0));
        assert.equal(statements.length, 3);
    });
});
