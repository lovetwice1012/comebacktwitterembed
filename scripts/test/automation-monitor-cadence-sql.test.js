'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const entitlements = require('../../src/automation/entitlements');
const cadence = require('../../src/automation/monitor-cadence');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), ADMIN = { userId: '444444444444444444', isAdmin: true };
const actor = i => ({ userId: String(222222222222222000n + BigInt(i)), guildId: '111111111111111111', canView: true, canEdit: true });
test('real SQL per-monitor cadence uses shared physical notification slots and preserves source and delivery timing', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), now = Date.now();
    const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/autoWatch/store'), require.resolve('../../src/providers/priceWatch/store')];
    const originals = paths.map(path => require.cache[path]);
    try {
        const schema = require('../../src/db_schema');
        const intervalMigration = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../migrations/20261006_add_user_auto_watch_intervals.sql'), 'utf8');
        await db.queryDatabase(schema._internal.splitSqlStatements(intervalMigration).find(sql => sql.startsWith('CREATE TABLE')));
        require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { ...db, ensureUserExistsInDatabase: async userId => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [userId]) } };
        require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: { ...schema, ensureDatabaseSchema: async () => {} } };
        delete require.cache[paths[2]]; delete require.cache[paths[3]];
        const store = require(paths[2]), priceStore = require(paths[3]);
        const admission = createRateLimiter(db, { policy: { operations: { monitor: { minute: 1000, hour: 10000 }, write: { minute: 1000, hour: 10000 } } } });
        const service = createService(db, { rateLimiter: admission }), monitors = createMonitors(db, service, {}), destinations = new Map();
        async function destination(owner) {
            if (!destinations.has(owner.userId)) destinations.set(owner.userId, (await service.saveDestination(owner, { name: 'fixture DM', kind: 'dm' })).id);
            return destinations.get(owner.userId);
        }
        async function auto(owner, source = 'octocat') { return monitors.save(owner, 'auto', { name: source, providerId: 'github', source, destinationId: await destination(owner) }); }
        async function price(owner, product) { return priceStore.registerTarget({ userId: owner.userId, providerId: 'steam', productUrl: 'https://store.steampowered.com/app/' + product + '/', destinationType: 'dm', mode: 'change' }, { operationRateLimiter: admission }); }
        const summary = owner => entitlements.getEntitlementSummary(db, owner.userId);
        const boost = async (owner, target, cost) => {
            const current = (await db.queryDatabase('SELECT updated_at_ms FROM automation_monitor_cadence WHERE owner_user_id=? AND target_kind=\'auto\' AND target_id=?', [owner.userId, target.id]))[0];
            return monitors.setCadence(owner, 'auto', target.id, { slotCost: cost, expectedRevision: target.revision || 1, expectedUpdatedAtMs: current ? Number(current.updated_at_ms) : null });
        };
        async function targetRow(target) { return (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [target.id]))[0]; }
        async function readySource(target, interval = 30 * 60000) {
            const row = await targetRow(target); await db.queryDatabase('UPDATE auto_watch_sources SET poll_interval_ms=?,last_checked_at_ms=?,next_check_at_ms=?,initialized_at_ms=?,state_json=?,cursor_json=? WHERE id=?',
                [interval, now, now, now - 1, '{"baseline":"keep"}', '{"seenContentIds":["existing"]}', row.source_id]);
            await db.queryDatabase('UPDATE auto_watch_targets SET baseline_at_ms=?,last_polled_at_ms=?,next_poll_at_ms=?,last_notification_window_at_ms=?,created_at_ms=? WHERE id=?', [now - 1, now, now + interval, now, now - 2, target.id]);
            return (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [row.source_id]))[0];
        }
        let shared, primary, peer;
        await t.test('cost three reserves real numbered frames; paused auto and price share the five-frame pool and retain canonical slot identity', async () => {
            const owner = actor(1), first = await auto(owner, 'cadenceowner1'); await readySource(first); const identity = (await summary(owner)).slots[0].slotId;
            await boost(owner, first, 3); let info = await summary(owner); assert.equal(info.usedSlots, 3); assert.equal(info.remainingSlots, 2); assert.equal(info.slots[0].slotId, identity); assert.equal(info.slots[0].slotCost, 3);
            const p = await price(owner, 440), paused = await auto(owner, 'cadenceowner2'); await monitors.save(owner, 'auto', { expectedRevision: paused.revision, enabled: false }, paused.id);
            info = await summary(owner); assert.equal(info.usedSlots, 5); assert.equal(info.remainingSlots, 0); assert.equal(info.slots.find(slot => slot.targetKind === 'price').targetId, p.id);
            await assert.rejects(price(owner, 570), { code: 'AUTOMATION_SLOT_LIMIT' });
            const extras = await db.queryDatabase('SELECT slot_index FROM automation_notification_boost_slots WHERE owner_user_id=? ORDER BY slot_index', [owner.userId]);
            assert.deepEqual(extras.map(row => Number(row.slot_index)), [2, 3]); assert.deepEqual(info.slots.map(slot => slot.slotIndex).sort((a, b) => a - b), [1, 4, 5]);
        });
        await t.test('concurrent boosts cannot double-book numbered frames or let new registrations steal a reserved index', async () => {
            const owner = actor(2), first = await auto(owner, 'cadenceconcurrent1'), second = await auto(owner, 'cadenceconcurrent2'); await readySource(first); await readySource(second);
            const results = await Promise.allSettled([boost(owner, first, 3), boost(owner, second, 3)]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected')[0].reason.code, 'AUTOMATION_SLOT_LIMIT');
            const p = await price(owner, 730), info = await summary(owner); assert.equal(info.usedSlots, 5);
            const extra = await db.queryDatabase('SELECT slot_index FROM automation_notification_boost_slots WHERE owner_user_id=?', [owner.userId]);
            assert.ok(!extra.some(row => Number(row.slot_index) === info.slots.find(slot => slot.targetKind === 'price' && slot.targetId === p.id).slotIndex));
        });
        await t.test('reducing to one frame is allowed while operation limits reject increases; deletion releases all boosted frames', async () => {
            const owner = actor(3), target = await auto(owner, 'cadencereduce'); await readySource(target); await boost(owner, target, 3);
            const exhausted = createMonitors(db, { ...service, withOperation: async () => { throw Object.assign(new Error('fixture exhausted'), { code: 'AUTOMATION_RATE_LIMITED' }); } }, {});
            const current = Number((await db.queryDatabase('SELECT updated_at_ms FROM automation_monitor_cadence WHERE target_id=?', [target.id]))[0].updated_at_ms);
            await exhausted.setCadence(owner, 'auto', target.id, { slotCost: 1, expectedRevision: 1, expectedUpdatedAtMs: current }); assert.equal((await summary(owner)).usedSlots, 1);
            await assert.rejects(exhausted.setCadence(owner, 'auto', target.id, { slotCost: 3, expectedRevision: 1, expectedUpdatedAtMs: Date.now() }), { code: 'AUTOMATION_RATE_LIMITED' });
            await boost(owner, target, 3); await monitors.remove(owner, 'auto', target.id, 1); assert.equal((await summary(owner)).usedSlots, 0);
            assert.equal((await db.queryDatabase('SELECT * FROM automation_notification_boost_slots WHERE owner_user_id=?', [owner.userId])).length, 0);
        });
        await t.test('guild editors cannot spend another owner frames, even on a shared monitor they can edit', async () => {
            const owner = actor(4), editor = actor(5), target = await auto(owner, 'cadenceguild'); await readySource(target);
            await db.queryDatabase("UPDATE auto_watch_targets SET destination_type='webhook',guild_id=? WHERE id=?", [owner.guildId, target.id]);
            await db.queryDatabase("UPDATE automation_monitors SET scope='guild' WHERE target_kind='auto' AND target_id=?", [target.id]);
            await assert.rejects(monitors.setCadence(editor, 'auto', target.id, { slotCost: 3, expectedRevision: 1, expectedUpdatedAtMs: null }), { code: 'FORBIDDEN' });
            assert.equal((await summary(owner)).usedSlots, 1); assert.equal((await summary(editor)).usedSlots, 0);
        });
        await t.test('tier downgrade uses one frame at runtime while preserving the selected three-frame preference', async () => {
            const owner = actor(6), target = await auto(owner, 'cadencedowngrade'); await readySource(target);
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'cadencepro', label: 'Cadence pro', slotLimit: 10, minuteLimit: 10, dayLimit: 100, priority: 2 });
            await entitlements.setUserPlan(db.queryDatabase, ADMIN, owner.userId, 'cadencepro'); await boost(owner, target, 3);
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free one', slotLimit: 1, minuteLimit: 5, dayLimit: 24, priority: 0 });
            await entitlements.setUserPlan(db.queryDatabase, ADMIN, owner.userId, null);
            const runtime = await cadence.runtimeCadence(db.queryDatabase, owner.userId, 'auto', target.id, 30 * 60000, now);
            assert.equal(runtime.slotCost, 3); assert.equal(runtime.effectiveSlotCost, 1); assert.equal(runtime.intervalMs, 30 * 60000); assert.equal(runtime.limited, true);
            const listed = (await monitors.list(owner, 'auto')).items.find(item => item.id === target.id); assert.equal(listed.slotCost, 3); assert.equal(listed.effectiveSlotCost, 1);
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0 });
        });
        await t.test('shared source takes the fastest eligible target while the default peer keeps its own delivery schedule without buying frames', async () => {
            primary = actor(7); peer = actor(8); const first = await auto(primary, 'cadenceshared'), other = await auto(peer, 'cadenceshared');
            shared = await readySource(first); await readySource(other); await boost(primary, first, 3);
            const schedule = await cadence.sourceSchedule(db.queryDatabase, shared, now); assert.equal(schedule.requested_poll_interval_ms, 10 * 60000); assert.equal((await summary(peer)).usedSlots, 1);
            await store.createItemsAndDeliveries(shared, [{ contentId: 'shared-new', url: 'https://github.com/cadenceshared/one', title: 'New', discoveredAtMs: now + 1000 }], now + 1000);
            const deliveries = await db.queryDatabase('SELECT d.*,t.user_id FROM auto_watch_deliveries d JOIN auto_watch_targets t ON t.id=d.target_id JOIN auto_watch_items i ON i.id=d.item_id WHERE i.source_id=?', [shared.id]);
            assert.equal(Number(deliveries.find(row => row.user_id === primary.userId).next_attempt_at_ms), now + 10 * 60000);
            assert.equal(Number(deliveries.find(row => row.user_id === peer.userId).next_attempt_at_ms), now + 30 * 60000);
        });
        await t.test('source claims expose actual requested boosted cadence and provider budget still imposes a floor', async () => {
            const claimed = (await store.claimDueSources(now + 10 * 60000, 128)).find(source => String(source.id) === String(shared.id)); assert.ok(claimed); assert.equal(Number(claimed.requested_poll_interval_ms), 10 * 60000);
            const old = process.env.AUTO_WATCH_GITHUB_DAILY_BUDGET; process.env.AUTO_WATCH_GITHUB_DAILY_BUDGET = '1';
            try { assert.ok(store.computedPollInterval(claimed, 1) >= 86400000); } finally { if (old === undefined) delete process.env.AUTO_WATCH_GITHUB_DAILY_BUDGET; else process.env.AUTO_WATCH_GITHUB_DAILY_BUDGET = old; }
            await store.rescheduleSource(claimed, now + 30 * 60000);
        });
        await t.test('cadence edits shift untouched pending attempts without resetting baseline, cursor or creating duplicate discoveries', async () => {
            const owner = actor(9), target = await auto(owner, 'cadencepending'), source = await readySource(target); await store.createItemsAndDeliveries(source, [{ contentId: 'pending-one', url: 'https://github.com/cadencepending/one', discoveredAtMs: now + 1000 }], now + 1000);
            const before = await targetRow(target); await boost(owner, target, 3); const after = await targetRow(target);
            assert.equal(Number(after.baseline_at_ms), Number(before.baseline_at_ms)); assert.equal(Number(after.last_polled_at_ms), Number(before.last_polled_at_ms)); assert.equal(Number(after.next_poll_at_ms), now + 10 * 60000);
            const delivery = (await db.queryDatabase('SELECT * FROM auto_watch_deliveries WHERE target_id=?', [target.id]))[0]; assert.equal(Number(delivery.next_attempt_at_ms), now + 10 * 60000);
            await store.createItemsAndDeliveries(source, [{ contentId: 'pending-one', url: 'https://github.com/cadencepending/one', discoveredAtMs: now + 1000 }], now + 1000); assert.equal((await db.queryDatabase('SELECT * FROM auto_watch_deliveries WHERE target_id=?', [target.id])).length, 1);
            assert.deepEqual(JSON.parse((await db.queryDatabase('SELECT cursor_json FROM auto_watch_sources WHERE id=?', [source.id]))[0].cursor_json), { seenContentIds: ['existing'] });
        });
        await t.test('already pending boosted delivery is rechecked against fresh entitlement after downgrade before native claim', async () => {
            const owner = actor(10), target = await auto(owner, 'cadencefresh'); const source = await readySource(target); await boost(owner, target, 3);
            await store.createItemsAndDeliveries(source, [{ contentId: 'downgraded-pending', url: 'https://github.com/cadencefresh/one', discoveredAtMs: now + 1000 }], now + 1000);
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free one', slotLimit: 1, minuteLimit: 5, dayLimit: 24, priority: 0 });
            const claimed = await store.claimDueDeliveries(now + 11 * 60000, 128);
            assert.ok(!claimed.some(row => String(row.target_id) === target.id), 'downgrade restores 30-minute delivery gating before claim');
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0 });
        });
        await t.test('admin user-base interval updates retain a valid monitor three-frame divisor in target and pending schedules', async () => {
            const owner = actor(11), target = await auto(owner, 'cadencepolicy'), source = await readySource(target); await boost(owner, target, 3);
            await store.createItemsAndDeliveries(source, [{ contentId: 'policy-pending', url: 'https://github.com/cadencepolicy/one', discoveredAtMs: now + 1000 }], now + 1000);
            await require('../../src/providers/autoWatch/intervalPolicy').createPolicy(db).set(owner.userId, 60, ADMIN.userId, now + 1000);
            const row = await targetRow(target); assert.equal(Number(row.next_poll_at_ms), now + 20 * 60000, 'one-hour user base with 3 slots means 20 minutes');
            assert.equal(Number((await db.queryDatabase('SELECT next_attempt_at_ms FROM auto_watch_deliveries WHERE target_id=?', [target.id]))[0].next_attempt_at_ms), now + 20 * 60000);
        });
    } finally { paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; }); await db.close(); }
});
