'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const { newWorkflow } = require('../../src/automation/schema');
const { evaluateWorkflow } = require('../../src/automation/engine');
const entitlements = require('../../src/automation/entitlements');
const billing = require('../../src/automation/square-billing');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), MINUTE = 60000, DAY = 86400000;
const ADMIN = { userId: '444444444444444444', isAdmin: true };
const actor = i => ({ userId: String(222222222222224000n + BigInt(i)), guildId: '111111111111111111', canView: true, canEdit: true });

test('SQL cadence handoff retains leased events after grant changes and shares source-first locks with completion', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), transaction = db.withDatabaseTransaction, originalScope = billing.getSquareScope;
    let queryHook = (query, sql, params) => query(sql, params);
    db.withDatabaseTransaction = work => transaction(query => work((sql, params = []) => queryHook(query, sql, params)));
    const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/autoWatch/store'), require.resolve('../../src/providers/priceWatch/store')];
    const originals = paths.map(path => require.cache[path]);
    try {
        const schema = require('../../src/db_schema');
        require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { ...db, ensureUserExistsInDatabase: userId => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [userId]) } };
        require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: { ...schema, ensureDatabaseSchema: async () => {} } };
        delete require.cache[paths[2]]; delete require.cache[paths[3]];
        const store = require(paths[2]), service = createService(db, { rateLimiter: createRateLimiter(db, { policy: { operations: { monitor: { minute: 1000, hour: 10000 }, write: { minute: 1000, hour: 10000 } } } }) });
        const monitors = createMonitors(db, service, {});
        async function fixture(index) {
            const owner = actor(index), destination = await service.saveDestination(owner, { name: 'cadence lifecycle DM', kind: 'dm' });
            const target = await monitors.save(owner, 'auto', { name: 'cadence lifecycle', providerId: 'github', source: 'cadencelifecycle' + index, destinationId: destination.id });
            const row = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [target.id]))[0], anchor = Date.now();
            await db.queryDatabase('UPDATE auto_watch_sources SET poll_interval_ms=?,last_checked_at_ms=?,next_check_at_ms=?,initialized_at_ms=?,cursor_json=? WHERE id=?', [30 * MINUTE, anchor, anchor, anchor - 1, '{"seenContentIds":["preserved"]}', row.source_id]);
            await db.queryDatabase('UPDATE auto_watch_targets SET baseline_at_ms=?,last_polled_at_ms=?,next_poll_at_ms=?,last_notification_window_at_ms=?,created_at_ms=? WHERE id=?', [anchor - 1, anchor, anchor + 30 * MINUTE, anchor, anchor - 2, target.id]);
            return { owner, target, anchor, source: (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [row.source_id]))[0] };
        }
        async function select(f, cost) {
            const current = (await db.queryDatabase("SELECT updated_at_ms FROM automation_monitor_cadence WHERE target_kind='auto' AND target_id=?", [f.target.id]))[0];
            return monitors.setCadence(f.owner, 'auto', f.target.id, { slotCost: cost, expectedRevision: 1, expectedUpdatedAtMs: current ? Number(current.updated_at_ms) : null });
        }
        async function claim(f, at) { return (await store.claimDueDeliveries(at, 256)).find(row => String(row.target_id) === f.target.id); }
        async function counts(f) {
            const params = [f.target.id];
            return {
                runs: Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_runs WHERE target_kind='auto' AND target_id=?", params))[0].n),
                jobs: Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE r.target_kind='auto' AND r.target_id=?", params))[0].n),
                flows: Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_flow_runs f JOIN automation_runs r ON r.id=f.run_id WHERE r.target_kind='auto' AND r.target_id=?", params))[0].n),
            };
        }
        async function handoffCase(index, change, useGraph = false, prepare = async () => {}) {
            const f = await fixture(index); await prepare(f); await select(f, 3);
            const definition = newWorkflow('cadence preserved rule'), workflow = await service.createWorkflow(f.owner, { definition });
            await service.activateWorkflow(f.owner, workflow.id, { expectedRevision: 1 }); await service.attach(f.owner, workflow.id, 'auto', f.target.id);
            const discoveredAtMs = f.anchor + 1000, contentId = randomUUID(), title = 'original event ' + index;
            await store.createItemsAndDeliveries(f.source, [{ contentId, url: 'https://github.com/' + f.source.source_key + '/one', title, discoveredAtMs }], f.anchor + 11 * MINUTE);
            const leased = await claim(f, f.anchor + 11 * MINUTE); assert.ok(leased);
            let handoffAt = f.anchor + 11 * MINUTE + 2;
            await change(f);
            const graphStore = createGraphStore(db);
            const queue = createQueue(db, { evaluate: async (rule, event, _bindings, at) => evaluateWorkflow(rule, event, { now: at }) }, { clock: () => handoffAt, ...(useGraph ? { graph: { enabled: true, store: graphStore } } : {}) });
            const waiting = await queue.route('auto', leased, handoffAt);
            assert.deepEqual(waiting, { state: 'pending', code: 'MONITOR_CADENCE_WAIT', dueAtMs: f.anchor + 30 * MINUTE });
            assert.deepEqual(await counts(f), { runs: 0, jobs: 0, flows: 0 });
            const retained = (await db.queryDatabase('SELECT * FROM auto_watch_deliveries WHERE id=?', [leased.id]))[0];
            assert.equal(retained.status, 'pending'); assert.equal(retained.lease_token, null); assert.equal(Number(retained.attempt_count), 0);
            assert.equal(Number(retained.next_attempt_at_ms), f.anchor + 30 * MINUTE);
            assert.equal(Number((await db.queryDatabase('SELECT last_notification_window_at_ms FROM auto_watch_targets WHERE id=?', [f.target.id]))[0].last_notification_window_at_ms), f.anchor);
            assert.equal((await db.queryDatabase("SELECT workflow_id FROM automation_assignments WHERE target_kind='auto' AND target_id=?", [f.target.id]))[0].workflow_id, workflow.id);
            assert.equal(await claim(f, f.anchor + 30 * MINUTE - 1), undefined);
            handoffAt = f.anchor + 30 * MINUTE;
            const due = await claim(f, handoffAt); assert.ok(due);
            const routed = await queue.route('auto', due, handoffAt); assert.equal(routed.state, 'routed');
            assert.deepEqual(await counts(f), { runs: 1, jobs: useGraph ? 0 : 1, flows: useGraph ? 1 : 0 });
            const run = (await db.queryDatabase('SELECT * FROM automation_runs WHERE id=?', [routed.runId]))[0], event = JSON.parse(run.event_json);
            assert.equal(run.workflow_id, workflow.id); assert.equal(Number(run.revision), 1); assert.equal(event.contentId, contentId); assert.equal(event.title, title); assert.equal(event.observedAtMs, discoveredAtMs);
            assert.equal((await queue.route('auto', due, handoffAt)).state, 'lease_lost');
            assert.equal((await counts(f)).runs, 1);
            if (useGraph) {
                const step = (await db.queryDatabase("SELECT s.input_unit_id FROM automation_flow_steps s JOIN automation_flow_members m ON m.unit_id=s.input_unit_id WHERE m.run_id=? AND s.node_id='start'", [routed.runId]))[0];
                assert.equal((await graphStore.readUnit(step.input_unit_id)).members[0].event.contentId, contentId);
            }
        }
        await t.test('returning three slots to one after claim postpones the legacy event until exactly thirty minutes', () => handoffCase(1, f => select(f, 1)));
        await t.test('returning frames after claim does not create a graph run or lose its event and rule', () => handoffCase(2, f => select(f, 1), true));

        await t.test('paid downgrade after claim restores the base interval at native handoff', async () => {
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free one', slotLimit: 1, minuteLimit: 5, dayLimit: 24, priority: 0 });
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'cadence-lifecycle-paid', label: 'Cadence lifecycle paid', slotLimit: 3, minuteLimit: 10, dayLimit: 90, priority: 1 });
            try { await handoffCase(3, f => db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, f.owner.userId, null)), false, f => db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, f.owner.userId, 'cadence-lifecycle-paid'))); }
            finally { await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0 }); }
        });
        await t.test('local verified unit expiry and refund after claim retain the event without the old divisor', async () => {
            billing.getSquareScope = () => ({ configured: true, environment: 'sandbox', merchantId: 'CADENCE-MERCHANT' });
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free one', slotLimit: 1, minuteLimit: 5, dayLimit: 24, priority: 0 });
            await db.queryDatabase("INSERT INTO automation_square_donation_policy (environment,merchant_id,enabled,currency,validity_days,updated_at_ms,actor_user_id) VALUES ('sandbox','CADENCE-MERCHANT',1,'JPY',1,1,?)", [ADMIN.userId]);
            await db.queryDatabase("INSERT INTO automation_square_donation_units_policy (environment,merchant_id,unit_amount,slots_per_unit,policy_updated_at_ms) VALUES ('sandbox','CADENCE-MERCHANT',1000,2,1)");
            const seed = (f, completedAt = f.anchor - DAY + 11 * MINUTE + 1) => db.queryDatabase(`INSERT INTO automation_square_donation_attempts (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,payment_id,verified,completed_at_ms,expires_at_ms,created_at_ms,updated_at_ms)
                VALUES (?,?,'sandbox','CADENCE-MERCHANT','LOCATION','APP',1000,'JPY','fixture@example.com','fixture',1,'COMPLETED',?,1,?,?,?,?)`, [randomUUID(), f.owner.userId, 'PAYMENT-' + f.target.id, completedAt, f.anchor + DAY, completedAt, f.anchor]);
            try {
                await handoffCase(4, async () => {}, true, seed);
                await handoffCase(5, f => db.withDatabaseTransaction(async query => { await entitlements.lockOwner(query, f.owner.userId); await query('UPDATE automation_square_donation_attempts SET refunded_amount=amount WHERE owner_user_id=?', [f.owner.userId]); }), false, f => seed(f, f.anchor - MINUTE));
            } finally {
                billing.getSquareScope = originalScope;
                await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0 });
            }
        });
        await t.test('source completion and cadence edits wait on the source before acquiring the target', async () => {
            const f = await fixture(6), token = randomUUID();
            await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', [token, Date.now() + 120000, f.source.id]);
            Object.assign(f.source, { lease_token: token });
            let announceSource, announceEdit, releaseSource;
            const sourceLocked = new Promise(resolve => { announceSource = resolve; }), editQueued = new Promise(resolve => { announceEdit = resolve; }), sourceMayContinue = new Promise(resolve => { releaseSource = resolve; });
            queryHook = async (query, sql, params) => {
                if (sql === 'SELECT id FROM auto_watch_sources WHERE id=? AND lease_token=? FOR UPDATE') { const row = await query(sql, params); announceSource(); await sourceMayContinue; return row; }
                if (sql === 'SELECT id,poll_interval_ms FROM auto_watch_sources WHERE id=? FOR UPDATE') announceEdit('source');
                else if (sql.startsWith('SELECT t.*,s.provider_id') && sql.endsWith(' FOR UPDATE')) announceEdit('target');
                return query(sql, params);
            };
            const completion = store.completeSource(f.source, { state: { fresh: true }, cursor: { seenContentIds: ['completed'] }, initializedAtMs: f.anchor, nextCheckAtMs: f.anchor + 30 * MINUTE, checkedAtMs: f.anchor, items: [] });
            await sourceLocked;
            const edit = select(f, 3);
            let lockError;
            try {
                assert.equal(await editQueued, 'source', 'cadence must queue behind the source before locking the target');
                await db.withDatabaseTransaction(query => query('SELECT id FROM auto_watch_targets WHERE id=? FOR UPDATE NOWAIT', [f.target.id]));
            } catch (error) { lockError = error; }
            finally { releaseSource(); }
            const results = await Promise.allSettled([completion, edit]);
            queryHook = (query, sql, params) => query(sql, params);
            if (lockError) throw lockError;
            assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
            const source = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [f.source.id]))[0];
            assert.equal(Number(source.failure_count), 0); assert.equal(Number(source.last_checked_at_ms), f.anchor);
            assert.deepEqual(JSON.parse(source.cursor_json), { seenContentIds: ['completed'] });
            assert.equal(Number(source.next_check_at_ms), f.anchor + 10 * MINUTE);
        });
        await t.test('native handoff also waits behind successful source completion without taking its target lock', async () => {
            const f = await fixture(7); await select(f, 3);
            const at = f.anchor + 11 * MINUTE;
            await store.createItemsAndDeliveries(f.source, [{ contentId: 'concurrent-handoff', url: 'https://github.com/' + f.source.source_key + '/one', discoveredAtMs: f.anchor + 1 }], at);
            const delivery = await claim(f, at); assert.ok(delivery);
            const token = randomUUID();
            await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', [token, Date.now() + 120000, f.source.id]);
            Object.assign(f.source, { lease_token: token });
            let announceSource, announceHandoff, releaseSource;
            const sourceLocked = new Promise(resolve => { announceSource = resolve; }), handoffQueued = new Promise(resolve => { announceHandoff = resolve; }), sourceMayContinue = new Promise(resolve => { releaseSource = resolve; });
            queryHook = async (query, sql, params) => {
                if (sql === 'SELECT id FROM auto_watch_sources WHERE id=? AND lease_token=? FOR UPDATE') { const row = await query(sql, params); announceSource(); await sourceMayContinue; return row; }
                if (sql === 'SELECT id,poll_interval_ms FROM auto_watch_sources WHERE id=? FOR UPDATE') announceHandoff('source');
                else if (sql.startsWith('SELECT t.*,m.scope') && sql.endsWith(' FOR UPDATE')) announceHandoff('target');
                return query(sql, params);
            };
            const completion = store.completeSource(f.source, { state: { fresh: true }, cursor: { seenContentIds: ['concurrent-handoff'] }, initializedAtMs: f.anchor, nextCheckAtMs: at + 10 * MINUTE, checkedAtMs: at, items: [] });
            await sourceLocked;
            const queue = createQueue(db, {}, { clock: () => at }), handoff = queue.route('auto', delivery, at);
            let lockError;
            try {
                assert.equal(await handoffQueued, 'source', 'handoff must queue behind the source before locking the target');
                await db.withDatabaseTransaction(query => query('SELECT id FROM auto_watch_targets WHERE id=? FOR UPDATE NOWAIT', [f.target.id]));
            } catch (error) { lockError = error; }
            finally { releaseSource(); }
            const results = await Promise.allSettled([completion, handoff]);
            queryHook = (query, sql, params) => query(sql, params);
            if (lockError) throw lockError;
            assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
            assert.equal(results[1].value.state, 'routed'); assert.equal((await counts(f)).runs, 1);
            const source = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [f.source.id]))[0];
            assert.equal(Number(source.failure_count), 0); assert.equal(Number(source.last_checked_at_ms), at);
            assert.deepEqual(JSON.parse(source.cursor_json), { seenContentIds: ['concurrent-handoff'] });
        });
        await t.test('pause, remove and native deletion queue behind source completion without first locking its target', async t => {
            for (const [index, operation] of [[8, 'pause'], [9, 'remove'], [10, 'nativeDelete'], [11, 'detach'], [12, 'resume'], [13, 'fullSave']]) await t.test(operation, async () => {
                const f = await fixture(index), token = randomUUID();
                if (operation === 'resume') await monitors.save(f.owner, 'auto', { expectedRevision: 1, enabled: false }, f.target.id);
                await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', [token, Date.now() + 120000, f.source.id]); Object.assign(f.source, { lease_token: token });
                let announceSource, announceMutation, releaseSource;
                const sourceLocked = new Promise(resolve => { announceSource = resolve; }), mutationQueued = new Promise(resolve => { announceMutation = resolve; }), sourceMayContinue = new Promise(resolve => { releaseSource = resolve; });
                queryHook = async (query, sql, params) => {
                    if (sql === 'SELECT id FROM auto_watch_sources WHERE id=? AND lease_token=? FOR UPDATE') { const row = await query(sql, params); announceSource(); await sourceMayContinue; return row; }
                    if (sql === 'SELECT id,poll_interval_ms FROM auto_watch_sources WHERE id=? FOR UPDATE' || sql === 'SELECT id FROM auto_watch_sources WHERE id=? FOR UPDATE') announceMutation('source');
                    else if (sql.startsWith('SELECT t.*,s.provider_id') && sql.endsWith(' FOR UPDATE') || sql.startsWith('DELETE FROM auto_watch_targets')) announceMutation('target');
                    return query(sql, params);
                };
                const completion = store.completeSource(f.source, { state: { fresh: true }, cursor: { seenContentIds: ['completed-' + operation] }, initializedAtMs: f.anchor, nextCheckAtMs: f.anchor + 30 * MINUTE, checkedAtMs: f.anchor, items: [] });
                await sourceLocked;
                const mutation = operation === 'pause' ? monitors.save(f.owner, 'auto', { expectedRevision: 1, enabled: false }, f.target.id)
                    : operation === 'remove' ? monitors.remove(f.owner, 'auto', f.target.id, 1)
                    : operation === 'nativeDelete' ? store.deleteTarget(f.owner.userId, f.target.id)
                    : operation === 'detach' ? monitors.detach(f.owner, 'auto', f.target.id, 1)
                    : operation === 'resume' ? monitors.save(f.owner, 'auto', { expectedRevision: 2, enabled: true }, f.target.id)
                    : monitors.save(f.owner, 'auto', { expectedRevision: 1, destinationId: (await db.queryDatabase("SELECT destination_id FROM automation_monitors WHERE target_kind='auto' AND target_id=?", [f.target.id]))[0].destination_id, name: 'updated full monitor' }, f.target.id);
                let lockError;
                try {
                    assert.equal(await mutationQueued, 'source', operation + ' must wait for the source before locking the target');
                    await db.withDatabaseTransaction(query => query('SELECT id FROM auto_watch_targets WHERE id=? FOR UPDATE NOWAIT', [f.target.id]));
                } catch (error) { lockError = error; }
                finally { releaseSource(); }
                const results = await Promise.allSettled([completion, mutation]); queryHook = (query, sql, params) => query(sql, params);
                if (lockError) throw lockError;
                assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
                const target = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [f.target.id]))[0];
                if (['remove','nativeDelete'].includes(operation)) {
                    assert.equal(target, undefined);
                    assert.equal((await db.queryDatabase("SELECT * FROM automation_notification_slots WHERE owner_user_id=? AND target_kind='auto' AND target_id=?", [f.owner.userId, f.target.id])).length, 0);
                } else if (operation === 'pause') assert.equal(Number(target.enabled), 0);
                else if (operation === 'resume') assert.equal(Number(target.enabled), 1);
                else if (operation === 'fullSave') assert.equal(Number((await db.queryDatabase("SELECT revision FROM automation_monitors WHERE target_kind='auto' AND target_id=?", [f.target.id]))[0].revision), 2);
                if (operation !== 'nativeDelete') {
                    const source = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [f.source.id]))[0];
                    assert.equal(Number(source.failure_count), 0); assert.equal(Number(source.last_checked_at_ms), f.anchor);
                    assert.deepEqual(JSON.parse(source.cursor_json), { seenContentIds: ['completed-' + operation] });
                }
            });
        });
        await t.test('one stable native admission window routes all leased discoveries for legacy and graph rules, while later claims retain cadence', async t => {
            for (const [index, useGraph] of [[14, false], [15, true]]) await t.test(useGraph ? 'graph' : 'legacy', async () => {
                const f = await fixture(index); await select(f, 3);
                const definition = newWorkflow('batch preserved rule'), workflow = await service.createWorkflow(f.owner, { definition });
                await service.activateWorkflow(f.owner, workflow.id, { expectedRevision: 1 }); await service.attach(f.owner, workflow.id, 'auto', f.target.id);
                let at = f.anchor + 11 * MINUTE;
                await store.createItemsAndDeliveries(f.source, ['first','second'].map(key => ({ contentId: 'batch-' + key, title: key, url: 'https://github.com/' + f.source.source_key + '/' + key, discoveredAtMs: f.anchor + 1000 })), at);
                const deliveries = (await store.claimDueDeliveries(at, 256)).filter(row => String(row.target_id) === f.target.id); assert.equal(deliveries.length, 2);
                const queue = createQueue(db, { evaluate: async (rule, event, _bindings, now) => evaluateWorkflow(rule, event, { now }) }, { clock: () => at, ...(useGraph ? { graph: { enabled: true, store: createGraphStore(db) } } : {}) });
                assert.equal((await queue.route('auto', deliveries[0], at)).state, 'routed'); assert.equal((await queue.route('auto', deliveries[1], at)).state, 'routed');
                assert.deepEqual(await counts(f), { runs: 2, jobs: useGraph ? 0 : 2, flows: useGraph ? 2 : 0 });
                assert.equal((await queue.route('auto', deliveries[1], at)).state, 'lease_lost');
                await store.createItemsAndDeliveries(f.source, [{ contentId: 'batch-later', url: 'https://github.com/' + f.source.source_key + '/later', discoveredAtMs: at + 1000 }], at + MINUTE);
                assert.equal(await claim(f, at + 10 * MINUTE - 1), undefined);
                at += 10 * MINUTE; const later = await claim(f, at); assert.ok(later);
                const restarted = createQueue(db, { evaluate: async (rule, event, _bindings, now) => evaluateWorkflow(rule, event, { now }) }, { clock: () => at, ...(useGraph ? { graph: { enabled: true, store: createGraphStore(db) } } : {}) });
                assert.equal((await restarted.route('auto', later, at)).state, 'routed'); assert.equal((await restarted.route('auto', later, at)).state, 'lease_lost');
                assert.equal((await counts(f)).runs, 3);
            });
        });
        await t.test('a cadence reset after the first batch item rejects the old admission snapshot for remaining items', async () => {
            const f = await fixture(16); await select(f, 3); let at = f.anchor + 11 * MINUTE;
            await store.createItemsAndDeliveries(f.source, ['first','second'].map(key => ({ contentId: 'reset-' + key, url: 'https://github.com/' + f.source.source_key + '/' + key, discoveredAtMs: f.anchor + 1000 })), at);
            const deliveries = (await store.claimDueDeliveries(at, 256)).filter(row => String(row.target_id) === f.target.id); assert.equal(deliveries.length, 2);
            const queue = createQueue(db, {}, { clock: () => at }); assert.equal((await queue.route('auto', deliveries[0], at)).state, 'routed');
            await select(f, 1);
            assert.deepEqual(await queue.route('auto', deliveries[1], at), { state: 'pending', code: 'MONITOR_CADENCE_WAIT', dueAtMs: at + 30 * MINUTE });
            assert.equal((await counts(f)).runs, 1); assert.equal(await claim(f, at + 30 * MINUTE - 1), undefined);
            at += 30 * MINUTE; const remaining = await claim(f, at); assert.ok(remaining);
            assert.equal((await createQueue(db, {}, { clock: () => at }).route('auto', remaining, at)).state, 'routed'); assert.equal((await counts(f)).runs, 2);
        });
        await t.test('a restart after one batch item reclaims the remainder in the persisted current window', async () => {
            const f = await fixture(17); await select(f, 3); let at = f.anchor + 11 * MINUTE;
            await store.createItemsAndDeliveries(f.source, ['first','second'].map(key => ({ contentId: 'restart-' + key, url: 'https://github.com/' + f.source.source_key + '/' + key, discoveredAtMs: f.anchor + 1000 })), at);
            const deliveries = (await store.claimDueDeliveries(at, 256)).filter(row => String(row.target_id) === f.target.id); assert.equal(deliveries.length, 2);
            const queue = createQueue(db, {}, { clock: () => at }); assert.equal((await queue.route('auto', deliveries[0], at)).state, 'routed');
            at += 3 * MINUTE;
            const reclaimed = await claim(f, at); assert.ok(reclaimed); assert.notEqual(reclaimed.lease_token, deliveries[1].lease_token);
            assert.equal((await queue.route('auto', deliveries[1], at)).state, 'lease_lost');
            assert.equal((await createQueue(db, {}, { clock: () => at }).route('auto', reclaimed, at)).state, 'routed'); assert.equal((await counts(f)).runs, 2);
        });
        await t.test('expiry, refund and administrator downgrade between batch items reapply the live base interval', async t => {
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free one', slotLimit: 1, minuteLimit: 5, dayLimit: 24, priority: 0 });
            await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'cadence-batch-paid', label: 'Batch paid', slotLimit: 3, minuteLimit: 10, dayLimit: 90, priority: 1 });
            try {
                for (const [index, operation] of [[18, 'expiry'], [19, 'refund'], [20, 'downgrade']]) await t.test(operation, async () => {
                    billing.getSquareScope = operation === 'downgrade' ? originalScope : () => ({ configured: true, environment: 'sandbox', merchantId: 'CADENCE-MERCHANT' });
                    const f = await fixture(index);
                    if (operation === 'downgrade') await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, f.owner.userId, 'cadence-batch-paid'));
                    else {
                        const completed = operation === 'expiry' ? f.anchor - DAY + 11 * MINUTE + 1 : f.anchor - MINUTE;
                        await db.queryDatabase(`INSERT INTO automation_square_donation_attempts (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,payment_id,verified,completed_at_ms,expires_at_ms,created_at_ms,updated_at_ms)
                            VALUES (?,?,'sandbox','CADENCE-MERCHANT','LOCATION','APP',1000,'JPY','fixture@example.com','fixture',1,'COMPLETED',?,1,?,?,?,?)`, [randomUUID(), f.owner.userId, 'PAYMENT-BATCH-' + f.target.id, completed, f.anchor + DAY, completed, f.anchor]);
                    }
                    await select(f, 3); let at = f.anchor + 11 * MINUTE;
                    await store.createItemsAndDeliveries(f.source, ['first','second'].map(key => ({ contentId: operation + '-' + key, url: 'https://github.com/' + f.source.source_key + '/' + key, discoveredAtMs: f.anchor + 1000 })), at);
                    const deliveries = (await store.claimDueDeliveries(at, 256)).filter(row => String(row.target_id) === f.target.id); assert.equal(deliveries.length, 2);
                    const queue = createQueue(db, {}, { clock: () => at }); assert.equal((await queue.route('auto', deliveries[0], at)).state, 'routed');
                    if (operation === 'downgrade') await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, ADMIN, f.owner.userId, null));
                    else if (operation === 'refund') await db.withDatabaseTransaction(async query => { await entitlements.lockOwner(query, f.owner.userId); await query('UPDATE automation_square_donation_attempts SET refunded_amount=amount WHERE owner_user_id=?', [f.owner.userId]); });
                    at += 2;
                    assert.deepEqual(await queue.route('auto', deliveries[1], at), { state: 'pending', code: 'MONITOR_CADENCE_WAIT', dueAtMs: f.anchor + 41 * MINUTE });
                    assert.equal((await counts(f)).runs, 1);
                });
            } finally {
                billing.getSquareScope = originalScope;
                await entitlements.savePlanPolicy(db.queryDatabase, ADMIN, { planId: 'free', label: 'Free', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0 });
            }
        });
    } finally {
        billing.getSquareScope = originalScope;
        paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; });
        await db.close();
    }
});
