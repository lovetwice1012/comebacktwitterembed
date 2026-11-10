'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const plans = require('../../src/automation/entitlements');
const interval = require('../../src/automation/plan-interval');
const cadence = require('../../src/automation/monitor-cadence');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('A disposable database on port 33621 is required');

test('large batches are bounded and database errors propagate without stale fallback', async () => {
    const ids = Array.from({ length: 129 }, (_, i) => String(1000 + i)); let calls = 0;
    const query = async (_sql, args) => {
        calls++;
        return args.at(-1).map(id => ({ requested_owner: id, cutover_id: 1, interval_minutes: 30, legacy_owner: null }));
    };
    const result = await interval.currentPlanIntervals(query, ids, 1);
    assert.equal(calls, 2); assert.equal(result.size, 129); assert.equal(result.get('1128'), 30);
    await assert.rejects(interval.currentPlanIntervals(async () => { throw Object.assign(new Error('fixture DB fault'), { code: 'DB_FAULT' }); }, ids, 1), { code: 'DB_FAULT' });
});

test('batched interval reads preserve policies, donor floors, deletion fallback and fresh edits', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), admin = { userId: '900', isAdmin: true }, now = Date.now();
    try {
        await db.queryDatabase("INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES ('100',0,1),('200',0,0),('300',0,0)");
        await db.withDatabaseTransaction(async q => {
            await plans.savePlanPolicy(q, admin, { planId: 'free', label: 'Free', slotLimit: 3, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 180 });
            await plans.savePlanPolicy(q, admin, { planId: 'paid', label: 'Paid', slotLimit: 10, minuteLimit: 20, dayLimit: 72, priority: 4, intervalMinutes: 10 });
            await plans.setUserPlan(q, admin, '200', 'paid');
            await q("INSERT INTO automation_legacy_donor_benefits VALUES ('100',5,7,36,1,30,1,'900')");
            await q("INSERT INTO automation_legacy_donor_cutover VALUES (1,1,'900')");
        });
        let count = 0; const query = async (...args) => { count++; return db.queryDatabase(...args); };
        const expected = new Map();
        for (const id of ['100','200','300']) expected.set(id, await interval.currentPlanInterval(query, id, now));
        assert.equal(count, 3); count = 0;
        assert.deepEqual(await interval.currentPlanIntervals(query, ['100','200','300','100'], now), expected);
        assert.equal(count, 1, 'one query replaces one per distinct owner');
        const missing = await interval.currentPlanIntervals(query, ['100','999'], now);
        assert.equal(missing.get('999'), await interval.currentPlanInterval(query, '999', now));
        await db.queryDatabase("INSERT INTO automation_square_subscriptions (owner_user_id,environment,merchant_id,plan_id,variation_id,customer_id,subscription_id,checkout_id,state,valid_until_at_ms,verified,updated_at_ms) VALUES ('300','sandbox','m','paid','v','c','s','11111111-1111-4111-8111-111111111111','ACTIVE',?,1,?)", [now + 3600000, now]);
        const square = require('../../src/automation/square-billing'), originalScope = square.getSquareScope;
        try {
            square.getSquareScope = () => ({ configured: true, environment: 'sandbox', merchantId: 'm' });
            assert.equal(await interval.currentPlanInterval(query, '300', now), 10);
            assert.equal((await interval.currentPlanIntervals(query, ['100','200','300'], now)).get('300'), 10);
        } finally { square.getSquareScope = originalScope; }
        await db.withDatabaseTransaction(q => plans.savePlanPolicy(q, admin, { planId: 'paid', label: 'Paid', slotLimit: 10, minuteLimit: 20, dayLimit: 72, priority: 4, intervalMinutes: 20 }));
        assert.equal((await interval.currentPlanIntervals(query, ['100','200'], now)).get('200'), 20);
        await db.queryDatabase("UPDATE automation_legacy_donor_benefits SET confirmation_interval_minutes=0 WHERE owner_user_id='100'");
        await assert.rejects(interval.currentPlanIntervals(query, ['100','200'], now), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
    } finally { await db.close(); }
});

test('shared source computes unchanged schedule with two queries for ten targets', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), admin = { userId: '900', isAdmin: true }, now = Date.now();
    try {
        await db.withDatabaseTransaction(async q => {
            await plans.savePlanPolicy(q, admin, { planId: 'free', label: 'Free', slotLimit: 3, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 180 });
            await q("INSERT INTO automation_legacy_donor_cutover VALUES (1,1,'900')");
        });
        const s = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github','test','https://github.com/test',1800000,1)");
        for (let i = 0; i < 10; i++) {
            const id = String(1000 + i); await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms) VALUES (?,0)', [id]);
            await db.queryDatabase("INSERT INTO auto_watch_targets (source_id,user_id,destination_type,destination_key,created_at_ms) VALUES (?,?,'dm',?,1)", [s.insertId,id,'dm:'+id]);
        }
        let calls = 0; const q = async (...args) => { calls++; return db.queryDatabase(...args); };
        // Baseline: the former source loop performed one target query and two
        // policy/setting queries for every unboosted target.
        const originalTargets = await q(`SELECT t.id,t.user_id,COALESCE(u.auto_watch_interval_minutes*60000,s.poll_interval_ms) AS base_interval_ms,u.auto_watch_interval_minutes
            FROM auto_watch_targets t JOIN auto_watch_sources s ON s.id=t.source_id JOIN users u ON u.user_id=t.user_id WHERE t.source_id=? AND t.enabled=1`, [s.insertId]);
        let originalMinimum = Infinity;
        for (const target of originalTargets) originalMinimum = Math.min(originalMinimum, (await cadence.runtimeCadence(q, target.user_id, 'auto', String(target.id), Number(target.base_interval_ms), now)).intervalMs);
        assert.equal(calls, 21); calls = 0;
        const schedule = await cadence.sourceSchedule(q, { id: s.insertId, poll_interval_ms: 1800000 }, now);
        assert.equal(schedule.requested_poll_interval_ms, originalMinimum); assert.equal(schedule.requested_poll_interval_ms, 180 * 60000); assert.equal(calls, 2);
    } finally { await db.close(); }
});

test('X list shares repeated owner reads only during serialization and sees the next edit', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), actor = { userId: '100' }, now = Date.now();
    try {
        const counted = [];
        const wrapped = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => { counted.push(sql); return query(sql, params); })) };
        const quota = require('../../src/automation/x-monitor-quota').createXMonitorQuota(wrapped, { registrationEnabled: true, rolloutMode: 'public', now: () => now });
        for (let i = 1; i <= 3; i++) await quota.register(actor, { accountId: String(1000 + i), accountHandle: `fixture${i}`, name: `Fixture ${i}` });
        counted.length = 0;
        const before = await quota.list(actor);
        assert.equal(before.items.length, 3); assert.equal(before.quota.personal.totalLimit, 5);
        const reads = counted.filter(sql => sql.startsWith('SELECT slot_index,target_kind,target_id FROM automation_notification_slots'));
        assert.equal(reads.length, 3, 'the item phase shares one read; the two fresh quota previews keep their own reads');
        await db.queryDatabase('UPDATE users SET additional_auto_extract_slots=2 WHERE user_id=?', [actor.userId]);
        const after = await quota.list(actor);
        assert.equal(after.quota.personal.totalLimit, 7);
        assert.deepEqual(after.items.map(row => [row.id, row.poolKind, row.notificationSettings]), before.items.map(row => [row.id, row.poolKind, row.notificationSettings]));
    } finally { await db.close(); }
});

test('paid policy edits wake only associated sources and a selection failure falls back to all', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), admin = { userId: '900', isAdmin: true }, now = Date.now();
    try {
        await db.queryDatabase("INSERT INTO users (user_id,registered_at_ms) VALUES ('100',0),('200',0),('300',0)");
        await db.withDatabaseTransaction(async q => {
            await plans.savePlanPolicy(q, admin, { planId: 'free', label: 'Free', slotLimit: 3, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 180 });
            await plans.savePlanPolicy(q, admin, { planId: 'paid', label: 'Paid', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 1, intervalMinutes: 30 });
            await plans.setUserPlan(q, admin, '100', 'paid');
            await q("INSERT INTO automation_legacy_donor_cutover VALUES (1,1,'900')");
        });
        await db.queryDatabase("INSERT INTO automation_square_subscriptions (owner_user_id,environment,merchant_id,plan_id,variation_id,customer_id,subscription_id,checkout_id,state,updated_at_ms) VALUES ('200','sandbox','m','paid','v','c','s','11111111-1111-4111-8111-111111111111','CANCELED',1)");
        const sources = [];
        for (const [id, owner] of [['one','100'],['two','200'],['three','300']]) {
            const s = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES ('github',?,?,1800000,?,1)", [id,`https://github.com/${id}`,now+86400000]);
            sources.push(s.insertId);
            await db.queryDatabase("INSERT INTO auto_watch_targets (source_id,user_id,destination_type,destination_key,created_at_ms) VALUES (?,?,'dm',?,1)", [s.insertId,owner,'dm:'+owner]);
            const price = await db.queryDatabase("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES ('steam',?,?, 'ja',1800000,?,1)", [id,`https://example.com/${id}`,now+86400000]);
            await db.queryDatabase("INSERT INTO price_watch_targets (source_id,user_id,destination_type,destination_key,watch_mode,rule_key,created_at_ms) VALUES (?,?,'dm',?,'change','change',1)", [price.insertId,owner,'dm:'+owner]);
        }
        await db.withDatabaseTransaction(q => interval.wakePolicySources(q, now, 'paid'));
        let rows = await db.queryDatabase('SELECT id,next_check_at_ms FROM auto_watch_sources ORDER BY id');
        assert(Number(rows[0].next_check_at_ms) <= now + 300000);
        assert(Number(rows[1].next_check_at_ms) <= now + 300000);
        assert.equal(Number(rows[2].next_check_at_ms), now + 86400000);
        let prices = await db.queryDatabase('SELECT id,next_check_at_ms FROM price_watch_sources ORDER BY id');
        assert(Number(prices[0].next_check_at_ms) <= now + 300000);
        assert(Number(prices[1].next_check_at_ms) <= now + 300000);
        assert.equal(Number(prices[2].next_check_at_ms), now + 86400000);
        await db.withDatabaseTransaction(q => interval.wakePolicySources(async (sql, args) => {
            if (sql.includes('WHERE EXISTS')) throw Object.assign(new Error('synthetic selector fault'), { code: 'WAKE_TARGETS_UNAVAILABLE' });
            return q(sql, args);
        }, now, 'paid'));
        rows = await db.queryDatabase('SELECT id,next_check_at_ms FROM auto_watch_sources ORDER BY id');
        assert(rows.every(row => Number(row.next_check_at_ms) <= now + 300000));
        prices = await db.queryDatabase('SELECT id,next_check_at_ms FROM price_watch_sources ORDER BY id');
        assert(prices.every(row => Number(row.next_check_at_ms) <= now + 300000));
        await db.queryDatabase('UPDATE auto_watch_sources SET next_check_at_ms=?', [now+86400000]);
        await db.queryDatabase('UPDATE price_watch_sources SET next_check_at_ms=?', [now+86400000]);
        await assert.rejects(db.withDatabaseTransaction(q => interval.wakePolicySources(async (sql, args) => {
            if (sql.includes('price_watch_sources') && sql.includes('WHERE EXISTS')) throw Object.assign(new Error('synthetic deadlock'), { code: 'ER_LOCK_DEADLOCK' });
            return q(sql, args);
        }, now, 'paid')), { code: 'ER_LOCK_DEADLOCK' });
        rows = await db.queryDatabase('SELECT id,next_check_at_ms FROM auto_watch_sources ORDER BY id');
        assert(rows.every(row => Number(row.next_check_at_ms) === now + 86400000), 'rollback retains the first source update');
        let entered, release;
        const blocked = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const edit = db.withDatabaseTransaction(q => plans.savePlanPolicy(async (sql, args) => {
            if (sql.includes('auto_watch_sources') && sql.includes('WHERE EXISTS')) { entered(); await gate; }
            return q(sql, args);
        }, admin, { planId: 'paid', label: 'Paid', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 1, intervalMinutes: 20 }));
        await blocked;
        try { await db.withDatabaseTransaction(q => plans.setUserPlan(q, admin, '300', 'paid')); }
        finally { release(); }
        await edit;
        rows = await db.queryDatabase('SELECT id,next_check_at_ms FROM auto_watch_sources ORDER BY id');
        assert(Number(rows[2].next_check_at_ms) <= Date.now() + 300000, 'concurrent assignment wakes the newly affected owner');
        await db.queryDatabase('UPDATE auto_watch_sources SET next_check_at_ms=?', [now + 86400000]);
        await db.queryDatabase('UPDATE price_watch_sources SET next_check_at_ms=?', [now + 86400000]);
        const policy = { planId: 'paid', label: 'Paid', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 1 };
        await db.withDatabaseTransaction(q => plans.savePlanPolicy(q, admin, { ...policy, enabled: false }));
        assert.equal(await interval.currentPlanInterval(db.queryDatabase, '100'), 180);
        rows = await db.queryDatabase('SELECT next_check_at_ms FROM auto_watch_sources ORDER BY id');
        prices = await db.queryDatabase('SELECT next_check_at_ms FROM price_watch_sources ORDER BY id');
        assert(rows.every(row => Number(row.next_check_at_ms) <= Date.now() + 300000));
        assert(prices.every(row => Number(row.next_check_at_ms) <= Date.now() + 300000));
        await db.queryDatabase('UPDATE auto_watch_sources SET next_check_at_ms=?', [now + 86400000]);
        await db.queryDatabase('UPDATE price_watch_sources SET next_check_at_ms=?', [now + 86400000]);
        await db.withDatabaseTransaction(q => plans.savePlanPolicy(q, admin, policy));
        assert.equal(await interval.currentPlanInterval(db.queryDatabase, '100'), 20, 'omitting enabled re-enables the existing interval');
        rows = await db.queryDatabase('SELECT next_check_at_ms FROM auto_watch_sources ORDER BY id');
        prices = await db.queryDatabase('SELECT next_check_at_ms FROM price_watch_sources ORDER BY id');
        assert(rows.every(row => Number(row.next_check_at_ms) <= Date.now() + 300000));
        assert(prices.every(row => Number(row.next_check_at_ms) <= Date.now() + 300000));
        await assert.rejects(db.withDatabaseTransaction(q => plans.savePlanPolicy(async (sql, args) => {
            if (sql.includes('price_watch_sources') && sql.includes('WHERE EXISTS')) throw Object.assign(new Error('synthetic deadlock'), { code: 'ER_LOCK_DEADLOCK' });
            return q(sql, args);
        }, admin, { ...policy, enabled: false })), { code: 'ER_LOCK_DEADLOCK' });
        assert.equal(await interval.currentPlanInterval(db.queryDatabase, '100'), 20, 'failed wake rolls back the plan change');
    } finally { await db.close(); }
});
