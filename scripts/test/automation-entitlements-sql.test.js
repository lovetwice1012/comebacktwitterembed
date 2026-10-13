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
