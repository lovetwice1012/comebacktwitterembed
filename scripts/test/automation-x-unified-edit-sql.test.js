'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { createService, hash } = require('../../src/automation/service');
const entitlements = require('../../src/automation/entitlements');
const capacity = require('../../src/automation/push-capacity');
const { dispatch } = require('../../src/automation/api');

const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('Unified edit SQL requires disposable AUTOMATION_TEST_DB_PORT=33621');
const ADMIN = { userId: '444444444444444444', isAdmin: true };
const owner = index => ({ userId: String(224444444000000000n + BigInt(index)) });
const account = index => ({ accountHandle: `unified_${index}`, name: `Unified edit fixture ${index}`, processingMode: 'batch' });
const apiFor = db => createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' });
const rtEdit = row => ({ expectedRevision: row.revision, poolKind: 'supporter', processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
const stored = async (db, row) => (await db.queryDatabase('SELECT * FROM automation_x_monitors WHERE id=?', [row.id]))[0];
const extras = async (db, user) => Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind='x'", [user.userId]))[0].n);
async function donor(db, user, slots = 1) {
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots) VALUES (?,0,1,?) ON DUPLICATE KEY UPDATE is_donor=1,additional_auto_extract_slots=VALUES(additional_auto_extract_slots)', [user.userId, slots]);
}
async function native(db, user) {
    const source = await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/synthetic/unified-edit',3600000,0)", [randomUUID()]);
    const target = await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_type,destination_key,enabled,created_at_ms) VALUES (?,?,'dm',?,1,0)", [user.userId, source.insertId, `dm:${user.userId}`]);
    await db.withDatabaseTransaction(query => entitlements.assignSlot(query, user.userId, 'auto', String(target.insertId)));
}
async function pools(db, free, supporter) {
    await db.withDatabaseTransaction(async query => {
        const old = await capacity.getPoolPolicy(query, ADMIN);
        await capacity.savePoolPolicy(query, ADMIN, { freePoolLimit: free, supporterPoolLimit: supporter, expectedUpdatedAtMs: old.updatedAtMs });
    });
}
async function scenario(t, label, work) {
    await t.test(label, async child => {
        const db = await createTestDatabase(port); child.after(() => db.close());
        await db.withDatabaseTransaction(async query => {
            for (const planId of ['free', 'supporter']) await entitlements.savePlanPolicy(query, ADMIN, { planId, label: planId, slotLimit: 5, minuteLimit: 7, dayLimit: 31, priority: 9, intervalMinutes: 5 });
        });
        await work(db, apiFor(db));
    });
}

test('unified X edits atomically confirm a current pool, destination and per-monitor notification timing', { timeout: 180000 }, async t => {
    await scenario(t, 'a fully used personal allowance permits the existing free registration to select one-slot supporter realtime', async (db, api) => {
        const user = owner(1); await donor(db, user);
        const row = await api.register(user, account(1));
        for (let index = 0; index < 5; index++) await native(db, user);
        const list = await api.list(user), quote = list.items[0].supporterRealtimeProcessing;
        assert.equal(list.quota.personal.available, 0); assert.equal(list.quota.supporterRealtimeRegistration.available, false);
        assert.equal(quote.eligible, true); assert.equal(quote.available, true); assert.equal(quote.realtimeSlotCost, 1);
        assert.equal(quote.realtimeEligibilitySource, 'supporter'); assert.equal(quote.effectiveMode, 'realtime');
        const changed = await api.update(user, row.id, rtEdit(row));
        assert.equal(changed.poolKind, 'supporter'); assert.equal(changed.processing.effectiveMode, 'realtime');
        assert.equal(changed.processing.slotCost, 1); assert.equal(await extras(db, user), 0);
        const quota = await api.summary(user); assert.equal(quota.personal.used, 6); assert.equal(quota.pools.free.used, 0); assert.equal(quota.pools.supporter.used, 1);
    });

    await scenario(t, 'one save changes name, handle, destination, receiver and timing without deleting or recreating the registration', async (db, api) => {
        const user = owner(2); await donor(db, user);
        const service = createService(db), destination = await service.saveDestination(user, { name: 'Unified updated destination', kind: 'dm' });
        const subscriptionId = randomUUID();
        await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_version,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,1,0,0)', [subscriptionId, user.userId, hash(randomUUID()), hash(randomUUID()), hash(randomUUID()), '{}', 'synthetic-key', 'synthetic-browser']);
        const row = await api.register(user, account(2)), before = await stored(db, row);
        const result = await api.update(user, row.id, { ...rtEdit(row), name: 'Updated monitor', accountHandle: '@new_handle', notificationSettings: { destinationId: destination.id, subscriptionId } });
        assert.equal(result.id, row.id); assert.equal(result.revision, row.revision + 1); assert.equal(result.accountHandle, 'new_handle');
        assert.equal(result.name, 'Updated monitor'); assert.equal(result.notificationSettings.destinationId, destination.id); assert.equal(result.notificationSettings.subscriptionId, subscriptionId);
        assert.equal(result.subscriptionState, 'bound'); assert.equal((await stored(db, row)).created_at_ms, before.created_at_ms); assert.deepEqual(result.quality, row.quality);
        const move = JSON.parse((await db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='x.quota.move'", [`x:${row.id}`]))[0].detail_json);
        assert.equal(move.manual, true); assert.equal(move.preservesDelivery, false); assert.equal(move.beforeRevision, undefined);
        const batch = await api.update(user, row.id, { expectedRevision: result.revision, processingMode: 'batch' });
        const rt = await api.update(user, row.id, { expectedRevision: batch.revision, processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        assert.equal(rt.poolKind, 'supporter'); assert.equal(rt.notificationSettings.destinationId, destination.id); assert.equal(rt.notificationSettings.subscriptionId, subscriptionId); assert.equal(rt.processing.effectiveMode, 'realtime');
    });

    await scenario(t, 'audit failure after the combined write rolls back pool, mode, destination, boosts and revision', async (db, api) => {
        const user = owner(3); await donor(db, user);
        const row = await api.register(user, { ...account(3), processingMode: 'realtime', expectedRealtimeSlotCost: 5 }), before = await stored(db, row);
        let injected = false;
        const broken = apiFor({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, args) => {
            const result = await query(sql, args);
            if (sql.startsWith('INSERT INTO automation_audit') && args[2] === 'x.quota.move') { injected = true; await query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic combined edit audit failure'"); }
            return result;
        })) });
        await assert.rejects(broken.update(user, row.id, { ...rtEdit(row), name: 'Must roll back' }));
        assert.equal(injected, true); assert.deepEqual(await stored(db, row), before); assert.equal(await extras(db, user), 4);
        const quota = await api.summary(user); assert.equal(quota.pools.free.used, 1); assert.equal(quota.pools.supporter.used, 0); assert.equal(quota.personal.used, 5);
    });

    await scenario(t, 'global supporter saturation rejects the whole edit without fallback to five slots or another pool', async (db, api) => {
        const user = owner(4); await donor(db, user); const row = await api.register(user, account(4)), before = await stored(db, row);
        await pools(db, 50, 0);
        const quote = (await api.list(user)).items[0].supporterRealtimeProcessing;
        assert.equal(quote.available, false); assert.equal(quote.reasonCode, 'X_MONITOR_SUPPORTER_POOL_FULL');
        await assert.rejects(api.update(user, row.id, { ...rtEdit(row), name: 'No partial save' }), { code: 'X_MONITOR_DESTINATION_FULL', status: 409 });
        assert.deepEqual(await stored(db, row), before); assert.equal(await extras(db, user), 0);
    });

    await scenario(t, '99 global supporter reservations plus two simultaneous explicit existing edits admit exactly one', async (db, api) => {
        for (let index = 0; index < 99; index++) {
            const user = owner(1000 + index); await donor(db, user);
            const inserted = await db.queryDatabase("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,'Occupied supporter fixture',1,'ready','supporter','{}','pending',1,0,0)", [user.userId, String(1000000 + index), `seed_${index}`]);
            await db.withDatabaseTransaction(query => entitlements.assignSlot(query, user.userId, 'x', String(inserted.insertId)));
        }
        const one = owner(5), two = owner(6); await donor(db, one); await donor(db, two);
        const a = await api.register(one, account(5)), b = await api.register(two, account(6));
        const results = await Promise.allSettled([api.update(one, a.id, rtEdit(a)), api.update(two, b.id, rtEdit(b))]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'X_MONITOR_DESTINATION_FULL');
        const quota = await api.summary(one); assert.equal(quota.pools.supporter.used, 100); assert.equal(quota.pools.free.used, 1);
        assert.equal(await extras(db, one) + await extras(db, two), 0);
    });

    await scenario(t, 'simultaneous edits of one monitor use CAS and reserve the destination once', async (db, api) => {
        const user = owner(7); await donor(db, user); const row = await api.register(user, account(7));
        const results = await Promise.allSettled([api.update(user, row.id, rtEdit(row)), api.update(user, row.id, rtEdit(row))]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'X_MONITOR_REVISION_CONFLICT');
        assert.equal((await api.summary(user)).pools.supporter.used, 1); assert.equal(await extras(db, user), 0);
    });

    await scenario(t, 'the existing supporter reservation remains available in a full global pool', async (db, api) => {
        const user = owner(8); await donor(db, user); await pools(db, 50, 1);
        const row = await api.register(user, { ...account(8), poolPreference: 'supporter', processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        const quote = (await api.list(user)).items[0].supporterRealtimeProcessing;
        assert.equal(quote.available, true); assert.equal((await api.summary(user)).pools.supporter.available, 0);
        const result = await api.update(user, row.id, { ...rtEdit(row), name: 'Retained allocation' });
        assert.equal(result.processing.effectiveMode, 'realtime'); assert.equal((await api.summary(user)).pools.supporter.used, 1);
    });

    await scenario(t, 'donor revocation after the quote rejects a one-slot confirmation without allocating five slots', async (db, api) => {
        const user = owner(9); await donor(db, user); const row = await api.register(user, account(9)), before = await stored(db, row);
        assert.equal(row.supporterRealtimeProcessing.available, true);
        await db.queryDatabase('UPDATE users SET is_donor=0 WHERE user_id=?', [user.userId]);
        await assert.rejects(api.update(user, row.id, rtEdit(row)), { code: 'X_REALTIME_COST_CONFLICT', status: 409 });
        assert.deepEqual(await stored(db, row), before); assert.equal(await extras(db, user), 0);
        assert.equal((await api.list(user)).items[0].supporterRealtimeProcessing.eligible, false);
    });

    await scenario(t, 'the owner mutex observes a concurrent donor revocation before applying the combined choice', async (db, api) => {
        const user = owner(10); await donor(db, user); const row = await api.register(user, account(10)), before = await stored(db, row);
        let ownerLocked, ownerAttempted, releaseOwner;
        const locked = new Promise(resolve => { ownerLocked = resolve; }), attempted = new Promise(resolve => { ownerAttempted = resolve; }), release = new Promise(resolve => { releaseOwner = resolve; });
        const holding = db.withDatabaseTransaction(async query => { await entitlements.lockOwner(query, user.userId); ownerLocked(); await release; await query('UPDATE users SET is_donor=0 WHERE user_id=?', [user.userId]); });
        await locked;
        const waiting = apiFor({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, args) => {
            if (sql.startsWith('INSERT INTO users') && args[0] === user.userId) ownerAttempted(); return query(sql, args);
        })) });
        const editing = waiting.update(user, row.id, rtEdit(row)); await attempted; releaseOwner(); await holding;
        await assert.rejects(editing, { code: 'X_REALTIME_COST_CONFLICT', status: 409 }); assert.deepEqual(await stored(db, row), before);
    });

    await scenario(t, 'a suspended out-of-limit primary slot cannot claim an edit quote or resume by changing pools', async (db, api) => {
        const user = owner(11); await donor(db, user);
        for (let index = 0; index < 5; index++) await native(db, user);
        const row = await api.register(user, account(11));
        await db.queryDatabase("UPDATE automation_notification_plans SET slot_limit=1 WHERE plan_id='supporter'");
        const listed = await api.reconcile(user), current = listed.items[0]; assert.equal(current.state, 'suspended');
        assert.equal(current.supporterRealtimeProcessing.available, false); assert.equal(current.supporterRealtimeProcessing.reasonCode, 'X_MONITOR_PERSONAL_LIMIT');
        await assert.rejects(api.update(user, row.id, rtEdit(current)), { code: 'X_MONITOR_PERSONAL_LIMIT' }); assert.equal((await stored(db, row)).pool_kind, 'free');
    });

    await scenario(t, 'a suspended over-ranked supporter entry cannot use another held entitlement', async (db, api) => {
        const user = owner(12); await donor(db, user, 2); await pools(db, 0, 100);
        const first = await api.register(user, account(12)); const row = await api.register(user, account(13));
        // Fixture represents an administrative entitlement correction, not a
        // payment migration: immutable grants must remain intact in production.
        await db.queryDatabase('UPDATE users SET additional_auto_extract_slots=1 WHERE user_id=?', [user.userId]);
        const reconciled = (await api.reconcile(user)).items, current = reconciled.find(value => value.id === row.id);
        assert.equal(current.state, 'suspended'); assert.equal(current.supporterRealtimeProcessing.available, false);
        await assert.rejects(api.update(user, row.id, rtEdit(current)), { code: 'X_MONITOR_DESTINATION_INELIGIBLE' });
        const valid = reconciled.find(value => value.id === first.id);
        assert.equal(valid.state, 'ready'); assert.equal(valid.supporterRealtimeProcessing.available, true);
        assert.equal((await api.update(user, first.id, rtEdit(valid))).processing.effectiveMode, 'realtime', 'a later suspended reservation does not revoke the qualified earlier rank');
    });

    await scenario(t, 'explicit changes validate owner, destination ownership, revision, pool and timing shape on the server', async (db, api) => {
        const user = owner(14), other = owner(15); await donor(db, user); await donor(db, other);
        const row = await api.register(user, account(14)), before = await stored(db, row);
        const destination = await createService(db).saveDestination(other, { name: 'Other private destination', kind: 'dm' });
        const services = { db, xQuota: api, service: { withOperation: (_actor, _group, work) => work() } };
        const request = body => ({ method: 'PATCH', path: ['x-monitors', row.id], body });
        await assert.rejects(dispatch(request(rtEdit(row)), other, services), { code: 'NOT_FOUND' });
        for (const input of [{ ...rtEdit(row), ownerUserId: other.userId }, { ...rtEdit(row), poolKind: 'unknown' }, { expectedRevision: row.revision, poolKind: 'supporter' }, { ...rtEdit(row), notificationSettings: { poolKind: 'supporter' } }])
            await assert.rejects(dispatch(request(input), user, services), { code: 'X_MONITOR_INVALID_INPUT' });
        await assert.rejects(api.update(user, row.id, { ...rtEdit(row), expectedRevision: row.revision + 1 }), { code: 'X_MONITOR_REVISION_CONFLICT' });
        await assert.rejects(api.update(user, row.id, { ...rtEdit(row), expectedRealtimeSlotCost: 5 }), { code: 'X_REALTIME_COST_CONFLICT' });
        await assert.rejects(api.update(user, row.id, { ...rtEdit(row), notificationSettings: { destinationId: destination.id } }), { code: 'NOT_FOUND' });
        assert.deepEqual(await stored(db, row), before);
    });

    await scenario(t, 'pure pool-only edits retain the trusted revision bridge while timing changes cannot impersonate that bridge', async (db, api) => {
        const user = owner(16); await donor(db, user); const row = await api.register(user, account(16));
        const moved = await api.update(user, row.id, { expectedRevision: row.revision, poolKind: 'supporter', processingMode: 'batch' });
        const first = JSON.parse((await db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='x.quota.move' ORDER BY id", [`x:${row.id}`]))[0].detail_json);
        assert.equal(first.preservesDelivery, true); assert.equal(first.beforeRevision, row.revision); assert.equal(first.afterRevision, moved.revision);
        const free = await api.update(user, row.id, { expectedRevision: moved.revision, poolKind: 'free', processingMode: 'batch' });
        await api.update(user, row.id, rtEdit(free));
        const all = (await db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='x.quota.move' ORDER BY id", [`x:${row.id}`])).map(value => JSON.parse(value.detail_json));
        assert.equal(all[2].preservesDelivery, false); assert.equal(all[2].beforeRevision, undefined); assert.equal(all[2].afterRevision, undefined);
    });

    await scenario(t, 'a read-only item quote never adopts or repairs physical reservations', async (db, api) => {
        const user = owner(17); await donor(db, user); const row = await api.register(user, account(17));
        const unchanged = await api.update(user, row.id, { expectedRevision: row.revision, name: ` ${row.name} ` });
        assert.equal(unchanged.revision, row.revision, 'a normalized unchanged display label does not invalidate an editor or queued revision');
        const statements = [];
        const readOnly = { ...db, queryDatabase: async (sql, args) => { statements.push(sql); if (!/^SELECT\s/i.test(sql)) throw new Error('Unexpected write in admin item serialization'); return db.queryDatabase(sql, args); } };
        // Admin summary intentionally performs integrity locking elsewhere; use
        // its serialization query directly through a public list with a wrapper
        // that exempts the existing owner-lock/adoption work and fences item reads.
        let serializing = false;
        const guarded = apiFor({ ...readOnly, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, args) => {
            if (sql.startsWith("SELECT * FROM automation_x_monitors WHERE owner_user_id")) serializing = true;
            if (serializing && !/^SELECT\s/i.test(sql)) {
                // quota() after items retains its pre-existing adoption API.
                if (sql.startsWith('INSERT INTO users')) serializing = false;
                else throw new Error('Unexpected write while serializing item quote');
            }
            return query(sql, args);
        })) });
        assert.equal((await guarded.list(user)).items[0].id, row.id);
    });

    await scenario(t, 'a name plus explicit timing save cannot masquerade as a harmless rename when it changes reserved slots', async (db, api) => {
        const user = owner(18);
        const row = await api.register(user, { ...account(18), processingMode: 'realtime', expectedRealtimeSlotCost: 5 });
        assert.equal(await extras(db, user), 4);
        await db.withDatabaseTransaction(async query => {
            const planId = 'UnifiedRealtimeBenefit';
            await entitlements.savePlanPolicy(query, ADMIN, { planId, label: 'Realtime fixture', slotLimit: 6, minuteLimit: 7, dayLimit: 31, priority: 9, intervalMinutes: 5 });
            const old = await capacity.getPlanCapacity(query, ADMIN, planId);
            await capacity.savePlanCapacity(query, ADMIN, planId, { eligible: true, specialSlotLimit: 6, realtimeEnabled: true, expectedUpdatedAtMs: old.updatedAtMs });
            await entitlements.setUserPlan(query, ADMIN, user.userId, planId);
        });
        const changed = await api.update(user, row.id, { expectedRevision: row.revision, name: 'Name and reservation changed', processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        assert.equal(changed.processing.slotCost, 1); assert.equal(await extras(db, user), 0);
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE entity_id=? AND action='x.monitor.rename'", [`x:${row.id}`]))[0].n), 0);
        assert.equal(await require('../../src/automation/monitor-revision-compat').monitorRevisionCompatible(db.queryDatabase,
            { kind: 'x', targetId: row.id, ownerUserId: user.userId, expectedRevision: row.revision, currentRevision: changed.revision }), false);
    });
});
