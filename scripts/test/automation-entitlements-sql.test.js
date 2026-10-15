'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const entitlements = require('../../src/automation/entitlements');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('real SQL: shared notification slots, concurrent admission, trusted plans and persistent slot identity', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port), U = '222222222222222222', V = '333333333333333333', ADMIN = { userId: '444444444444444444', isAdmin: true };
    const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/autoWatch/store'), require.resolve('../../src/providers/priceWatch/store')];
    const originals = paths.map(path => require.cache[path]);
    try {
        require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { ...db, ensureUserExistsInDatabase: async userId => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [userId]) } };
        require.cache[paths[1]] = { ...originals[1], exports: { ...originals[1].exports, ensureDatabaseSchema: async () => {} } };
        delete require.cache[paths[2]]; delete require.cache[paths[3]];
        const nativeAuto = require(paths[2]), nativePrice = require(paths[3]);
        // This fixture exercises capacity rather than the separate operation
        // policy; inject a server-created limiter through the trusted JS option.
        const operationRateLimiter = createRateLimiter(db, { policy: { operations: { monitor: { minute: 1000, hour: 10000 } } } });
        const auto = { ...nativeAuto, registerTarget: input => nativeAuto.registerTarget(input, { operationRateLimiter }) };
        const price = { ...nativePrice, registerTarget: input => nativePrice.registerTarget(input, { operationRateLimiter }) };
        const autoInput = (source, userId = U) => ({ userId, providerId: 'github', source, destinationType: 'dm', planId: 'forged-premium', isDonor: true, slotLimit: 999 });
        const priceInput = (appId, userId = U) => ({ userId, providerId: 'steam', productUrl: `https://store.steampowered.com/app/${appId}/`, destinationType: 'dm', mode: 'change', planId: 'forged-premium' });
        let first, replacement;
        await t.test('free baseline is 5 total registrations across native auto and price, including paused slots', async () => {
            first = await auto.registerTarget(autoInput('octocat'));
            await auto.registerTarget(autoInput('github')); await auto.registerTarget(autoInput('microsoft'));
            await price.registerTarget(priceInput(440)); await price.registerTarget(priceInput(570));
            const summary = await entitlements.getEntitlementSummary(db, U);
            assert.equal(summary.tier, 'free'); assert.equal(summary.slotLimit, 5); assert.equal(summary.minuteLimit, 5); assert.equal(summary.dayLimit, 24);
            assert.equal(summary.usedSlots, 5); assert.equal(summary.remainingSlots, 0); assert.equal(summary.slots.filter(slot => slot.targetKind === 'price').length, 2);
            await assert.rejects(auto.registerTarget(autoInput('nodejs')), { code: 'AUTOMATION_SLOT_LIMIT', status: 422 });
            await assert.rejects(price.registerTarget(priceInput(730)), { code: 'AUTOMATION_SLOT_LIMIT', status: 422 });
            assert.equal((await auto.registerTarget(autoInput('octocat'))).id, first.id);
            await db.queryDatabase('UPDATE auto_watch_targets SET enabled=0 WHERE id=?', [first.id]);
            await assert.rejects(price.registerTarget(priceInput(730)), { code: 'AUTOMATION_SLOT_LIMIT' });
            assert.equal((await auto.registerTarget(autoInput('octocat'))).id, first.id);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_sources'))[0].n), 3);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM price_watch_sources'))[0].n), 2);
        });
        await t.test('delete and recreate reuse the lowest empty persistent owner slot and cannot steal another owner target', async () => {
            const original = await entitlements.resolveNotificationEntitlement(db, { ownerUserId: U, targetKind: 'auto', targetId: first.id });
            await auto.deleteTarget(U, first.id); replacement = await price.registerTarget(priceInput(730));
            const current = await entitlements.resolveNotificationEntitlement(db, { ownerUserId: U, targetKind: 'price', targetId: replacement.id });
            assert.equal(current.slotId, original.slotId); assert.equal(current.slotIndex, original.slotIndex);
            await assert.rejects(entitlements.resolveNotificationEntitlement(db, { ownerUserId: V, targetKind: 'price', targetId: replacement.id }), { code: 'AUTOMATION_NOT_FOUND', status: 404 });
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_notification_slots WHERE owner_user_id=?', [U]))[0].n), 5);
        });
        await t.test('concurrent workers admit exactly 5 combined slots for one free owner', async () => {
            const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => i % 2 ? price.registerTarget(priceInput(1000 + i, V)) : auto.registerTarget(autoInput(`owner${i}`, V))));
            assert.equal(results.filter(item => item.status === 'fulfilled').length, 5);
            for (const item of results.filter(item => item.status === 'rejected')) assert.equal(item.reason.code, 'AUTOMATION_SLOT_LIMIT');
            const summary = await entitlements.getEntitlementSummary(db, V); assert.equal(summary.usedSlots, 5);
            assert.equal(new Set(summary.slots.map(slot => slot.slotId)).size, 5);
        });
        await t.test('supporter priority and explicit administrator slot override come only from verified user records', async () => {
            await db.queryDatabase('UPDATE users SET is_donor=1,additional_auto_extract_slots=2 WHERE user_id=?', [U]);
            const plan = await entitlements.inspectPlan(db.queryDatabase, U);
            assert.equal(plan.tier, 'supporter'); assert.equal(plan.priority, 1); assert.equal(plan.slotLimit, 7); assert.equal(plan.minuteLimit, 5); assert.equal(plan.dayLimit, 24);
            await price.registerTarget(priceInput(1234)); await auto.registerTarget(autoInput('nodejs'));
            await assert.rejects(price.registerTarget(priceInput(5678)), { code: 'AUTOMATION_SLOT_LIMIT' });
        });
        await t.test('paid policy configuration has no invented defaults, cannot be self-granted, and retains additive trusted legacy extras', async () => {
            assert.deepEqual((await entitlements.listPlanPolicies(db.queryDatabase, ADMIN)).map(plan => plan.planId), ['free', 'supporter']);
            const fixturePlan = { planId: 'testPlan', label: 'テスト用プラン', slotLimit: 8, minuteLimit: 9, dayLimit: 100, priority: 3 };
            await assert.rejects(entitlements.savePlanPolicy(db.queryDatabase, { userId: U, isAdmin: false }, fixturePlan), { status: 403 });
            await assert.rejects(entitlements.setUserPlan(db.queryDatabase, { userId: U, isAdmin: 'true' }, U, 'testPlan'), { status: 403 });
            await assert.rejects(entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { ...fixturePlan, dayLimit: 0 }), { code: 'AUTOMATION_PLAN_INVALID', status: 422 });
            await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, ADMIN, fixturePlan));
            await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, U, 'testPlan'));
            const plan = await entitlements.inspectPlan(db.queryDatabase, U);
            assert.equal(plan.tier, 'paid'); assert.equal(plan.slotLimit, 10); assert.equal(plan.minuteLimit, 9); assert.equal(plan.dayLimit, 100); assert.equal(plan.priority, 3);
            await price.registerTarget(priceInput(5678));
            await price.registerTarget(priceInput(6789)); await price.registerTarget(priceInput(6790));
            await assert.rejects(price.registerTarget(priceInput(6791)), { code: 'AUTOMATION_SLOT_LIMIT' });
        });
        await t.test('downgrades retain registrations and identities; extra slots can be viewed/deleted but cannot send or resume', async () => {
            const previous = await entitlements.getEntitlementSummary(db, U);
            await db.queryDatabase('UPDATE users SET is_donor=0,additional_auto_extract_slots=0 WHERE user_id=?', [U]);
            await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, U, null));
            const summary = await entitlements.getEntitlementSummary(db, U);
            assert.equal(summary.usedSlots, 10); assert.equal(summary.slots.filter(slot => slot.allowed).length, 5);
            assert.deepEqual(summary.slots.map(slot => slot.slotId), previous.slots.map(slot => slot.slotId));
            const extra = summary.slots.find(slot => !slot.allowed);
            await assert.rejects(entitlements.resolveNotificationEntitlement(db, { ownerUserId: U, targetKind: extra.targetKind, targetId: extra.targetId }), { code: 'AUTOMATION_SLOT_LIMIT' });
            const store = extra.targetKind === 'auto' ? auto : price; await store.deleteTarget(U, extra.targetId);
            assert.equal((await entitlements.getEntitlementSummary(db, U)).usedSlots, 9);
        });
        await t.test('expiration or disabled configured plan falls back to current trusted free/supporter allowance', async () => {
            await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, V, 'testPlan', { expiresAtMs: Date.now() + 60000 }));
            assert.equal((await entitlements.inspectPlan(db.queryDatabase, V)).tier, 'paid');
            assert.equal((await entitlements.inspectPlan(db.queryDatabase, V, Date.now() + 120000)).tier, 'free');
            await db.queryDatabase('UPDATE automation_notification_plans SET enabled=0 WHERE plan_id=?', ['testPlan']);
            assert.equal((await entitlements.inspectPlan(db.queryDatabase, V)).tier, 'free');
        });
        await t.test('legacy subscriptions adopt stable slots without deleting overflow or ignoring paused registrations', async () => {
            const legacyOwner = '555555555555555555';
            await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms) VALUES (?,0)', [legacyOwner]);
            const source = (await db.queryDatabase('SELECT id FROM auto_watch_sources ORDER BY id LIMIT 1'))[0];
            for (let index = 0; index < 6; index++) await db.queryDatabase(`INSERT INTO auto_watch_targets
                (user_id,source_id,destination_type,destination_key,premium_slot,enabled,created_at_ms) VALUES (?,?,'dm',?,0,?,?)`,
            [legacyOwner, source.id, `dm:${legacyOwner}:${index}`, index < 2 ? 0 : 1, index]);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_notification_slots WHERE owner_user_id=?', [legacyOwner]))[0].n), 0);
            const summary = await entitlements.getEntitlementSummary(db, legacyOwner);
            assert.equal(summary.usedSlots, 6); assert.equal(summary.slots.filter(slot => slot.allowed).length, 5);
            const repeated = await entitlements.getEntitlementSummary(db, legacyOwner);
            assert.deepEqual(repeated.slots.map(slot => slot.slotId), summary.slots.map(slot => slot.slotId));
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_targets WHERE user_id=?', [legacyOwner]))[0].n), 6);
            const overflow = summary.slots.find(slot => !slot.allowed);
            await assert.rejects(entitlements.resolveNotificationEntitlement(db, { ownerUserId: legacyOwner, targetKind: 'auto', targetId: overflow.targetId }), { code: 'AUTOMATION_SLOT_LIMIT' });
        });
    } finally {
        paths.forEach((path, index) => { if (originals[index]) require.cache[path] = originals[index]; else delete require.cache[path]; });
        await db.close();
    }
});

test('real SQL: X and ordinary notifications share one current plan, while interval overrides remain explicit', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    const ADMIN = { userId: '444444444444444444', isAdmin: true }, now = Date.now();
    const owners = { free: '777777777777777771', supporter: '777777777777777772', paid: '777777777777777773' };
    const policies = [
        { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 3, dayLimit: 27, priority: 2, intervalMinutes: 60 },
        { planId: 'supporter', label: '支援者', slotLimit: 20, minuteLimit: 7, dayLimit: 48, priority: 9, intervalMinutes: 15 },
        { planId: 'same-plan-paid', label: '設定済み有料', slotLimit: 12, minuteLimit: 13, dayLimit: 123, priority: 17, intervalMinutes: 5 },
    ];
    await db.withDatabaseTransaction(async query => {
        for (const policy of policies) await entitlements.savePlanPolicy(query, ADMIN, policy);
        for (const [tier, userId] of Object.entries(owners)) await query('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots,auto_watch_interval_minutes) VALUES (?,0,?,2,7)', [userId, tier === 'free' ? 0 : 1]);
        await entitlements.setUserPlan(query, ADMIN, owners.paid, 'same-plan-paid');
    });
    for (const [tier, userId] of Object.entries(owners)) await t.test(`${tier}: X inherits plan identity, limits, priority and only that plan's interval`, async () => {
        const ordinary = await entitlements.inspectPlan(db.queryDatabase, userId, now);
        const x = await entitlements.inspectXPlan(db.queryDatabase, userId, now);
        const { intervalMinutes, ...same } = x;
        assert.deepEqual(same, ordinary);
        assert.equal(x.tier, tier);
        assert.equal(intervalMinutes, policies.find(policy => policy.planId === ordinary.planId).intervalMinutes);
        assert.equal(x.slotLimit, x.baseSlotLimit + 2, 'permanent additions count once for both services');
        assert.equal((await entitlements.inspectXPlan(db.queryDatabase, userId, now, { useLegacyUserInterval: true })).intervalMinutes, 7);
        assert.equal((await entitlements.inspectXPlan(db.queryDatabase, userId, now)).intervalMinutes, intervalMinutes, 'ordinary reads never enable the testing override');
    });
    await t.test('pool allocation never changes current plan limits or priority', async () => {
        const userId = owners.paid, plan = await entitlements.inspectPlan(db.queryDatabase, userId, now);
        const result = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,name,pool_kind,notification_settings_json,created_at_ms,updated_at_ms) VALUES (?,'12345','Same-plan fixture','free','{}',?,?)", [userId, now, now]);
        const targetId = String(result.insertId);
        for (const pool of ['free', 'supporter', 'special']) {
            await db.queryDatabase('UPDATE automation_x_monitors SET pool_kind=? WHERE id=?', [pool, targetId]);
            const quality = await entitlements.resolveNotificationEntitlement(db, { ownerUserId: userId, targetKind: 'x', targetId });
            for (const key of ['tier', 'planId', 'label', 'slotLimit', 'baseSlotLimit', 'minuteLimit', 'dayLimit', 'priority']) assert.equal(quality[key], plan[key], `${pool}:${key}`);
            assert.equal(quality.intervalMinutes, 5);
        }
    });
    await t.test('missing or invalid supporter intervals stay unconfigured without borrowing the free interval', async () => {
        for (const interval of [null, 1, 10081]) {
            await db.queryDatabase("UPDATE automation_notification_plans SET confirmation_interval_minutes=? WHERE plan_id='supporter'", [interval]);
            const ordinary = await entitlements.inspectPlan(db.queryDatabase, owners.supporter, now);
            const x = await entitlements.inspectXPlan(db.queryDatabase, owners.supporter, now);
            assert.equal(x.planId, ordinary.planId); assert.equal(x.planId, 'supporter'); assert.equal(x.intervalMinutes, null);
            assert.equal(x.minuteLimit, 7); assert.equal(x.dayLimit, 48); assert.equal(x.priority, 9);
            const settings = await require('../../src/automation/x-processing-settings').inspectXProcessingSettings(db.queryDatabase, owners.supporter, now);
            assert.equal(settings.configured, false); assert.equal(settings.reasonCode, 'X_MONITOR_NOT_CONFIGURED'); assert.equal(settings.planId, 'supporter');
        }
        assert.equal((await entitlements.inspectXPlan(db.queryDatabase, owners.free, now)).intervalMinutes, 60);
    });
    await t.test('paid downgrade resolves identically for native and X notifications', async () => {
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, owners.paid, null));
        let ordinary = await entitlements.inspectPlan(db.queryDatabase, owners.paid, now);
        let x = await entitlements.inspectXPlan(db.queryDatabase, owners.paid, now);
        assert.equal(ordinary.planId, 'supporter'); assert.deepEqual(x, { ...ordinary, intervalMinutes: null });
        await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [owners.paid]);
        ordinary = await entitlements.inspectPlan(db.queryDatabase, owners.paid, now);
        x = await entitlements.inspectXPlan(db.queryDatabase, owners.paid, now);
        assert.equal(ordinary.planId, 'free'); assert.deepEqual(x, { ...ordinary, intervalMinutes: 60 });
    });
});
