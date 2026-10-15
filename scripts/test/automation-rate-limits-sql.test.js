'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createRateLimiter, getPolicy, AutomationRateError } = require('../../src/automation/rate-limits');
const { createTransport } = require('../../src/automation/transport');
const { createRunner } = require('../../src/automation/runtime');
const { createQueue, targetIdentity } = require('../../src/automation/queue');
const { resolveNotificationEntitlement, savePlanPolicy, setUserPlan } = require('../../src/automation/entitlements');
const U = '222222222222222222', C = '333333333333333333', G = '111111111111111111', M = '444444444444444444';
const client = { options: { jsonTransformer: value => value } }, port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const principal = (slotIndex = 1, ownerUserId = U, extra = {}) => ({ ownerUserId, slotId: `${ownerUserId}:${slotIndex}`, slotIndex, minuteLimit: 5, dayLimit: 24, ...extra });
const record = (id, targetId, owner = U, text = '通知') => ({ id, owner_user_id: owner, target_kind: 'price', target_id: targetId, destination_id: `rotated-${id}`, workflow_id: `workflow-${id}`, revision: 1, plan: { context: {}, event: {}, text, dictionaryRefs: {}, display: { format: 'text', media: 'inherit' }, schedules: [] } });

test('durable per-slot physical-message quotas and tier priority', { skip: !port }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    let now = Date.parse('2026-10-13T03:00:00Z'), sequence = 0;
    const limiter = () => createRateLimiter(db, { clock: () => now });
    async function empty() { await db.queryDatabase('DELETE FROM automation_rate_reservations'); await db.queryDatabase('DELETE FROM automation_counters'); }
    const counts = () => db.queryDatabase('SELECT counter_key,used_count,expires_at_ms FROM automation_counters ORDER BY counter_key');
    async function native(owner = U) {
        const index = ++sequence;
        await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [owner]);
        const source = await db.queryDatabase('INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES (?,?,?,?,?,?,?)', ['steam', String(index), `https://store.steampowered.com/app/${index}`, 'ja', 60000, now, now]);
        const target = await db.queryDatabase('INSERT INTO price_watch_targets (source_id,user_id,destination_type,destination_key,watch_mode,rule_key,enabled,created_at_ms) VALUES (?,?,?,?,?,?,1,?)', [source.insertId, owner, 'dm', `dm:${owner}`, 'change', createHash('sha256').update(String(index)).digest('hex'), now]);
        return String(target.insertId);
    }
    const target = await native();
    const dmRest = messages => ({ post: async route => route === '/users/@me/channels' ? { id: C } : (messages.push(route), { id: M, channel_id: C }) });
    async function member(owner, targetId, text) {
        const runId = randomUUID(), row = (await db.queryDatabase('SELECT * FROM price_watch_targets WHERE id=?', [targetId]))[0];
        await db.queryDatabase('INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [runId, createHash('sha256').update(runId).digest('hex'), owner, 'private', 'price', targetId, '{}', '[]', 'queued', now]);
        return { id: runId, runId, targetKind: 'price', targetId, monitorRevision: 1, targetIdentity: targetIdentity(row), text, event: { title: text }, display: { format: 'text', media: 'inherit' }, context: { userId: owner } };
    }
    async function aggregate(owner, members) {
        const job = record(randomUUID(), members[0].targetId, owner); job.workflow_id = null; job.run_id = members[0].runId; job.lease_token = randomUUID(); job.created_at_ms = now;
        job.plan = { ...job.plan, members, flowV2: { members: members.map(entry => ({ memberId: entry.id, runId: entry.runId })) } };
        await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,lease_token,lease_until_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [job.id, job.run_id, JSON.stringify(job.plan), now, 'leased', job.lease_token, now + 120000, now, now]);
        return job;
    }

    await t.test('free quotas are per stable slot and reset each day at Japanese midnight', async () => {
        await empty(); const p = principal();
        for (let batch = 0; batch < 5; batch++) {
            const size = batch === 4 ? 4 : 5, quota = limiter(), reservation = await quota.reserveNotifications(p, size);
            for (let index = 0; index < size; index++) await quota.commitNotification(reservation, index);
            now += 60000;
        }
        await assert.rejects(limiter().reserveNotifications(p, 1), error => error.code === 'AUTOMATION_RATE_LIMITED' && error.scope === 'slot' && error.limit === 24 && error.windowMs === 86400000);
        const used = await limiter().getSlotUsage(p.slotId);
        assert.equal(used.todayUsed, 24); assert.equal(used.todayReserved, 0); assert.equal(new Date(used.resetAtMs).toISOString(), '2026-10-13T15:00:00.000Z');
        await limiter().reserveNotifications(principal(2), 5);
        assert.equal((await counts()).length, 4);
        now = used.resetAtMs; await limiter().reserveNotifications(p, 5);
        assert.equal((await counts()).length, 4, 'no counter per window, workflow or destination');
    });
    await t.test('multiple instances atomically reserve exactly five physical messages per slot', async () => {
        await empty();
        const results = await Promise.allSettled(Array.from({ length: 12 }, () => limiter().reserveNotifications(principal(), 1)));
        assert.equal(results.filter(item => item.status === 'fulfilled').length, 5);
        assert(results.filter(item => item.status === 'rejected').every(item => item.reason.code === 'AUTOMATION_RATE_LIMITED'));
        assert.deepEqual((await counts()).map(row => Number(row.used_count)), [5, 5]);
        const usage = await limiter().getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 0); assert.equal(usage.todayReserved, 5);
    });
    await t.test('composite participating-slot reservations are atomic, globally ordered and deduplicate a slot', async () => {
        await empty(); const p1 = principal(1), p2 = principal(2);
        await limiter().reserveNotifications(p2, 5); const before = await counts();
        await assert.rejects(limiter().reserveNotificationBatch([p1, p2, p1], 1), { code: 'AUTOMATION_RATE_LIMITED' }); assert.deepEqual(await counts(), before);
        await empty();
        const results = await Promise.allSettled(Array.from({ length: 10 }, (_entry, index) => limiter().reserveNotificationBatch(index % 2 ? [p1, p2] : [p2, p1, p2], 1)));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
        for (const result of results.filter(result => result.status === 'fulfilled')) { await limiter().beginNotification(result.value, 0); await limiter().commitNotification(result.value, 0); }
        assert.equal((await limiter().getSlotUsage(p1.slotId)).todayUsed, 5); assert.equal((await limiter().getSlotUsage(p2.slotId)).todayUsed, 5);
    });
    await t.test('failed multi-window reservations charge nothing and SQL failure fails closed', async () => {
        await empty(); const reservation = await limiter().reserveNotifications(principal(), 4); const before = await counts();
        await assert.rejects(limiter().reserveNotifications(principal(), 2), { code: 'AUTOMATION_RATE_LIMITED' }); assert.deepEqual(await counts(), before);
        await limiter().releaseNotifications(reservation);
        assert.deepEqual((await counts()).map(row => Number(row.used_count)), [0, 0]);
        const broken = { withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => { if (sql.startsWith('UPDATE automation_counters')) throw new Error('secret credentials'); return query(sql, params); })) };
        await assert.rejects(createRateLimiter(broken, { clock: () => now }).reserveNotifications(principal(3), 1), error => error.status === 503 && !error.message.includes('secret'));
        assert.equal((await counts()).length, 2);
    });
    await t.test('refunds are idempotent and never subtract another window or an in-flight message', async () => {
        await empty(); const quota = limiter(), first = await quota.reserveNotifications(principal(), 3);
        await quota.beginNotification(first, 0); await quota.commitNotification(first, 0);
        await quota.beginNotification(first, 1); await quota.retainUnknownNotification(first, 1);
        await quota.releaseNotifications(first); await quota.releaseNotifications(first);
        assert.deepEqual((await counts()).map(row => Number(row.used_count)), [2, 2]);
        let usage = await quota.getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 1); assert.equal(usage.todayReserved, 1);
        const beforeRollover = await quota.reserveNotifications(principal(), 1); now += 60000;
        const afterRollover = await quota.reserveNotifications(principal(), 1); await quota.commitNotification(afterRollover, 0);
        await quota.releaseNotifications(beforeRollover);
        usage = await quota.getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 2); assert.equal(usage.todayReserved, 1);
        const minute = (await counts()).find(row => Number(row.expires_at_ms) === now + 60000); assert.equal(Number(minute.used_count), 1);
    });
    await t.test('operation quotas stay actor based and do not accept client-selected groups', async () => {
        await empty(); const custom = createRateLimiter(db, { clock: () => now, policy: { operations: { write: { minute: 2 } } } });
        await custom.consumeOperation({ userId: U }); await custom.consumeOperation({ userId: U }); await assert.rejects(custom.consumeOperation({ userId: U }), { status: 429 });
        await custom.consumeOperation({ userId: M }); assert.throws(() => custom.consumeOperation({ userId: U }, 'disable'), TypeError);
        const policy = getPolicy(); policy.notifications.slot.day = 999; assert.equal(getPolicy().notifications.slot.day, 24);
    });
    await t.test('direct transport cannot evade quotas by changing workflows, revisions or destination UUIDs', async () => {
        await empty(); const messages = [];
        for (let index = 0; index < 6; index++) {
            const transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now }), job = record(`rotation-${index}`, target); job.revision = index + 1;
            const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
            if (index < 5) await transport.sendStep(prepared, job, 0); else await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'AUTOMATION_RATE_LIMITED' });
        }
        assert.equal(messages.length, 5); assert.equal((await limiter().getSlotUsage(`${U}:1`)).todayUsed, 5);
    });
    await t.test('deleting and recreating the native registration reuses the same spent slot', async () => {
        await empty();
        const otherOwner = '555555555555555555', firstTarget = await native(otherOwner), first = await resolveNotificationEntitlement(db, { ownerUserId: otherOwner, targetKind: 'price', targetId: firstTarget });
        await limiter().reserveNotifications({ ownerUserId: otherOwner, ...first }, 5);
        await db.queryDatabase('DELETE FROM price_watch_targets WHERE id=?', [firstTarget]);
        const replacement = await native(otherOwner), reused = await resolveNotificationEntitlement(db, { ownerUserId: otherOwner, targetKind: 'price', targetId: replacement });
        assert.equal(first.slotId, reused.slotId);
        await assert.rejects(limiter().reserveNotifications({ ownerUserId: otherOwner, ...reused }, 1), { code: 'AUTOMATION_RATE_LIMITED' });
    });
    await t.test('trusted plan upgrades and downgrades change caps without resetting a spent slot', async () => {
        await empty(); const owner = '666666666666666666', paidTarget = await native(owner);
        const free = await resolveNotificationEntitlement(db, { ownerUserId: owner, targetKind: 'price', targetId: paidTarget }), reservation = await limiter().reserveNotifications({ ...free, ownerUserId: owner }, 5);
        for (let index = 0; index < 5; index++) await limiter().commitNotification(reservation, index);
        const actor = { userId: U, isAdmin: true };
        await db.withDatabaseTransaction(async query => {
            await savePlanPolicy(query, actor, { planId: 'fixture-only', label: 'テスト専用', slotLimit: 8, minuteLimit: 8, dayLimit: 30, priority: 2 });
            await setUserPlan(query, actor, owner, 'fixture-only');
        });
        const paid = await resolveNotificationEntitlement(db, { ownerUserId: owner, targetKind: 'price', targetId: paidTarget });
        assert.equal(paid.tier, 'paid'); assert.equal(paid.slotId, free.slotId);
        const extra = await limiter().reserveNotifications({ ...paid, ownerUserId: owner }, 3);
        for (let index = 0; index < 3; index++) await limiter().commitNotification(extra, index);
        assert.equal((await limiter().getSlotUsage(paid.slotId)).todayUsed, 8);
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, null));
        const downgraded = await resolveNotificationEntitlement(db, { ownerUserId: owner, targetKind: 'price', targetId: paidTarget });
        await assert.rejects(limiter().reserveNotifications({ ...downgraded, ownerUserId: owner }, 1), { code: 'AUTOMATION_RATE_LIMITED' });
    });
    await t.test('preparation cannot retain a paid batch cap after downgrade before reservation', async () => {
        await empty(); const owner = '777777777777777771', id = await native(owner), actor = { userId: U, isAdmin: true };
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, 'fixture-only'));
        const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now }), job = record('paid-prepare', id, owner, 'x'.repeat(9501));
        const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, null));
        await assert.rejects(transport.reserve(prepared, job), error => error.code === 'AUTOMATION_DELIVERY_SIZE_LIMIT' && error.limit === 5);
        assert.equal(messages.length, 0); assert.equal((await counts()).length, 0);
    });
    await t.test('send-time downgrade releases unsent reservations and preserves a confirmed paid part', async () => {
        await empty(); const owner = '777777777777777772', id = await native(owner), actor = { userId: U, isAdmin: true };
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, 'fixture-only'));
        const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now }), job = record('paid-stale', id, owner, 'x'.repeat(3801)), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
        await transport.reserve(prepared, job); await transport.sendStep(prepared, job, 0);
        const keys = (await counts()).map(row => row.counter_key);
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, null));
        await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'AUTOMATION_PLAN_CHANGED', status: 429 });
        assert.deepEqual((await counts()).map(row => row.counter_key), keys);
        const usage = await limiter().getSlotUsage(`${owner}:1`); assert.equal(messages.length, 1); assert.equal(usage.todayUsed, 1); assert.equal(usage.todayReserved, 0);
    });
    await t.test('send-time expired paid entitlement cannot use a slot above the free allowance', async () => {
        await empty(); const owner = '777777777777777773', actor = { userId: U, isAdmin: true };
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, 'fixture-only'));
        let id; for (let index = 0; index < 6; index++) id = await native(owner);
        const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now }), job = record('paid-expired', id, owner), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
        await transport.reserve(prepared, job);
        await db.queryDatabase('UPDATE automation_notification_entitlements SET expires_at_ms=? WHERE owner_user_id=?', [Date.now() - 1, owner]);
        await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'AUTOMATION_SLOT_LIMIT' });
        const usage = await limiter().getSlotUsage(`${owner}:6`); assert.equal(messages.length, 0); assert.equal(usage.todayUsed, 0); assert.equal(usage.todayReserved, 0);
    });
    await t.test('one physical aggregate message charges every distinct contributing registration once', async () => {
        await empty(); const owner = '888888888888888881', first = await native(owner), second = await native(owner);
        const a = await member(owner, first, 'first'), b = await member(owner, second, 'second');
        const job = await aggregate(owner, [a, { ...a, text: 'same slot again' }, b]), messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now });
        const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner }); await transport.sendStep(prepared, job, 0);
        assert.equal(messages.length, 1); assert.equal((await limiter().getSlotUsage(`${owner}:1`)).todayUsed, 1); assert.equal((await limiter().getSlotUsage(`${owner}:2`)).todayUsed, 1);
    });
    await t.test('six disjoint physical parts charge three per contributing slot and keep attribution out of Discord', async () => {
        await empty(); const owner = '888888888888888885', first = await native(owner), second = await native(owner);
        const a = await member(owner, first, 'A'.repeat(5700)), b = await member(owner, second, 'B'.repeat(5700)), job = await aggregate(owner, [a, b]), bodies = [];
        const rest = { post: async (route, payload) => { if (route === '/users/@me/channels') return { id: C }; bodies.push(payload.body); return { id: M, channel_id: C }; } };
        const transport = createTransport(db, {}, client, { rest, clock: () => now }), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
        assert.equal(prepared.payloads.length, 6); assert.equal(Object.hasOwn(prepared, 'payloadSlots'), false);
        await transport.reserve(prepared, job);
        assert.equal((await limiter().getSlotUsage(`${owner}:1`)).todayReserved, 3); assert.equal((await limiter().getSlotUsage(`${owner}:2`)).todayReserved, 3);
        for (let index = 0; index < 6; index++) await transport.sendStep(prepared, job, index);
        assert.equal(bodies.length, 6); assert.equal((await limiter().getSlotUsage(`${owner}:1`)).todayUsed, 3); assert.equal((await limiter().getSlotUsage(`${owner}:2`)).todayUsed, 3);
        assert(bodies.every(body => !JSON.stringify(body).includes(`${owner}:`) && !Object.keys(body).some(key => /slot|attribut|reserv/i.test(key))));
    });
    await t.test('unknown aggregate part holds only that part participating slot and refunds the remaining parts', async () => {
        await empty(); const owner = '888888888888888886', first = await native(owner), second = await native(owner);
        const a = await member(owner, first, 'A'.repeat(5700)), b = await member(owner, second, 'B'.repeat(5700)), job = await aggregate(owner, [a, b]); let messages = 0;
        const rest = { post: async route => { if (route === '/users/@me/channels') return { id: C }; if (++messages === 4) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); return { id: M, channel_id: C }; } };
        const transport = createTransport(db, {}, client, { rest, clock: () => now }), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
        for (let index = 0; index < 3; index++) await transport.sendStep(prepared, job, index);
        await assert.rejects(transport.sendStep(prepared, job, 3));
        const one = await limiter().getSlotUsage(`${owner}:1`), two = await limiter().getSlotUsage(`${owner}:2`);
        assert.equal(one.todayUsed, 3); assert.equal(one.todayReserved, 0); assert.equal(two.todayUsed, 0); assert.equal(two.todayReserved, 1);
    });
    await t.test('legacy aggregate bindings are looked up from persisted child jobs and cannot be forged', async () => {
        await empty(); const owner = '888888888888888884', id = await native(owner), source = await member(owner, id, 'LEGACYCONTENT'), childId = randomUUID();
        await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?)', [childId, source.runId, '{}', now, 'pending', now, now]);
        const job = record('legacy', id, owner); job.plan.members = [{ jobId: childId, targetKind: 'price', text: source.text, event: source.event, display: source.display }];
        const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now }), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
        await transport.sendStep(prepared, job, 0); assert.equal(messages.length, 1); assert.equal((await limiter().getSlotUsage(`${owner}:1`)).todayUsed, 1);
        job.plan.members[0].targetKind = 'auto';
        await assert.rejects(transport.prepare(job, { kind: 'dm', dm_user_id: owner }), { code: 'AUTOMATION_AGGREGATE_MEMBERSHIP_INVALID' });
    });
    await t.test('standalone aggregate cannot hide an overflow slot behind a valid first member', async () => {
        await empty(); const owner = '888888888888888882', actor = { userId: U, isAdmin: true };
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, 'fixture-only'));
        const ids = []; for (let index = 0; index < 6; index++) ids.push(await native(owner));
        const a = await member(owner, ids[0], 'ALLOWED'), b = await member(owner, ids[5], 'OVERFLOWCONTENT'), job = await aggregate(owner, [a, b]);
        const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now }), destination = { kind: 'dm', dm_user_id: owner };
        const prepared = await transport.prepare(job, destination); await transport.reserve(prepared, job);
        await db.withDatabaseTransaction(query => setUserPlan(query, actor, owner, null));
        await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'AUTOMATION_SLOT_LIMIT' });
        await assert.rejects(transport.prepare(job, destination), { code: 'AUTOMATION_SLOT_LIMIT' });
        assert.equal(messages.length, 0); assert.equal((await limiter().getSlotUsage(`${owner}:1`)).todayReserved, 0); assert.equal((await limiter().getSlotUsage(`${owner}:6`)).todayReserved, 0);
        const refreshed = await createQueue(db, {}).refreshFlowJob(job, now);
        assert.equal(refreshed.state, 'ready'); assert.deepEqual(refreshed.job.plan.members.map(entry => entry.text), ['ALLOWED']);
        const healthy = await transport.prepare(refreshed.job, destination); assert(!healthy.payloads[0].body.content.includes('OVERFLOWCONTENT')); await transport.sendStep(healthy, refreshed.job, 0);
        assert.equal(messages.length, 1); assert.equal((await limiter().getSlotUsage(`${owner}:1`)).todayUsed, 1); assert.equal((await limiter().getSlotUsage(`${owner}:6`)).todayUsed, 0);
        const overflowOnly = await aggregate(owner, [b]); assert.deepEqual(await createQueue(db, {}).refreshFlowJob(overflowOnly, now), { state: 'excluded', code: 'AUTOMATION_SLOT_LIMIT' });
    });
    await t.test('deleting the first aggregate registration preserves its healthy peer and charges only that peer', async () => {
        await empty(); const owner = '888888888888888883', first = await native(owner), second = await native(owner);
        const slot = await resolveNotificationEntitlement(db, { ownerUserId: owner, targetKind: 'price', targetId: first }), used = await limiter().reserveNotifications({ ...slot, ownerUserId: owner }, 1); await limiter().commitNotification(used, 0);
        const a = await member(owner, first, 'DELETEDCONTENT'), b = await member(owner, second, 'HEALTHYCONTENT'), job = await aggregate(owner, [a, b]);
        await db.queryDatabase('DELETE FROM price_watch_targets WHERE id=?', [first]);
        const refreshed = await createQueue(db, {}).refreshFlowJob(job, now); assert.equal(refreshed.state, 'ready'); assert.deepEqual(refreshed.job.plan.members.map(entry => entry.text), ['HEALTHYCONTENT']);
        const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now }), prepared = await transport.prepare(refreshed.job, { kind: 'dm', dm_user_id: owner });
        assert(!prepared.payloads[0].body.content.includes('DELETEDCONTENT')); await transport.sendStep(prepared, refreshed.job, 0);
        assert.equal(messages.length, 1); assert.equal((await limiter().getSlotUsage(`${owner}:1`)).todayUsed, 1); assert.equal((await limiter().getSlotUsage(`${owner}:2`)).todayUsed, 1);
    });
    await t.test('webhook endpoint rotation still consumes the verified native registration slot', async () => {
        await empty(); let messages = 0, verified = 0;
        const transportDb = { ...db, queryDatabase: (sql, params) => sql === 'SELECT webhook_url FROM webhook_endpoints WHERE id=?' ? Promise.resolve([{ webhook_url: `https://discord.com/api/webhooks/${M}/${'a'.repeat(60)}` }]) : db.queryDatabase(sql, params) };
        const destinations = { verifyChannel: async (_actor, guild, channel) => { verified++; assert.equal(guild, G); assert.equal(channel, C); return { member: { roles: [] }, channel: { id: C } }; } };
        const rest = { get: async () => ({ channel_id: C, guild_id: G, type: 1 }), post: async () => (messages++, { id: M, channel_id: C }) };
        for (let index = 0; index < 6; index++) {
            const transport = createTransport(transportDb, destinations, client, { rest, clock: () => now }), job = record(`webhook-${index}`, target);
            const prepared = await transport.prepare(job, { kind: 'webhook', guild_id: G, channel_id: C, webhook_endpoint_id: String(index) });
            if (index < 5) await transport.sendStep(prepared, job, 0); else await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'AUTOMATION_RATE_LIMITED' });
        }
        assert.equal(messages, 5); assert.equal(verified, 6); assert.equal((await limiter().getSlotUsage(`${U}:1`)).todayUsed, 5);
    });
    await t.test('all split parts fit before first send and each confirmed message counts exactly once', async () => {
        await empty(); const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now });
        const oversized = record('big', target, U, 'x'.repeat(9501)), big = await transport.prepare(oversized, { kind: 'dm', dm_user_id: U });
        await assert.rejects(transport.reserve(big, oversized), { code: 'AUTOMATION_DELIVERY_SIZE_LIMIT', status: 400 }); assert.equal(messages.length, 0); assert.equal((await counts()).length, 0);
        const job = record('split', target, U, 'x'.repeat(3801)), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
        await Promise.all([transport.reserve(prepared, job), transport.reserve(prepared, job)]);
        for (let index = 0; index < 3; index++) await transport.sendStep(prepared, job, index);
        await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'SAFETY_UNPREPARED_MESSAGE' });
        assert.equal(messages.length, 3); assert.equal((await limiter().getSlotUsage(`${U}:1`)).todayUsed, 3);
    });
    await t.test('known unsent 429/403 and lifecycle denial refund quota; unknown ACKs retain the charge', async () => {
        for (const error of [Object.assign(new Error('fixture'), { status: 429 }), Object.assign(new Error('fixture'), { status: 403 }), Object.assign(new Error('fixture'), { code: 'ETIMEDOUT' })]) {
            await empty(); const transport = createTransport(db, {}, client, { rest: { post: async route => { if (route === '/users/@me/channels') return { id: C }; throw error; } }, clock: () => now });
            const job = record('error', target, U, 'x'.repeat(3801)), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
            await assert.rejects(transport.sendStep(prepared, job, 0));
            const usage = await limiter().getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 0); assert.equal(usage.todayReserved, error.code === 'ETIMEDOUT' ? 1 : 0);
        }
        await empty(); const messages = [], transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now, beforeSubmit: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } });
        const job = record('denied', target), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
        await assert.rejects(transport.sendStep(prepared, job, 0)); assert.equal(messages.length, 0); assert.equal((await limiter().getSlotUsage(`${U}:1`)).todayReserved, 0);
    });
    await t.test('quota ACK persistence failure after Discord confirmation is unknown and retains one message', async () => {
        await empty(); const messages = [], quota = limiter(); quota.commitNotification = async () => { throw new Error('DB disconnected after Discord ACK'); };
        const transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now, rateLimiter: quota }), job = record('ack', target, U, 'x'.repeat(3801)), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
        await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'DELIVERY_UNKNOWN' });
        const usage = await limiter().getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 0); assert.equal(usage.todayReserved, 1); assert.equal(messages.length, 1);
    });
    await t.test('confirmed parts remain charged when a later part is rejected before delivery', async () => {
        await empty(); let messages = 0;
        const rest = { post: async route => { if (route === '/users/@me/channels') return { id: C }; if (++messages > 1) throw Object.assign(new Error('denied'), { status: 403 }); return { id: M, channel_id: C }; } };
        const transport = createTransport(db, {}, client, { rest, clock: () => now }), job = record('partial', target, U, 'x'.repeat(3801)), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
        await transport.sendStep(prepared, job, 0); await assert.rejects(transport.sendStep(prepared, job, 1));
        const usage = await limiter().getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 1); assert.equal(usage.todayReserved, 0);
    });
    await t.test('concurrent prepared part claims cannot refund or send an in-flight part twice', async () => {
        await empty(); const messages = [];
        let releaseInspection;
        const inspecting = new Promise(resolve => { releaseInspection = resolve; });
        const transport = createTransport(db, {}, client, { rest: dmRest(messages), clock: () => now, safety: { assertNotification: async () => inspecting } }), job = record('once', target), prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U });
        await assert.rejects(transport.sendStep(prepared, { ...job, owner_user_id: M }, 0), { code: 'SAFETY_UNPREPARED_MESSAGE' });
        const sending = transport.sendStep(prepared, job, 0);
        await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'SAFETY_UNPREPARED_MESSAGE' });
        releaseInspection(); assert.equal(await sending, M);
        assert.equal(messages.length, 1); assert.equal((await limiter().getSlotUsage(`${U}:1`)).todayUsed, 1);
    });
    await t.test('native, X and mixed jobs share supporter plan priority while every fourth turn serves older free jobs', async () => {
        await db.queryDatabase('UPDATE users SET is_donor=1 WHERE user_id=?', [M]);
        await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1)', [M]);
        await db.withDatabaseTransaction(async query => {
            await savePlanPolicy(query, { userId: U, isAdmin: true }, { planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 13 });
            await savePlanPolicy(query, { userId: U, isAdmin: true }, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 7, dayLimit: 48, priority: 21 });
        });
        for (const variant of [{ name: 'native', kind: 'price' }, { name: 'X', kind: 'x' }, { name: 'mixed', kind: 'price', members: [{ targetKind: 'price' }, { targetKind: 'x' }] }]) {
            await empty(); await db.queryDatabase('DELETE FROM automation_jobs'); await db.queryDatabase('DELETE FROM automation_runs');
            for (const owner of [U, M]) for (let index = 0; index < 5; index++) {
                const runId = randomUUID(), id = randomUUID();
                await db.queryDatabase('INSERT INTO automation_runs (id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [runId, createHash('sha256').update(id).digest('hex'), owner, 'private', variant.kind, target, '{}', '[]', 'queued', now]);
                await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?)', [id, runId, JSON.stringify({ context: {}, schedules: [], ...(variant.members ? { members: variant.members } : {}) }), now, 'pending', now + (owner === U ? 0 : 1), now]);
            }
            const queue = createQueue(db, {}), owners = [];
            for (let turn = 0; turn < 4; turn++) { const job = await queue.claim(now); owners.push(job.owner_user_id); await queue.transition(job, 'sent'); }
            assert.deepEqual(owners, [M, M, M, U], variant.name);
        }
    });
    await t.test('runner releases preflight reservations on cancellation and frees workers for quota waits', async () => {
        const states = [], job = { ...record('queued', target), created_at_ms: now, attempts: 0 }; let begun = 0, released = 0;
        const queue = { claim: async () => job, check: async () => ({ state: 'ready', destination: {} }), beginSend: async () => (begun++, { state: 'cancelled', code: 'MONITOR_CHANGED' }), transition: async (_job, state, code, due) => states.push({ state, code, due }) };
        const fakeDb = { withDatabaseTransaction: work => work(async sql => sql.startsWith('SELECT expires') ? [{ expires_at_ms: 0 }] : { affectedRows: 1 }) }, options = { clock: () => now, assertAllowed: () => {}, notificationAllowed: () => true };
        const transport = { prepare: async () => ({ payloads: [{}] }), reserve: async () => { throw new AutomationRateError('AUTOMATION_RATE_LIMITED', 'fixture', 429, { retryAfterMs: 60000 }); }, release: async () => { released++; } };
        assert.equal((await createRunner(fakeDb, queue, transport, options).tick()).state, 'pending'); assert.equal(begun, 0); assert.equal(released, 1);
        transport.reserve = async () => {}; assert.equal((await createRunner(fakeDb, queue, transport, options).tick()).state, 'cancelled'); assert.equal(released, 2);
    });
});
