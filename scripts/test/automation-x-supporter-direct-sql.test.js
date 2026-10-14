'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const entitlements = require('../../src/automation/entitlements');
const capacity = require('../../src/automation/push-capacity');
const { createService } = require('../../src/automation/service');
const { dispatch } = require('../../src/automation/api');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('Direct supporter SQL requires disposable AUTOMATION_TEST_DB_PORT=33621');
const ADMIN = { userId: '444444444444444444', isAdmin: true };
const owner = index => ({ userId: String(223333333000000000n + BigInt(index)) });
const account = index => ({ accountHandle: `direct_${index}`, name: `Direct supporter fixture ${index}` });
const realtime = index => ({ ...account(index), processingMode: 'realtime', expectedRealtimeSlotCost: 1, poolPreference: 'supporter' });
const apiFor = db => createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' });
async function legacy(db, user, slots = 1, donor = true) {
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,?,?) ON DUPLICATE KEY UPDATE is_donor=VALUES(is_donor),additional_auto_extract_slots=VALUES(additional_auto_extract_slots)', [user.userId, donor ? 1 : 0, slots]);
}
async function pools(db, free = 50, supporter = 100) {
    await db.withDatabaseTransaction(async query => {
        const old = await capacity.getPoolPolicy(query, ADMIN);
        await capacity.savePoolPolicy(query, ADMIN, { freePoolLimit: free, supporterPoolLimit: supporter, expectedUpdatedAtMs: old.updatedAtMs });
    });
}
async function native(db, user) {
    const source = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/synthetic/direct-supporter',3600000,0)", [randomUUID()]);
    const target = await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_type,destination_key,enabled,created_at_ms) VALUES (?,?,'dm',?,1,0)", [user.userId, source.insertId, `dm:${user.userId}`]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, user.userId, 'auto', String(target.insertId)));
}
const count = async (db, table, user) => Number((await db.queryDatabase(`SELECT COUNT(*) n FROM ${table} WHERE owner_user_id=?`, [user.userId]))[0].n);
async function scenario(t, name, run) {
    await t.test(name, async child => {
        const db = await createTestDatabase(port); child.after(() => db.close());
        await db.withDatabaseTransaction(async query => {
            for (const planId of ['free', 'supporter']) await entitlements.savePlanPolicy(query, ADMIN, { planId, label: planId, slotLimit: 5, minuteLimit: 7, dayLimit: 31, priority: 9, intervalMinutes: 5 });
        });
        await run(db, apiFor(db));
    });
}

test('legacy donors explicitly create one-slot realtime in the independent supporter pool', { timeout: 180000 }, async t => {
    await scenario(t, 'one vacant personal slot can use the explicit supporter quote while the free pool is also vacant', async (db, api) => {
        const user = owner(1); await legacy(db, user);
        for (let index = 0; index < 5; index++) await native(db, user);
        const before = await api.summary(user);
        assert.equal(before.personal.available, 1); assert.equal(before.registrationProcessing.poolKind, 'free');
        assert.equal(before.registrationProcessing.canEnableRealtime, false); assert.equal(before.registrationProcessing.realtimeSlotCost, 5);
        assert.equal(before.supporterRealtimeRegistration.eligible, true); assert.equal(before.supporterRealtimeRegistration.available, true);
        assert.equal(before.supporterRealtimeRegistration.realtimeSlotCost, 1); assert.equal(before.supporterRealtimeRegistration.realtimeEligibilitySource, 'supporter');
        const row = await api.register(user, realtime(1)), after = await api.summary(user);
        assert.equal(row.poolKind, 'supporter'); assert.equal(row.processing.effectiveMode, 'realtime'); assert.equal(row.processing.realtimeSource, 'supporter');
        assert.equal(row.processing.slotCost, 1); assert.equal(after.personal.used, 6); assert.equal(after.personal.available, 0);
        assert.equal(after.pools.free.used, 0); assert.equal(after.pools.supporter.used, 1); assert.equal(await count(db, 'automation_notification_boost_slots', user), 0);
        const audit = (await db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='x.quota.allocate'", [`x:${row.id}`]))[0];
        assert.equal(JSON.parse(audit.detail_json).allocationPreference, 'supporter');
    });

    await scenario(t, 'automatic batch and realtime registration retain free-first allocation', async (db, api) => {
        const batch = owner(2), rt = owner(3); await legacy(db, batch); await legacy(db, rt);
        assert.equal((await api.register(batch, account(2))).poolKind, 'free');
        const row = await api.register(rt, { ...realtime(3), poolPreference: 'auto', expectedRealtimeSlotCost: 5 });
        assert.equal(row.poolKind, 'free'); assert.equal(row.processing.slotCost, 5);
    });

    await scenario(t, 'the direct route validates shape and mode instead of accepting arbitrary or nested privileges', async (db, api) => {
        const user = owner(4); await legacy(db, user);
        for (const input of [
            { ...account(4), poolPreference: 'supporter' },
            { ...realtime(4), processingMode: 'batch' },
            { ...realtime(4), poolPreference: 'special' },
            { ...realtime(4), notificationSettings: { poolPreference: 'supporter' } },
            { ...realtime(4), is_donor: 1 },
            { ...realtime(4), ownerUserId: owner(1).userId },
        ]) await assert.rejects(api.register(user, input), { code: 'X_MONITOR_INVALID_INPUT' });
        assert.equal(await count(db, 'automation_x_monitors', user), 0);
    });

    await scenario(t, 'newer support holdings without the trusted legacy list cannot claim direct one-slot realtime', async (db, api) => {
        const user = owner(5); await legacy(db, user, 5, false);
        const quote = (await api.summary(user)).supporterRealtimeRegistration;
        assert.equal(quote.eligible, false); assert.equal(quote.available, false); assert.equal(quote.reasonCode, 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE');
        await assert.rejects(api.register(user, realtime(5)), { code: 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE', status: 403 });
        assert.equal(await count(db, 'automation_x_monitors', user), 0);
    });

    await scenario(t, 'a donor badge without supporter holdings cannot allocate a supporter entry', async (db, api) => {
        const user = owner(6); await legacy(db, user, 0);
        assert.equal((await api.summary(user)).supporterRealtimeRegistration.eligible, false);
        await assert.rejects(api.register(user, realtime(6)), { code: 'X_MONITOR_SUPPORTER_LIMIT' });
        assert.equal(await count(db, 'automation_x_monitors', user), 0);
    });

    await scenario(t, 'a full supporter pool after preview rejects atomically despite free capacity and five vacant slots', async (db, api) => {
        const user = owner(7); await legacy(db, user);
        assert.equal((await api.summary(user)).supporterRealtimeRegistration.available, true);
        await pools(db, 50, 0);
        const quote = (await api.summary(user)).supporterRealtimeRegistration;
        assert.equal(quote.eligible, true); assert.equal(quote.available, false); assert.equal(quote.reasonCode, 'X_MONITOR_SUPPORTER_POOL_FULL');
        await assert.rejects(api.register(user, realtime(7)), { code: 'X_MONITOR_SUPPORTER_POOL_FULL', status: 409 });
        assert.equal(await count(db, 'automation_x_monitors', user), 0); assert.equal(await count(db, 'automation_notification_boost_slots', user), 0);
        assert.equal((await api.summary(user)).pools.free.used, 0);
    });

    await scenario(t, 'an outdated five-slot confirmation cannot silently select the one-slot supporter route', async (db, api) => {
        const user = owner(18); await legacy(db, user);
        await assert.rejects(api.register(user, { ...realtime(18), expectedRealtimeSlotCost: 5 }), { code: 'X_REALTIME_COST_CONFLICT', status: 409 });
        assert.equal(await count(db, 'automation_x_monitors', user), 0); assert.equal(await count(db, 'automation_notification_boost_slots', user), 0);
    });

    await scenario(t, 'a donor revocation committed while registration waits for the owner mutex is seen before allocation', async (db, api) => {
        const user = owner(19); await legacy(db, user);
        assert.equal((await api.summary(user)).supporterRealtimeRegistration.available, true);
        let ownerLocked, ownerAttempted, releaseOwner;
        const locked = new Promise(resolve => { ownerLocked = resolve; }), attempted = new Promise(resolve => { ownerAttempted = resolve; });
        const release = new Promise(resolve => { releaseOwner = resolve; });
        const holding = db.withDatabaseTransaction(async query => {
            await entitlements.lockOwner(query, user.userId); ownerLocked(); await release;
            await query('UPDATE users SET is_donor=0 WHERE user_id=?', [user.userId]);
        });
        await locked;
        const waiting = apiFor({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, args) => {
            if (sql.startsWith('INSERT INTO users') && args[0] === user.userId) ownerAttempted();
            return query(sql, args);
        })) });
        const registering = waiting.register(user, realtime(19));
        await attempted; releaseOwner(); await holding;
        await assert.rejects(registering, { code: 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE', status: 403 });
        assert.equal(await count(db, 'automation_x_monitors', user), 0); assert.equal((await entitlements.getEntitlementSummary(db, user.userId)).usedSlots, 0);
    });

    await scenario(t, 'supporters-only rollout independently rejects owners outside the trusted donor list', async (db, api) => {
        const user = owner(20); await legacy(db, user, 5, false);
        const closed = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'supporters' });
        await assert.rejects(closed.register(user, realtime(20)), { code: 'X_ROLLOUT_SUPPORTERS_ONLY', status: 403 });
        assert.equal((await api.summary(user)).pools.supporter.used, 0);
    });

    await scenario(t, 'personal limits and the owner supporter allowance remain mandatory', async (db, api) => {
        const user = owner(8); await legacy(db, user);
        const first = await api.register(user, realtime(8));
        assert.equal((await api.summary(user)).supporterRealtimeRegistration.reasonCode, 'X_MONITOR_SUPPORTER_LIMIT');
        await assert.rejects(api.register(user, realtime(9)), { code: 'X_MONITOR_SUPPORTER_LIMIT' });
        for (let index = 0; index < 5; index++) await native(db, user);
        assert.equal((await api.summary(user)).supporterRealtimeRegistration.reasonCode, 'X_MONITOR_PERSONAL_LIMIT');
        await assert.rejects(api.register(user, realtime(10)), { code: 'X_MONITOR_PERSONAL_LIMIT' });
        assert.equal((await api.list(user)).items[0].id, first.id);
    });

    await scenario(t, 'the last of one hundred global supporter entries can be allocated only once concurrently', async (db, api) => {
        // Seed valid legacy owners and physical base slots as fixture setup;
        // the racing requests below exercise the real global/owner mutexes.
        for (let index = 0; index < 99; index++) {
            const user = owner(1000 + index); await legacy(db, user);
            const inserted = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,'Synthetic occupied supporter entry',1,'ready','supporter','{}','pending',1,0,0)", [user.userId, String(1000000 + index), `seed_${index}`]);
            await db.withDatabaseTransaction(query => entitlements.assignSlot(query, user.userId, 'x', String(inserted.insertId)));
        }
        const one = owner(10), two = owner(11); await legacy(db, one); await legacy(db, two);
        const results = await Promise.allSettled([api.register(one, realtime(10)), api.register(two, realtime(11))]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.code, 'X_MONITOR_SUPPORTER_POOL_FULL');
        const summary = await api.summary(one); assert.equal(summary.pools.supporter.used, 100); assert.equal(summary.pools.free.used, 0);
        assert.equal(await count(db, 'automation_notification_boost_slots', one) + await count(db, 'automation_notification_boost_slots', two), 0);
    });

    await scenario(t, 'duplicate submission is idempotent even when its supporter allocation fills the pool', async (db, api) => {
        const user = owner(12); await legacy(db, user); await pools(db, 50, 1);
        const first = await api.register(user, realtime(12)), again = await api.register(user, realtime(12));
        assert.equal(again.id, first.id); assert.equal(again.revision, first.revision);
        assert.equal((await api.summary(user)).pools.supporter.used, 1); assert.equal(await count(db, 'automation_x_monitors', user), 1);
        await api.release(user, first.id, { expectedRevision: first.revision });
        const recreated = await api.register(user, realtime(12));
        assert.equal(recreated.poolKind, 'supporter'); assert.equal(recreated.processing.slotCost, 1);
        assert.equal((await api.summary(user)).pools.supporter.used, 1);
    });

    await scenario(t, 'duplicate direct registration never relocates an existing free registration or changes its notification mode', async (db, api) => {
        const user = owner(13); await legacy(db, user);
        const original = await api.register(user, account(13));
        await assert.rejects(api.register(user, realtime(13)), { code: 'X_MONITOR_REGISTRATION_CONFLICT', status: 409 });
        const preserved = (await api.list(user)).items[0];
        assert.equal(preserved.poolKind, 'free'); assert.equal(preserved.processing.requestedMode, 'batch'); assert.equal(preserved.revision, original.revision);
    });

    await scenario(t, 'a transaction failure after base-slot allocation rolls back the monitor and all pool/personal usage', async (db, api) => {
        const user = owner(14); await legacy(db, user); let injected = false;
        const broken = apiFor({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, args) => {
            const result = await query(sql, args);
            if (!injected && /^INSERT INTO automation_audit/.test(sql)) { injected = true; await query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic direct supporter failure'"); }
            return result;
        })) });
        await assert.rejects(broken.register(user, realtime(14)));
        assert.equal(injected, true); assert.equal(await count(db, 'automation_x_monitors', user), 0);
        assert.equal((await entitlements.getEntitlementSummary(db, user.userId)).usedSlots, 0); assert.equal((await api.summary(user)).pools.supporter.used, 0);
    });

    await scenario(t, 'notification timing and destination remain editable after direct creation without changing identity or pool', async (db, api) => {
        const user = owner(15); await legacy(db, user);
        const service = createService(db), destination = await service.saveDestination(user, { name: 'Synthetic updated DM', kind: 'dm' });
        const first = await api.register(user, realtime(15));
        const batch = await api.update(user, first.id, { expectedRevision: first.revision, processingMode: 'batch', notificationSettings: { destinationId: destination.id } });
        assert.equal(batch.processing.effectiveMode, 'batch'); assert.equal(batch.poolKind, 'supporter'); assert.equal(batch.notificationSettings.destinationId, destination.id);
        const immediate = await api.update(user, first.id, { expectedRevision: batch.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        assert.equal(immediate.id, first.id); assert.equal(immediate.accountHandle, first.accountHandle); assert.equal(immediate.poolKind, 'supporter');
        assert.equal(immediate.processing.slotCost, 1); assert.equal(immediate.processing.effectiveMode, 'realtime'); assert.equal(immediate.notificationSettings.destinationId, destination.id);
        assert.equal(await count(db, 'automation_notification_boost_slots', user), 0);
    });

    await scenario(t, 'session-scoped HTTP registration accepts the explicit choice and cannot select another owner', async (db, api) => {
        const user = owner(16); await legacy(db, user);
        const services = { db, xQuota: api, service: { withOperation: (_actor, _group, work) => work() } };
        const request = body => ({ method: 'POST', path: ['x-monitors'], body });
        const result = await dispatch(request(realtime(16)), user, services);
        assert.equal(result.poolKind, 'supporter'); assert.equal(result.processing.effectiveMode, 'realtime');
        await assert.rejects(dispatch(request({ ...realtime(17), ownerUserId: user.userId }), owner(17), services), { code: 'X_MONITOR_INVALID_INPUT' });
    });
});
