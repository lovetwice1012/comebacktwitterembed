'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const plans = require('../../src/automation/entitlements');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const { createService } = require('../../src/automation/service');
const { createQueue } = require('../../src/automation/queue');
const { dispatch } = require('../../src/automation/api');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const FREE = '222222222222222222', SUPPORTER = '333333333333333333', ADMIN = { userId: '444444444444444444', isAdmin: true };
const request = (method, path, body = {}) => ({ method, path: path.split('/'), body });
const input = (planId, changes = {}) => ({ planId, label: planId, slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, ...changes });

test('SQL: editable built-in plans, optimistic admin saves, stable counters and fair configured queue priorities', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,0,0),(?,0,1,2)', [FREE, SUPPORTER]);
    const services = { db, service: createService(db) };
    let freeRevision;
    await t.test('GET includes unsaved free/supporter defaults and requires actual admin identity', async () => {
        await assert.rejects(dispatch(request('GET', 'plans'), { userId: FREE }, services), { status: 403 });
        const result = await dispatch(request('GET', 'plans'), ADMIN, services);
        assert.deepEqual(result.items, [
            { ...plans.FREE_PLAN, enabled: true, isBuiltin: true, updatedAtMs: 0 },
            { ...plans.SUPPORTER_PLAN, enabled: true, isBuiltin: true, updatedAtMs: 0 },
        ]);
        assert.equal((await plans.inspectPlan(db.queryDatabase, SUPPORTER)).slotLimit, 7);
    });
    await t.test('only server admin edits policies; built-ins stay enabled; bounds and revision are validated', async () => {
        await assert.rejects(dispatch(request('PATCH', 'plans/free', { ...input('free'), isAdmin: true }), { userId: FREE }, services), { status: 403 });
        await assert.rejects(dispatch(request('PATCH', 'plans/free', input('free', { enabled: false })), ADMIN, services), { code: 'AUTOMATION_PLAN_INVALID', status: 422 });
        await assert.rejects(dispatch(request('POST', 'plans', input('supporter', { enabled: false })), ADMIN, services), { code: 'AUTOMATION_PLAN_INVALID', status: 422 });
        await assert.rejects(dispatch(request('POST', 'plans', input('FREE', { enabled: false })), ADMIN, services), { code: 'AUTOMATION_PLAN_INVALID', status: 422 });
        for (const changes of [{ slotLimit: 0 }, { minuteLimit: 10001 }, { dayLimit: 1000001 }, { priority: 101 }, { expectedUpdatedAtMs: -1 }])
            await assert.rejects(dispatch(request('PATCH', 'plans/free', input('free', changes)), ADMIN, services), { code: 'AUTOMATION_PLAN_INVALID', status: 422 });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_notification_plans'))[0].n), 0);
    });
    await t.test('first-save and concurrent CAS reject stale edits without replacing the winning settings', async () => {
        const saved = await dispatch(request('PATCH', 'plans/free', input('free', { label: '無料変更', slotLimit: 6, minuteLimit: 6, dayLimit: 30, priority: 4, expectedUpdatedAtMs: 0 })), ADMIN, services);
        freeRevision = saved.updatedAtMs;
        assert.equal(saved.tier, 'free'); assert.equal(saved.isBuiltin, true); assert(freeRevision > 0);
        await assert.rejects(dispatch(request('PATCH', 'plans/free', input('free', { expectedUpdatedAtMs: 0 })), ADMIN, services), { code: 'AUTOMATION_PLAN_CONFLICT', status: 409 });
        const writes = await Promise.allSettled(['first', 'second'].map(label => dispatch(request('PATCH', 'plans/free', input('free', { label, slotLimit: 6, minuteLimit: 6, dayLimit: 30, priority: 4, expectedUpdatedAtMs: freeRevision })), ADMIN, services)));
        assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(writes.find(item => item.status === 'rejected').reason.code, 'AUTOMATION_PLAN_CONFLICT');
        const winner = writes.find(item => item.status === 'fulfilled').value;
        assert(winner.updatedAtMs > freeRevision); freeRevision = winner.updatedAtMs;
        assert.equal((await plans.inspectPlan(db.queryDatabase, FREE)).label, winner.label);
        const legacy = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input('free', { slotLimit: 6, minuteLimit: 6, dayLimit: 30, priority: 4 })));
        assert(legacy.updatedAtMs > freeRevision); freeRevision = legacy.updatedAtMs;
    });
    await t.test('supporter override adds trusted individual extras; paid override takes precedence and falls back after disable/expiry', async () => {
        const supporter = await dispatch(request('PATCH', 'plans/supporter', input('supporter', { slotLimit: 8, minuteLimit: 9, dayLimit: 100, priority: 2, expectedUpdatedAtMs: 0 })), ADMIN, services);
        assert.equal(supporter.tier, 'supporter');
        assert.deepEqual(await plans.inspectPlan(db.queryDatabase, SUPPORTER), { tier: 'supporter', planId: 'supporter', label: 'supporter', slotLimit: 10, minuteLimit: 9, dayLimit: 100, priority: 2 });
        const paid = await dispatch(request('POST', 'plans', input('fixture-paid', { slotLimit: 12, minuteLimit: 20, dayLimit: 200, priority: 9, expectedUpdatedAtMs: 0 })), ADMIN, services);
        assert.equal(paid.tier, 'paid'); assert.equal(paid.isBuiltin, false);
        await db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, SUPPORTER, paid.planId, { expiresAtMs: Date.now() + 60000 }));
        assert.equal((await plans.inspectPlan(db.queryDatabase, SUPPORTER)).slotLimit, 12);
        assert.equal((await plans.inspectPlan(db.queryDatabase, SUPPORTER, Date.now() + 120000)).slotLimit, 10);
        await dispatch(request('PATCH', 'plans/fixture-paid', input('fixture-paid', { enabled: false, expectedUpdatedAtMs: paid.updatedAtMs })), ADMIN, services);
        assert.equal((await plans.inspectPlan(db.queryDatabase, SUPPORTER)).priority, 2);
        await assert.rejects(db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, FREE, 'supporter')), { code: 'AUTOMATION_PLAN_INVALID' });
        assert.deepEqual((await dispatch(request('GET', 'plans'), ADMIN, services)).items.map(plan => plan.planId), ['free', 'supporter', 'fixture-paid']);
    });
    await t.test('editing live free limits retains stable slot and spent physical-message counters', async () => {
        const source = await db.queryDatabase("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES ('steam','440','https://store.steampowered.com/app/440/','ja',60000,0,0)");
        const target = await db.queryDatabase("INSERT INTO price_watch_targets (user_id,source_id,destination_type,destination_key,watch_mode,rule_key,enabled,created_at_ms) VALUES (?,?,'dm',?,'change',?,1,0)", [FREE, source.insertId, `dm:${FREE}`, createHash('sha256').update('440').digest('hex')]);
        const before = await plans.resolveNotificationEntitlement(db, { ownerUserId: FREE, targetKind: 'price', targetId: String(target.insertId) });
        const limiter = createRateLimiter(db), held = await limiter.reserveNotifications({ ...before, ownerUserId: FREE }, 1);
        await limiter.commitNotification(held, 0);
        await dispatch(request('PATCH', 'plans/free', input('free', { minuteLimit: 1, dayLimit: 1, priority: 4, expectedUpdatedAtMs: freeRevision })), ADMIN, services);
        const after = await plans.resolveNotificationEntitlement(db, { ownerUserId: FREE, targetKind: 'price', targetId: String(target.insertId) });
        assert.equal(after.slotId, before.slotId); assert.equal(after.minuteLimit, 1); assert.equal(after.dayLimit, 1);
        assert.equal((await limiter.getSlotUsage(after.slotId)).todayUsed, 1);
        await assert.rejects(limiter.reserveNotifications({ ...after, ownerUserId: FREE }, 1), { code: 'AUTOMATION_RATE_LIMITED' });
    });
    await t.test('queue uses configured free/supporter priorities, disabled and expired paid fallback, and serves older intermediate groups', async () => {
        await db.queryDatabase('DELETE FROM automation_jobs'); await db.queryDatabase('DELETE FROM automation_runs'); await db.queryDatabase('DELETE FROM automation_counters');
        const HIGH = '555555555555555555', MID = '666666666666666666', now = Date.now();
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,0),(?,0,1)', [HIGH, MID]);
        await db.withDatabaseTransaction(async query => {
            await plans.savePlanPolicy(query, ADMIN, input('queue-high', { priority: 10 }));
            await plans.savePlanPolicy(query, ADMIN, input('queue-expired', { priority: 99 }));
            await plans.setUserPlan(query, ADMIN, HIGH, 'queue-high');
            await plans.setUserPlan(query, ADMIN, MID, 'queue-expired', { expiresAtMs: now + 1000 });
        });
        async function pending(owner, count, created) {
            for (let index = 0; index < count; index++) {
                const run = randomUUID(), job = randomUUID();
                await db.queryDatabase('INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [run, createHash('sha256').update(job).digest('hex'), owner, 'private', 'price', 1, '{}', '[]', 'queued', created + index]);
                await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?)', [job, run, JSON.stringify({ context: {}, schedules: [] }), now, 'pending', created + index, now]);
            }
        }
        await pending(MID, 1, now - 30); await pending(SUPPORTER, 1, now - 20); await pending(FREE, 1, now - 10); await pending(HIGH, 10, now);
        const queue = createQueue(db, {}), owners = [];
        for (let index = 0; index < 12; index++) { const job = await queue.claim(now + 2000); owners.push(job.owner_user_id); await queue.transition(job, 'sent'); }
        assert.deepEqual(owners.filter((_, index) => index % 4 === 3), [MID, SUPPORTER, FREE]);
        assert(owners.filter((_, index) => index % 4 !== 3).every(owner => owner === HIGH));
        await db.queryDatabase('UPDATE automation_notification_plans SET enabled=0 WHERE plan_id=?', ['queue-high']);
        await pending(SUPPORTER, 1, now + 1);
        assert.equal((await queue.claim(now + 2000)).owner_user_id, HIGH); // free priority 4 exceeds configured supporter 2.
    });
    await t.test('only verified paid Square contracts in the current merchant/environment apply, after valid manual assignments', async () => {
        const modulePath = require.resolve('../../src/automation/square-billing'), original = require.cache[modulePath];
        const scope = { configured: true, environment: 'sandbox', merchantId: 'fixture-merchant' };
        require.cache[modulePath] = { ...original, exports: { ...original?.exports, getSquareScope: () => scope } };
        try {
            const now = Date.now(), HIGH = '777777777777777777';
            await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms) VALUES (?,0)', [HIGH]);
            await db.withDatabaseTransaction(async query => {
                await plans.savePlanPolicy(query, ADMIN, input('square-proof', { slotLimit: 11, minuteLimit: 12, dayLimit: 90, priority: 8 }));
                await plans.savePlanPolicy(query, ADMIN, input('manual-proof', { slotLimit: 13, minuteLimit: 14, dayLimit: 91, priority: 3 }));
            });
            await db.queryDatabase(`INSERT INTO automation_square_subscriptions
                (owner_user_id,environment,merchant_id,plan_id,variation_id,customer_id,subscription_id,checkout_id,state,paid_through_at_ms,valid_until_at_ms,verified,updated_at_ms)
                VALUES (?,? ,?,'square-proof','variation','customer','subscription',?,'ACTIVE',?,?,1,?)`, [FREE, scope.environment, scope.merchantId, randomUUID(), now + 100000, now + 100000, now]);
            assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'square-proof');
            await db.queryDatabase("UPDATE automation_square_subscriptions SET state='CANCELED'");
            assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'square-proof');
            for (const changes of ["state='PAUSED'", "state='ACTIVE',verified=0", `state='ACTIVE',verified=1,valid_until_at_ms=${now}`]) {
                await db.queryDatabase(`UPDATE automation_square_subscriptions SET ${changes}`);
                assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'free');
            }
            await db.queryDatabase("UPDATE automation_square_subscriptions SET state='ACTIVE',verified=1,valid_until_at_ms=?", [now + 100000]);
            scope.environment = 'production'; assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'free');
            scope.environment = 'sandbox'; scope.merchantId = 'other-merchant'; assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'free');
            scope.merchantId = 'fixture-merchant'; scope.configured = false; assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'free');
            scope.configured = true;
            await db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, FREE, 'manual-proof', { expiresAtMs: now + 1000 }));
            assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'manual-proof');
            assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now + 2000)).planId, 'square-proof');
            await db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, FREE, 'manual-proof'));
            await db.queryDatabase('DELETE FROM automation_jobs'); await db.queryDatabase('DELETE FROM automation_runs'); await db.queryDatabase('DELETE FROM automation_counters');
            async function pending(owner, created) {
                const run = randomUUID(), job = randomUUID();
                await db.queryDatabase('INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [run, createHash('sha256').update(job).digest('hex'), owner, 'private', 'price', 1, '{}', '[]', 'queued', created]);
                await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?)', [job, run, JSON.stringify({ context: {}, schedules: [] }), now, 'pending', created, now]);
            }
            await pending(FREE, now - 1); await pending(HIGH, now);
            const queue = createQueue(db, {}), manual = await queue.claim(now);
            assert.equal(manual.owner_user_id, HIGH); await queue.transition(manual, 'sent'); // manual 3 beats out its Square 8; free HIGH is 4.
            await plans.setUserPlan(db.queryDatabase, ADMIN, FREE, null); await pending(HIGH, now);
            const billed = await queue.claim(now); assert.equal(billed.owner_user_id, FREE); await queue.transition(billed, 'sent');
            await db.queryDatabase("UPDATE automation_notification_plans SET enabled=0 WHERE plan_id='square-proof'");
            assert.equal((await plans.inspectPlan(db.queryDatabase, FREE, now)).planId, 'free');
        } finally { if (original) require.cache[modulePath] = original; else delete require.cache[modulePath]; }
    });
});

test('SQL: case aliases preserve one plan identity and canonical built-in policies', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,0),(?,0,1)', [FREE, SUPPORTER]);
    let paid;
    await t.test('legacy uppercase built-ins are listed once, stay built-in and cannot be disabled', async () => {
        for (const [planId, priority] of [['FREE', 0], ['Supporter', 1]]) await db.queryDatabase(`INSERT INTO automation_notification_plans
            (plan_id,label,slot_limit,minute_limit,day_limit,priority,enabled,actor_user_id,updated_at_ms) VALUES (?,?,5,5,24,?,1,?,42)`, [planId, planId, priority, ADMIN.userId]);
        const listed = await plans.listPlanPolicies(db.queryDatabase, ADMIN);
        assert.deepEqual(listed.map(plan => [plan.planId, plan.tier, plan.isBuiltin]), [['free', 'free', true], ['supporter', 'supporter', true]]);
        assert.equal((await plans.inspectPlan(db.queryDatabase, FREE)).tier, 'free');
        assert.equal((await plans.inspectPlan(db.queryDatabase, SUPPORTER)).tier, 'supporter');
        for (const planId of ['FREE', 'Supporter']) await assert.rejects(db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input(planId, { enabled: false }))), { code: 'AUTOMATION_PLAN_INVALID', status: 422 });
        const free = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input('FrEe', { label: '無料の保存', expectedUpdatedAtMs: 42 })));
        const supporter = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input('SUPPORTER', { label: '支援者の保存', priority: 1 })));
        assert.equal(free.planId, 'free'); assert.equal(free.tier, 'free'); assert.equal(free.isBuiltin, true);
        assert.equal(supporter.planId, 'supporter'); assert.equal(supporter.tier, 'supporter'); assert.equal(supporter.isBuiltin, true);
        assert.deepEqual((await db.queryDatabase('SELECT plan_id FROM automation_notification_plans ORDER BY plan_id')).map(row => row.plan_id), ['free', 'supporter']);
        assert.equal((await plans.listPlanPolicies(db.queryDatabase, ADMIN)).length, 2);
    });
    await t.test('case-alias paid saves preserve the stored ID and update the existing row', async () => {
        paid = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input('PaidCase', { expectedUpdatedAtMs: 0 })));
        const edited = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input('paidcase', { label: '更新後', slotLimit: 7, expectedUpdatedAtMs: paid.updatedAtMs })));
        assert.equal(edited.planId, 'PaidCase'); assert.equal(edited.tier, 'paid'); assert.equal(edited.isBuiltin, false); assert.equal(edited.slotLimit, 7);
        const legacy = await db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input('PAIDCASE', { label: '互換保存', slotLimit: 8 })));
        assert.equal(legacy.planId, 'PaidCase');
        const listed = await plans.listPlanPolicies(db.queryDatabase, ADMIN);
        assert.deepEqual(listed.map(plan => plan.planId), ['free', 'supporter', 'PaidCase']);
        assert.equal((await db.queryDatabase('SELECT plan_id FROM automation_notification_plans WHERE plan_id=?', ['paidcase']))[0].plan_id, 'PaidCase');
        await assert.rejects(db.withDatabaseTransaction(query => plans.savePlanPolicy(query, ADMIN, input('paidcase', { expectedUpdatedAtMs: 0 }))), { code: 'AUTOMATION_PLAN_CONFLICT', status: 409 });
    });
    await t.test('paid assignment stores the database ID; FREE aliases remove paid and supporter aliases cannot self-grant donor status', async () => {
        for (const owner of [FREE, SUPPORTER]) {
            const assigned = await db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, owner, 'pAiDcAsE'));
            assert.equal(assigned.planId, 'PaidCase'); assert.equal(assigned.tier, 'paid');
            assert.equal((await db.queryDatabase('SELECT plan_id FROM automation_notification_entitlements WHERE owner_user_id=?', [owner]))[0].plan_id, 'PaidCase');
            const cleared = await db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, owner, 'FREE'));
            assert.equal(cleared.planId, owner === FREE ? 'free' : 'supporter');
            assert.equal((await db.queryDatabase('SELECT * FROM automation_notification_entitlements WHERE owner_user_id=?', [owner])).length, 0);
            await assert.rejects(db.withDatabaseTransaction(query => plans.setUserPlan(query, ADMIN, owner, 'sUpPoRtEr')), { code: 'AUTOMATION_PLAN_INVALID', status: 422 });
        }
    });
});
