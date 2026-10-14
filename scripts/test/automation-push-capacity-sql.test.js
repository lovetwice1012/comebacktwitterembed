'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { dispatch } = require('../../src/automation/api');
const capacity = require('../../src/automation/push-capacity');
const plans = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const ADMIN = { userId: '444444444444444444', isAdmin: true };
const OWNER = { userId: '222222222222222222' };
const request = (method, path, body = {}) => ({ method, path: path.split('/'), body });
const poolInput = (changes = {}) => ({ freePoolLimit: 50, supporterPoolLimit: 100, expectedUpdatedAtMs: 0, ...changes });
const planInput = (changes = {}) => ({ eligible: false, specialSlotLimit: 0, expectedUpdatedAtMs: 0, ...changes });
const ordinaryPlan = (planId, changes = {}) => ({ planId, label: planId, slotLimit: 12, minuteLimit: 20, dayLimit: 200, priority: 7, ...changes });

test('SQL: dormant Push capacity admin settings are independent, authorized and atomically revisioned', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    const services = { db, service: createService(db, { rateOptions: { policy: { operations: { write: { minute: 1000, hour: 1000 } } } } }) };
    let pool, basic, plus;
    await t.test('configuration schema is additive and does not seed or modify ordinary plan rows', async () => {
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_plans'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_pool_policy'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_plan_policy'))[0].n), 0);
        const defaultPolicy = await dispatch(request('GET', 'push-capacity'), ADMIN, services);
        assert.deepEqual(defaultPolicy, { featureEnabled: false, freePoolLimit: 50, supporterPoolLimit: 100, updatedAtMs: 0 });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_pool_policy'))[0].n), 0);
    });
    await t.test('all methods require authenticated actual admins before operation counters or queries', async () => {
        const noIo = { db: { queryDatabase: () => { throw new Error('unauthorized query'); }, withDatabaseTransaction: () => { throw new Error('unauthorized transaction'); } }, service: { withOperation: () => { throw new Error('unauthorized rate operation'); } } };
        for (const [method, path, body] of [
            ['GET', 'push-capacity', {}], ['PATCH', 'push-capacity', poolInput({ isAdmin: true })],
            ['GET', 'push-capacity/plans/BasicExisting', {}], ['PATCH', 'push-capacity/plans/BasicExisting', planInput({ isAdmin: true })],
        ]) {
            await assert.rejects(dispatch(request(method, path, body), undefined, noIo), { code: 'AUTH_REQUIRED', status: 401 });
            await assert.rejects(dispatch(request(method, path, body), OWNER, noIo), { code: 'AUTOMATION_FORBIDDEN', status: 403 });
        }
        await assert.rejects(capacity.getPoolPolicy(db.queryDatabase, { ...OWNER, isAdmin: 'true' }), { code: 'AUTOMATION_FORBIDDEN', status: 403 });
    });
    await t.test('global bounds, mandatory revisions and unknown privilege fields fail without a policy write', async () => {
        for (const changes of [
            { freePoolLimit: -1 }, { freePoolLimit: 100001 }, { freePoolLimit: 1.5 }, { freePoolLimit: '50' },
            { supporterPoolLimit: -1 }, { supporterPoolLimit: NaN }, { supporterPoolLimit: Infinity },
            { expectedUpdatedAtMs: undefined }, { expectedUpdatedAtMs: -1 }, { expectedUpdatedAtMs: '0' },
            { featureEnabled: true }, { tier: 'paid' }, { ownerUserId: OWNER.userId },
        ]) await assert.rejects(dispatch(request('PATCH', 'push-capacity', poolInput(changes)), ADMIN, services), { code: 'AUTOMATION_PUSH_CAPACITY_INVALID', status: 422 });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_pool_policy'))[0].n), 0);
    });
    await t.test('global limits may independently include zero and remain feature-disabled', async () => {
        const firstSaves = await Promise.allSettled([0, 1].map(() => dispatch(request('PATCH', 'push-capacity', poolInput({ freePoolLimit: 0, supporterPoolLimit: 100000 })), ADMIN, services)));
        assert.equal(firstSaves.filter(outcome => outcome.status === 'fulfilled').length, 1);
        assert.equal(firstSaves.find(outcome => outcome.status === 'rejected').reason.code, 'AUTOMATION_PUSH_CAPACITY_CONFLICT');
        pool = firstSaves.find(outcome => outcome.status === 'fulfilled').value;
        assert.equal(pool.freePoolLimit, 0); assert.equal(pool.supporterPoolLimit, 100000);
        assert.equal(pool.featureEnabled, false); assert.ok(pool.updatedAtMs > 0);
        pool = await dispatch(request('PATCH', 'push-capacity', poolInput({ freePoolLimit: 50, supporterPoolLimit: 100, expectedUpdatedAtMs: pool.updatedAtMs })), ADMIN, services);
        assert.deepEqual(await dispatch(request('GET', 'push-capacity'), ADMIN, services), pool);
    });
    await t.test('stale global edits and simultaneous CAS retain precisely one winning write', async () => {
        await assert.rejects(dispatch(request('PATCH', 'push-capacity', poolInput()), ADMIN, services), { code: 'AUTOMATION_PUSH_CAPACITY_CONFLICT', status: 409 });
        const prior = pool;
        const outcomes = await Promise.allSettled([60, 70].map(freePoolLimit => dispatch(request('PATCH', 'push-capacity', poolInput({ freePoolLimit, expectedUpdatedAtMs: prior.updatedAtMs })), ADMIN, services)));
        assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'AUTOMATION_PUSH_CAPACITY_CONFLICT');
        pool = outcomes.find(outcome => outcome.status === 'fulfilled').value;
        assert.ok(pool.updatedAtMs > prior.updatedAtMs);
        assert.deepEqual(await capacity.getPoolPolicy(db.queryDatabase, ADMIN), pool);
        assert.equal(pool.supporterPoolLimit, 100);
    });
    await t.test('existing paid plans are referenced without overwriting Basic or changing built-in plans', async () => {
        basic = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, ordinaryPlan('BasicExisting')));
        plus = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, ordinaryPlan('PlusExisting', { slotLimit: 24 })));
        const before = await db.queryDatabase('SELECT * FROM automation_notification_plans ORDER BY plan_id');
        const value = await dispatch(request('GET', 'push-capacity/plans/basicexisting'), ADMIN, services);
        assert.deepEqual(value, { planId: basic.planId, label: basic.label, planEnabled: true, isPaid: true, eligible: false, specialSlotLimit: 0, realtimeEnabled: false, consumesUserSlots: true, featureEnabled: false, updatedAtMs: 0 });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_plan_policy'))[0].n), 0);
        for (const planId of ['free', 'FREE', 'supporter', 'Supporter', 'invalid;DROP']) await assert.rejects(dispatch(request('GET', `push-capacity/plans/${planId}`), ADMIN, services), { code: 'AUTOMATION_PUSH_CAPACITY_INVALID', status: 422 });
        await assert.rejects(dispatch(request('PATCH', 'push-capacity/plans/UnknownPaid', planInput({ eligible: true, specialSlotLimit: 5 })), ADMIN, services), { code: 'AUTOMATION_PUSH_CAPACITY_NOT_FOUND', status: 404 });
        assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_notification_plans ORDER BY plan_id'), before);
    });
    await t.test('paid configuration rejects invalid bounds, missing CAS and tier/feature override inputs', async () => {
        for (const changes of [
            { eligible: 'true' }, { eligible: 1 }, { realtimeEnabled: 'true' }, { realtimeEnabled: 1 }, { specialSlotLimit: -1 }, { specialSlotLimit: 100001 },
            { specialSlotLimit: 3.5 }, { specialSlotLimit: '3' }, { expectedUpdatedAtMs: undefined },
            { expectedUpdatedAtMs: Number.MAX_SAFE_INTEGER }, { featureEnabled: true },
            { consumesUserSlots: false }, { tier: 'paid' }, { planId: 'PlusExisting' },
        ]) await assert.rejects(dispatch(request('PATCH', 'push-capacity/plans/BasicExisting', planInput(changes)), ADMIN, services), { code: 'AUTOMATION_PUSH_CAPACITY_INVALID', status: 422 });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_plan_policy'))[0].n), 0);
    });
    let basicCapacity;
    await t.test('explicit paid eligibility and configurable caps preserve personal allowances and global limits', async () => {
        const beforePlans = await db.queryDatabase('SELECT * FROM automation_notification_plans ORDER BY plan_id');
        const firstSaves = await Promise.allSettled([0, 1].map(() => dispatch(request('PATCH', 'push-capacity/plans/basicexisting', planInput({ eligible: true, specialSlotLimit: 8 })), ADMIN, services)));
        assert.equal(firstSaves.filter(outcome => outcome.status === 'fulfilled').length, 1);
        assert.equal(firstSaves.find(outcome => outcome.status === 'rejected').reason.code, 'AUTOMATION_PUSH_CAPACITY_CONFLICT');
        basicCapacity = firstSaves.find(outcome => outcome.status === 'fulfilled').value;
        assert.equal(basicCapacity.planId, 'BasicExisting'); assert.equal(basicCapacity.specialSlotLimit, 8);
        assert.equal(basicCapacity.eligible, true); assert.equal(basicCapacity.consumesUserSlots, true); assert.equal(basicCapacity.featureEnabled, false);
        const plusCapacity = await dispatch(request('PATCH', 'push-capacity/plans/PlusExisting', planInput({ eligible: true, specialSlotLimit: 16 })), ADMIN, services);
        assert.equal(plusCapacity.specialSlotLimit, 16);
        assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_notification_plans ORDER BY plan_id'), beforePlans);
        assert.deepEqual(await capacity.getPoolPolicy(db.queryDatabase, ADMIN), pool);
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms) VALUES (?,0)', [OWNER.userId]);
        await db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, OWNER.userId, basic.planId));
        const entitlement = await plans.inspectPlan(db.queryDatabase, OWNER.userId);
        assert.equal(entitlement.slotLimit, 12); assert.equal(entitlement.planId, 'BasicExisting');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs'))[0].n), 0);
    });
    await t.test('paid CAS aliases identify one stored row and simultaneous edits preserve one winner', async () => {
        await assert.rejects(dispatch(request('PATCH', 'push-capacity/plans/BASICEXISTING', planInput()), ADMIN, services), { code: 'AUTOMATION_PUSH_CAPACITY_CONFLICT', status: 409 });
        const before = basicCapacity;
        const outcomes = await Promise.allSettled([9, 10].map(specialSlotLimit => dispatch(request('PATCH', 'push-capacity/plans/BASICEXISTING', planInput({ eligible: true, specialSlotLimit, expectedUpdatedAtMs: before.updatedAtMs })), ADMIN, services)));
        assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'AUTOMATION_PUSH_CAPACITY_CONFLICT');
        basicCapacity = outcomes.find(outcome => outcome.status === 'fulfilled').value;
        assert.equal(basicCapacity.planId, 'BasicExisting'); assert.ok(basicCapacity.updatedAtMs > before.updatedAtMs);
        assert.deepEqual(await capacity.getPlanCapacity(db.queryDatabase, ADMIN, 'basicexisting'), basicCapacity);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_push_plan_policy WHERE plan_id=?', ['BasicExisting']))[0].n), 1);
    });
    await t.test('disabled paid plans remain readable, reject activation and permit deactivation', async () => {
        basic = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, ordinaryPlan('BasicExisting', { enabled: false, expectedUpdatedAtMs: basic.updatedAtMs })));
        const disabled = await capacity.getPlanCapacity(db.queryDatabase, ADMIN, 'BasicExisting');
        assert.equal(disabled.planEnabled, false);
        await assert.rejects(dispatch(request('PATCH', 'push-capacity/plans/BasicExisting', planInput({ eligible: true, specialSlotLimit: 99, expectedUpdatedAtMs: disabled.updatedAtMs })), ADMIN, services), { code: 'AUTOMATION_PUSH_CAPACITY_INVALID', status: 422 });
        basicCapacity = await dispatch(request('PATCH', 'push-capacity/plans/BasicExisting', planInput({ eligible: false, specialSlotLimit: 0, expectedUpdatedAtMs: disabled.updatedAtMs })), ADMIN, services);
        assert.equal(basicCapacity.eligible, false); assert.equal(basicCapacity.specialSlotLimit, 0); assert.equal(basicCapacity.planEnabled, false);
    });
    await t.test('plan edits and special-capacity writes serialize at the existing plan row', async () => {
        basic = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, ordinaryPlan('BasicExisting', { enabled: true, expectedUpdatedAtMs: basic.updatedAtMs })));
        let held, release;
        const locked = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
        const disable = db.withDatabaseTransaction(async query => {
            await query('SELECT plan_id FROM automation_notification_plans WHERE plan_id=? FOR UPDATE', [basic.planId]);
            held(); await gate;
            return plans.savePlanPolicy(query, ADMIN, ordinaryPlan('BasicExisting', { enabled: false, expectedUpdatedAtMs: basic.updatedAtMs }));
        });
        await locked;
        const change = dispatch(request('PATCH', 'push-capacity/plans/BasicExisting', planInput({ eligible: true, specialSlotLimit: 7, expectedUpdatedAtMs: basicCapacity.updatedAtMs })), ADMIN, services);
        const failure = assert.rejects(change, { code: 'AUTOMATION_PUSH_CAPACITY_INVALID', status: 422 });
        release(); basic = await disable; await failure;
        assert.equal((await capacity.getPlanCapacity(db.queryDatabase, ADMIN, 'BasicExisting')).eligible, false);
    });
    await t.test('transaction failure rolls back configuration and never alters existing paid rows', async () => {
        const before = await capacity.getPoolPolicy(db.queryDatabase, ADMIN);
        await assert.rejects(db.withDatabaseTransaction(async query => {
            await capacity.savePoolPolicy(query, ADMIN, poolInput({ freePoolLimit: 1, expectedUpdatedAtMs: before.updatedAtMs }));
            throw new Error('fixture rollback');
        }), /fixture rollback/);
        assert.deepEqual(await capacity.getPoolPolicy(db.queryDatabase, ADMIN), before);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_plans'))[0].n), 2);
        assert.equal((await plans.listPlanPolicies(db.queryDatabase, ADMIN)).find(plan => plan.planId === plus.planId).slotLimit, 24);
    });
    await t.test('out-of-contract methods and extra path segments cannot expose an activation endpoint', async () => {
        for (const [method, path] of [['POST', 'push-capacity'], ['DELETE', 'push-capacity'], ['POST', 'push-capacity/plans/PlusExisting'], ['PATCH', 'push-capacity/enable'], ['GET', 'push-capacity/plans/PlusExisting/enable']]) {
            await assert.rejects(dispatch(request(method, path), ADMIN, services), { code: 'NOT_FOUND', status: 404 });
        }
        assert.equal((await capacity.getPoolPolicy(db.queryDatabase, ADMIN)).featureEnabled, false);
        assert.equal((await capacity.getPlanCapacity(db.queryDatabase, ADMIN, plus.planId)).featureEnabled, false);
    });
});

test('dormant configuration fails closed for invalid persisted flags and limits', async () => {
    const plan = { plan_id: 'ExistingBasic', label: 'Basic', enabled: 1 };
    const policy = { eligible: 2, special_slot_limit: 8, updated_at_ms: 1 };
    const query = async sql => sql.includes('FROM automation_notification_plans') ? [plan] : [policy];
    assert.equal((await capacity.getPlanCapacity(query, ADMIN, plan.plan_id)).eligible, false);
    policy.eligible = 1; policy.special_slot_limit = -1;
    const invalid = await capacity.getPlanCapacity(query, ADMIN, plan.plan_id);
    assert.equal(invalid.eligible, false); assert.equal(invalid.specialSlotLimit, 0); assert.equal(invalid.featureEnabled, false);
    const pools = await capacity.getPoolPolicy(async () => [{ free_pool_limit: -1, supporter_pool_limit: 100001, updated_at_ms: 1 }], ADMIN);
    assert.equal(pools.freePoolLimit, 0); assert.equal(pools.supporterPoolLimit, 0); assert.equal(pools.featureEnabled, false);
    await assert.rejects(capacity.getPoolPolicy(async () => [{ free_pool_limit: 50, supporter_pool_limit: 100, updated_at_ms: NaN }], ADMIN), { code: 'AUTOMATION_PUSH_CAPACITY_UNAVAILABLE', status: 503 });
});
