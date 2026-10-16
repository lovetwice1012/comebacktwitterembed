'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createRunner } = require('../../src/automation/runtime');
const { createGraphStore } = require('../../src/automation/graph-store');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { newWorkflow } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), MINUTE = 60000;

function load(relative, mocks) {
    const filename = require.resolve(relative), actual = createRequire(filename), mod = { exports: {} };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => mocks[id] || actual(id), mod, mod.exports);
    return mod.exports;
}
function standardStore(db) {
    return load('../../src/providers/autoWatch/store', {
        '../../db': db, '../../db_schema': { ...require('../../src/db_schema'), ensureDatabaseSchema: async () => {} },
    });
}
function standardRunner(store) {
    return load('../../src/providers/autoWatch/runner', { './store': store,
        '../../errorTracking': { recordError: () => {} }, '../../recoveryBootstrap': { notificationAllowed: () => true },
    });
}
const evaluator = { evaluate: async (rule, event, _bindings, at) => evaluateWorkflow(rule, event, { now: at }) };

test('audit R1: real standard-store sequential claims retain a durable bounded handoff window', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port);
    try {
        const service = createService(db), monitors = createMonitors(db, service, {}), store = standardStore(db);
        let index = 0;
        async function fixture({ ttl = true, graph = false, cost = 3 } = {}) {
            const actor = { userId: String(222222222222229000n + BigInt(++index)) }, now = Date.now(), anchor = now - 11 * MINUTE;
            const destination = await service.saveDestination(actor, { name: 'Audit fixture DM', kind: 'dm' });
            const monitor = await monitors.save(actor, 'auto', { name: 'Audit fixture', providerId: 'github', source: 'auditburst' + index, destinationId: destination.id });
            const target = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0];
            await db.queryDatabase('UPDATE auto_watch_sources SET poll_interval_ms=?,next_check_at_ms=?,initialized_at_ms=? WHERE id=?', [30 * MINUTE, now + 3600000, anchor - 1, target.source_id]);
            await db.queryDatabase('UPDATE auto_watch_targets SET baseline_at_ms=?,last_polled_at_ms=?,next_poll_at_ms=?,last_notification_window_at_ms=?,created_at_ms=? WHERE id=?', [anchor - 1, anchor, anchor + 10 * MINUTE, anchor, anchor - 2, monitor.id]);
            if (cost !== null) await monitors.setCadence(actor, 'auto', monitor.id, { slotCost: cost, expectedRevision: 1, expectedUpdatedAtMs: null });
            const definition = newWorkflow('Audit burst rule');
            if (ttl) definition.expiresAfterMinutes = 10;
            const rule = await service.createWorkflow(actor, { definition });
            await service.activateWorkflow(actor, rule.id, { expectedRevision: 1 });
            await service.attach(actor, rule.id, 'auto', monitor.id);
            await db.queryDatabase('UPDATE auto_watch_sources SET next_check_at_ms=? WHERE id=?', [now + 3600000, target.source_id]);
            const source = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [target.source_id]))[0];
            await store.createItemsAndDeliveries(source, ['first', 'second', 'third'].map(contentId => ({ contentId, url: source.source_url + '/' + contentId, discoveredAtMs: now - 1000 })), now);
            await db.queryDatabase('UPDATE auto_watch_deliveries SET next_attempt_at_ms=? WHERE target_id=?', [now, monitor.id]);
            let at = now;
            const queue = () => createQueue(db, evaluator, { clock: () => at, ...(graph ? { graph: { enabled: true, store: createGraphStore(db) } } : {}) });
            const connect = (selectedStore = store) => { const q = queue(); selectedStore.routeAutomation = (delivery, time) => q.route('auto', delivery, time); return { runner: standardRunner(selectedStore), q }; };
            const counts = async () => ({ runs: (await db.queryDatabase("SELECT state FROM automation_runs WHERE target_kind='auto' AND target_id=?", [monitor.id])).map(row => row.state),
                deliveries: (await db.queryDatabase('SELECT status FROM auto_watch_deliveries WHERE target_id=? ORDER BY id', [monitor.id])).map(row => row.status) });
            const ownResults = async result => {
                const ids = new Set((await db.queryDatabase('SELECT id FROM auto_watch_deliveries WHERE target_id=?', [monitor.id])).map(row => String(row.id)));
                return result.deliveries.filter(row => ids.has(String(row.deliveryId)));
            };
            return { actor, monitor, source, now, anchor, queue, connect, counts, ownResults, setTime: value => { at = value; } };
        }
        for (const graph of [false, true]) await t.test(graph ? 'graph rule, three discoveries route in the first tick' : 'legacy rule, three discoveries route in the first tick', async () => {
            const f = await fixture({ graph }), { runner } = f.connect();
            const result = await runner.tick({ now: f.now, deliveryLimit: 32 });
            assert.equal(result.deliveries.filter(row => row.status === 'routed').length, 3);
            const actual = await f.counts(); assert.deepEqual(actual.deliveries, ['routed', 'routed', 'routed']);
            assert.deepEqual(actual.runs, Array(3).fill(graph ? 'flow_pending' : 'queued'));
            assert.equal((await runner.tick({ now: f.now + 1 })).deliveries.length, 0);
        });
        await t.test('restart after the first item keeps remaining TTL-valid events in that window, while a later observation waits', async () => {
            const f = await fixture(), original = f.connect();
            assert.equal((await original.runner.tick({ now: f.now, deliveryLimit: 1 })).deliveries[0].status, 'routed');
            const firstWindow = JSON.parse((await db.queryDatabase('SELECT notification_window_json FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0].notification_window_json);
            assert.equal(firstWindow.openedAtMs, f.now);
            f.setTime(f.now + MINUTE);
            const restarted = f.connect(standardStore(db));
            assert.equal((await restarted.runner.tick({ now: f.now + MINUTE, deliveryLimit: 32 })).deliveries.length, 2);
            assert.deepEqual((await f.counts()).runs, ['queued', 'queued', 'queued']);
            await store.createItemsAndDeliveries(f.source, [{ contentId: 'later', url: f.source.source_url + '/later', discoveredAtMs: f.now + MINUTE + 1 }], f.now + 2 * MINUTE);
            assert.equal((await restarted.runner.tick({ now: f.now + 10 * MINUTE - 1 })).deliveries.length, 0);
            f.setTime(f.now + 10 * MINUTE);
            assert.equal((await restarted.runner.tick({ now: f.now + 10 * MINUTE })).deliveries[0].status, 'routed');
            const nextWindow = JSON.parse((await db.queryDatabase('SELECT notification_window_json FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0].notification_window_json);
            assert.equal(nextWindow.openedAtMs, f.now + 10 * MINUTE);
            assert.equal((await f.counts()).runs.length, 4);
        });
        await t.test('ordinary one-slot legacy targets retain their entire due window without a cadence override row', async () => {
            const f = await fixture({ cost: null });
            // This legacy policy has a 30-minute base window and is due now.
            await db.queryDatabase('UPDATE auto_watch_targets SET last_notification_window_at_ms=? WHERE id=?', [f.now - 31 * MINUTE, f.monitor.id]);
            assert.equal((await f.connect().runner.tick({ now: f.now })).deliveries.length, 3);
            assert.deepEqual((await f.counts()).runs, ['queued', 'queued', 'queued']);
        });
        await t.test('cosmetic rename preserves the remaining cohort; returning cadence slots reapplies the live interval', async () => {
            const f = await fixture(), { runner } = f.connect();
            await runner.tick({ now: f.now, deliveryLimit: 1 });
            // Attaching the rule advances the monitor CAS. The editor reads
            // the current version before each distinct configuration action.
            const currentRevision = async () => Number((await db.queryDatabase("SELECT revision FROM automation_monitors WHERE target_kind='auto' AND target_id=?", [f.monitor.id]))[0].revision);
            await monitors.save(f.actor, 'auto', { name: 'Renamed without changing delivery', expectedRevision: await currentRevision() }, f.monitor.id);
            f.setTime(f.now + 1);
            assert.equal((await runner.tick({ now: f.now + 1, deliveryLimit: 1 })).deliveries[0].status, 'routed');
            const selection = (await db.queryDatabase("SELECT updated_at_ms FROM automation_monitor_cadence WHERE target_kind='auto' AND target_id=?", [f.monitor.id]))[0];
            await monitors.setCadence(f.actor, 'auto', f.monitor.id, { slotCost: 1, expectedRevision: await currentRevision(), expectedUpdatedAtMs: Number(selection.updated_at_ms) });
            assert.equal((await runner.tick({ now: f.now + MINUTE })).deliveries.length, 0);
            const pending = (await db.queryDatabase("SELECT next_attempt_at_ms FROM auto_watch_deliveries WHERE target_id=? AND status='pending'", [f.monitor.id]))[0];
            assert.equal(Number(pending.next_attempt_at_ms), f.now + 30 * MINUTE);
        });
        await t.test('corrupt receipts fail closed to the current cadence, then recover by opening a new window', async () => {
            const f = await fixture({ ttl: false }), { runner } = f.connect();
            await runner.tick({ now: f.now, deliveryLimit: 1 });
            await db.queryDatabase('UPDATE auto_watch_targets SET notification_window_json=? WHERE id=?', ['{"version":1,"policy":null}', f.monitor.id]);
            assert.equal((await runner.tick({ now: f.now + MINUTE })).deliveries.length, 0);
            f.setTime(f.now + 10 * MINUTE);
            assert.equal((await runner.tick({ now: f.now + 10 * MINUTE })).deliveries.length, 2);
            const window = JSON.parse((await db.queryDatabase('SELECT notification_window_json FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0].notification_window_json);
            assert.equal(window.openedAtMs, f.now + 10 * MINUTE);
        });
        await t.test('simultaneous standard runners claim each delivery once with bounded individual leases', async () => {
            const f = await fixture(), a = f.connect(), b = f.connect(standardStore(db));
            const results = await Promise.all([a.runner.tick({ now: f.now }), b.runner.tick({ now: f.now })]);
            assert.equal(results.flatMap(row => row.deliveries).filter(row => row.status === 'routed').length, 3);
            assert.deepEqual((await f.counts()).runs, ['queued', 'queued', 'queued']);
            assert.equal(Number((await db.queryDatabase('SELECT MAX(lease_expires_at_ms) AS n FROM auto_watch_deliveries WHERE target_id=?', [f.monitor.id]))[0].n), 0);
        });
        await t.test('failed run persistence rolls back both delivery handoff and its window receipt', async () => {
            const f = await fixture(), leased = (await store.claimDueDeliveries(f.now, 256)).find(row => String(row.target_id) === f.monitor.id);
            assert.ok(leased);
            const broken = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (sql.startsWith('INSERT INTO automation_runs')) throw new Error('fixture transaction failure');
                return query(sql, params);
            })) };
            await assert.rejects(createQueue(broken, evaluator, { clock: () => f.now }).route('auto', leased, f.now), /fixture transaction failure/);
            const target = (await db.queryDatabase('SELECT last_notification_window_at_ms,notification_window_json FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0];
            assert.equal(Number(target.last_notification_window_at_ms), f.anchor); assert.equal(target.notification_window_json, null);
            assert.equal((await db.queryDatabase('SELECT status FROM auto_watch_deliveries WHERE id=?', [leased.id]))[0].status, 'pending');
            assert.equal((await f.queue().route('auto', leased, f.now)).state, 'routed');
        });
        await t.test('a DB failure after writing the receipt rolls back the run, native status and window together', async () => {
            const f = await fixture(), leased = (await store.claimDueDeliveries(f.now, 256)).find(row => String(row.target_id) === f.monitor.id);
            const broken = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                const result = await query(sql, params);
                if (sql.startsWith('UPDATE auto_watch_targets SET last_notification_window_at_ms=')) throw new Error('fixture after receipt failure');
                return result;
            })) };
            await assert.rejects(createQueue(broken, evaluator, { clock: () => f.now }).route('auto', leased, f.now), /fixture after receipt failure/);
            const target = (await db.queryDatabase('SELECT last_notification_window_at_ms,notification_window_json FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0];
            assert.equal(Number(target.last_notification_window_at_ms), f.anchor); assert.equal(target.notification_window_json, null);
            assert.deepEqual((await f.counts()).runs, []); assert.equal((await f.counts()).deliveries[0], 'pending');
            assert.equal((await f.queue().route('auto', leased, f.now)).state, 'routed');
        });
        for (const higherIdFirst of [false, true]) await t.test(higherIdFirst
            ? 'standard runner retains a failed higher-ID earliest-due delivery in the same immutable cohort cutoff'
            : 'standard runner retries one rolled-back handoff after its backoff without another cadence wait or TTL exclusion', async () => {
            const f = await fixture(); let injected = false;
            if (higherIdFirst) {
                const latest = (await db.queryDatabase('SELECT id FROM auto_watch_deliveries WHERE target_id=? ORDER BY id DESC LIMIT 1', [f.monitor.id]))[0];
                await db.queryDatabase('UPDATE auto_watch_deliveries SET next_attempt_at_ms=?,cadence_due_at_ms=? WHERE id=?', [f.now - 1, f.now - 1, latest.id]);
            }
            const brokenOnce = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                const result = await query(sql, params);
                if (!injected && sql.startsWith('UPDATE auto_watch_targets SET last_notification_window_at_ms=') && String(params[2]) === f.monitor.id) {
                    injected = true;
                    throw Object.assign(new Error('fixture once after receipt write'), { code: 'ER_LOCK_DEADLOCK' });
                }
                return result;
            })) };
            const queue = createQueue(brokenOnce, evaluator, { clock: () => f.now });
            store.routeAutomation = (delivery, at) => queue.route('auto', delivery, at);
            const result = await standardRunner(store).tick({ now: f.now });
            assert.equal(injected, true); assert.deepEqual((await f.ownResults(result)).map(row => row.status), ['failed', 'routed', 'routed']);
            assert.deepEqual((await f.counts()).runs, ['queued', 'queued']);
            const retry = (await db.queryDatabase("SELECT * FROM auto_watch_deliveries WHERE target_id=? AND status='pending'", [f.monitor.id]))[0];
            assert.equal(Number(retry.cadence_due_at_ms), f.now - (higherIdFirst ? 1 : 0));
            assert.equal(Number(retry.next_attempt_at_ms), f.now + 30000); assert.equal(Number(retry.attempt_count), 1);
            const receipt = JSON.parse((await db.queryDatabase('SELECT notification_window_json FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0].notification_window_json);
            assert.ok(BigInt(retry.id) <= BigInt(receipt.upperDeliveryId), 'cutoff must include original due work regardless of retry backoff or ID order');
            const restarted = f.connect(standardStore(db));
            f.setTime(f.now + 29999); assert.equal((await f.ownResults(await restarted.runner.tick({ now: f.now + 29999 }))).length, 0);
            f.setTime(f.now + 30000); assert.equal((await f.ownResults(await restarted.runner.tick({ now: f.now + 30000 })))[0].status, 'routed');
            assert.deepEqual((await f.counts()).runs, ['queued', 'queued', 'queued']);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE r.target_id=?', [f.monitor.id]))[0].n), 3);
            const after = (await db.queryDatabase('SELECT cadence_due_at_ms,attempt_count FROM auto_watch_deliveries WHERE id=?', [retry.id]))[0];
            assert.equal(Number(after.cadence_due_at_ms), f.now - (higherIdFirst ? 1 : 0)); assert.equal(Number(after.attempt_count), 1);
            assert.equal(Number((await db.queryDatabase('SELECT last_notification_window_at_ms FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0].last_notification_window_at_ms), f.now);
            await store.createItemsAndDeliveries(f.source, [{ contentId: 'after-retry', url: f.source.source_url + '/after-retry', discoveredAtMs: f.now + MINUTE }], f.now + MINUTE);
            f.setTime(f.now + 10 * MINUTE - 1); assert.equal((await f.ownResults(await restarted.runner.tick({ now: f.now + 10 * MINUTE - 1 }))).length, 0);
            f.setTime(f.now + 10 * MINUTE); assert.equal((await f.ownResults(await restarted.runner.tick({ now: f.now + 10 * MINUTE })))[0].status, 'routed');
            assert.deepEqual((await f.counts()).runs, ['queued', 'queued', 'queued', 'queued']);
        });
        await t.test('a lower-ID future cohort is excluded from the earlier receipt and opens its own window when due', async () => {
            const f = await fixture({ ttl: false });
            const original = (await db.queryDatabase('SELECT id FROM auto_watch_deliveries WHERE target_id=? ORDER BY id', [f.monitor.id]))[0];
            // Seed one older-created delivery whose immutable original due time
            // is a later cohort. Its ID is below this window's upper cutoff.
            await db.queryDatabase('UPDATE auto_watch_deliveries SET next_attempt_at_ms=?,cadence_due_at_ms=? WHERE id=?', [f.now + 15 * MINUTE, f.now + 15 * MINUTE, original.id]);
            const { runner } = f.connect(); assert.equal((await f.ownResults(await runner.tick({ now: f.now }))).length, 2);
            const current = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0];
            const future = (await db.queryDatabase('SELECT * FROM auto_watch_deliveries WHERE id=?', [original.id]))[0];
            const receipt = JSON.parse(current.notification_window_json);
            assert.ok(BigInt(future.id) < BigInt(receipt.upperDeliveryId));
            assert.equal(require('../../src/automation/native-notification-window').contains(receipt, future), false);
            f.setTime(f.now + 15 * MINUTE - 1); assert.equal((await f.ownResults(await runner.tick({ now: f.now + 15 * MINUTE - 1 }))).length, 0);
            f.setTime(f.now + 15 * MINUTE); assert.equal((await f.ownResults(await runner.tick({ now: f.now + 15 * MINUTE })))[0].status, 'routed');
            assert.equal(Number((await db.queryDatabase('SELECT last_notification_window_at_ms FROM auto_watch_targets WHERE id=?', [f.monitor.id]))[0].last_notification_window_at_ms), f.now + 15 * MINUTE);
        });
        await t.test('legacy NULL due values freeze only under the winning claim and remain unchanged across failure, restart and retry', async () => {
            const f = await fixture();
            await db.queryDatabase('UPDATE auto_watch_deliveries SET cadence_due_at_ms=NULL WHERE target_id=?', [f.monitor.id]);
            const [a, b] = await Promise.all([store.claimDueDeliveries(f.now, 1), standardStore(db).claimDueDeliveries(f.now, 1)]);
            const claims = [...a, ...b].filter(row => String(row.target_id) === f.monitor.id);
            assert.equal(claims.length, 1); const leased = claims[0];
            const rows = await db.queryDatabase('SELECT id,cadence_due_at_ms FROM auto_watch_deliveries WHERE target_id=? ORDER BY id', [f.monitor.id]);
            assert.equal(Number(rows[0].cadence_due_at_ms), f.now); assert.equal(rows[1].cadence_due_at_ms, null); assert.equal(rows[2].cadence_due_at_ms, null);
            await store.failDelivery(leased, { error: Object.assign(new Error('fixture'), { code: 'ER_LOCK_DEADLOCK' }), permanent: false, nextAttemptAtMs: f.now + 30000, atMs: f.now });
            const { runner } = f.connect(standardStore(db)); assert.equal((await runner.tick({ now: f.now })).deliveries.length, 2);
            f.setTime(f.now + 30000); assert.equal((await runner.tick({ now: f.now + 30000 })).deliveries[0].status, 'routed');
            assert.deepEqual((await f.counts()).runs, ['queued', 'queued', 'queued']);
            const retained = await db.queryDatabase('SELECT cadence_due_at_ms FROM auto_watch_deliveries WHERE target_id=?', [f.monitor.id]);
            assert.ok(retained.every(row => Number(row.cadence_due_at_ms) === f.now));
        });
        await t.test('an already-held legacy lease freezes its due time inside handoff and rolls that initialization back with a failed transaction', async () => {
            const f = await fixture(), delivery = (await store.claimDueDeliveries(f.now, 256)).find(row => String(row.target_id) === f.monitor.id);
            await db.queryDatabase('UPDATE auto_watch_deliveries SET cadence_due_at_ms=NULL WHERE id=?', [delivery.id]);
            const broken = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                const result = await query(sql, params);
                if (sql.startsWith('UPDATE auto_watch_targets SET last_notification_window_at_ms=')) throw new Error('fixture rollback legacy due');
                return result;
            })) };
            const queue = createQueue(broken, evaluator, { clock: () => f.now });
            assert.equal((await queue.route('auto', { ...delivery, lease_token: 'stale-lease' }, f.now)).state, 'lease_lost');
            assert.equal((await db.queryDatabase('SELECT cadence_due_at_ms FROM auto_watch_deliveries WHERE id=?', [delivery.id]))[0].cadence_due_at_ms, null);
            await assert.rejects(queue.route('auto', delivery, f.now), /fixture rollback legacy due/);
            const unchanged = (await db.queryDatabase('SELECT cadence_due_at_ms,status,next_attempt_at_ms FROM auto_watch_deliveries WHERE id=?', [delivery.id]))[0];
            assert.equal(unchanged.cadence_due_at_ms, null); assert.equal(unchanged.status, 'pending'); assert.equal(Number(unchanged.next_attempt_at_ms), f.now);
            assert.equal((await f.queue().route('auto', delivery, f.now)).state, 'routed');
            assert.equal(Number((await db.queryDatabase('SELECT cadence_due_at_ms FROM auto_watch_deliveries WHERE id=?', [delivery.id]))[0].cadence_due_at_ms), f.now);
        });
    } finally { await db.close(); }
});

test('audit R2: real queue counts one attempt per Discord rejection and keeps unknown or partial work terminal', { skip: !port, timeout: 90000 }, async t => {
    async function fixture(t, behavior, payloadCount = 1) {
        const db = await createTestDatabase(port), actor = { userId: '222222222222229990' }, service = createService(db), monitors = createMonitors(db, service, {});
        t.after(() => db.close());
        const destination = await service.saveDestination(actor, { name: 'Retry DM', kind: 'dm' });
        const monitor = await monitors.save(actor, 'auto', { name: 'Retry', providerId: 'github', source: 'auditretry', destinationId: destination.id });
        let now = Date.now(), calls = 0;
        const target = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0];
        await db.queryDatabase('UPDATE auto_watch_sources SET poll_interval_ms=? WHERE id=?', [30 * MINUTE, target.source_id]);
        await db.queryDatabase('UPDATE auto_watch_targets SET baseline_at_ms=?,last_notification_window_at_ms=NULL WHERE id=?', [now - 3600000, monitor.id]);
        const store = standardStore(db), source = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [target.source_id]))[0];
        await store.createItemsAndDeliveries(source, [{ contentId: 'retry', url: source.source_url + '/retry', discoveredAtMs: now }], now);
        const delivery = (await store.claimDueDeliveries(now, 1))[0]; assert.ok(delivery);
        const queue = createQueue(db, evaluator, { clock: () => now });
        assert.equal((await queue.route('auto', delivery, now)).state, 'routed');
        const attemptedAt = [];
        const runner = createRunner(db, queue, { prepare: async () => ({ payloads: Array.from({ length: payloadCount }, () => ({})) }),
            sendStep: async () => { attemptedAt.push(now); return behavior(++calls); } }, {
            clock: () => now, sleep: async ms => { now += ms; }, assertAllowed: () => {}, notificationAllowed: () => true,
        });
        return { db, runner, attemptedAt, get calls() { return calls; }, setTime: at => { now = at; },
            job: async () => (await db.queryDatabase('SELECT state,attempts,due_at_ms,last_error_code,sent_steps FROM automation_jobs'))[0] };
    }
    for (const succeeds of [false, true]) await t.test(succeeds ? 'nine 429 responses then a successful tenth send' : 'ten 429 responses use all ten attempts and honor Retry-After', async t => {
        const f = await fixture(t, attempt => { if (succeeds && attempt === 10) return '444444444444444444'; throw Object.assign(new Error('fixture rejection'), { status: 429, retryAfterMs: 120000 }); });
        try {
            for (let attempt = 1; attempt <= 10; attempt++) {
                const result = await f.runner.tick(), job = await f.job();
                assert.equal(job.attempts, attempt); assert.equal(f.calls, attempt);
                assert.equal(result.state, attempt < 10 ? 'pending' : succeeds ? 'sent' : 'failed');
                if (attempt < 10) {
                    assert.equal(Number(job.due_at_ms) - f.attemptedAt.at(-1), 120000);
                    f.setTime(Number(job.due_at_ms) - 1); assert.equal((await f.runner.tick()).state, 'idle'); assert.equal(f.calls, attempt);
                    f.setTime(Number(job.due_at_ms));
                }
            }
            assert.equal((await f.runner.tick()).state, 'idle'); assert.equal(f.calls, 10);
        } finally { await f.db.close(); }
    });
    for (const partial of [false, true]) await t.test(partial ? 'confirmed first part plus known 429 never retries the batch' : 'unknown 502 outcome never automatically retries', async t => {
        const f = await fixture(t, attempt => { if (partial && attempt === 1) return '444444444444444444'; throw Object.assign(new Error('fixture private payload'), { status: partial ? 429 : 502 }); }, partial ? 2 : 1);
        try {
            const result = await f.runner.tick(), job = await f.job();
            assert.equal(result.state, partial ? 'partial' : 'unknown'); assert.equal(job.attempts, 1);
            assert.equal(job.sent_steps, partial ? 1 : 0);
            f.setTime(Number(job.due_at_ms) + 86400000); assert.equal((await f.runner.tick()).state, 'idle');
            assert.equal(f.calls, partial ? 2 : 1);
        } finally { await f.db.close(); }
    });
    await t.test('preparation failures before beginSend remain bounded and count once per failed preparation', async t => {
        const f = await fixture(t, () => assert.fail('preparation failure must not enter the wire'));
        // Use the actual queue and DB while failing only transport preparation.
        const queue = createQueue(f.db, evaluator, { clock: () => at });
        let at = Number((await f.job()).due_at_ms), prepares = 0;
        const runner = createRunner(f.db, queue, { prepare: async () => { prepares++; throw new Error('fixture preparation unavailable'); } }, {
            clock: () => at, assertAllowed: () => {}, notificationAllowed: () => true,
        });
        for (let attempt = 1; attempt <= 10; attempt++) {
            assert.equal((await runner.tick()).state, attempt < 10 ? 'pending' : 'failed');
            const job = await f.job(); assert.equal(job.attempts, attempt); at = Number(job.due_at_ms) + 1;
        }
        assert.equal(prepares, 10); assert.equal(f.calls, 0); assert.equal((await runner.tick()).state, 'idle');
    });
});

test('audit R6: Discord list exposes each owner cadence separately from shared acquisition timestamps', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,last_checked_at_ms,next_check_at_ms,created_at_ms) VALUES ('github','auditcadence','https://github.com/auditcadence',21600000,1000000,1300000,0)");
        const source = (await db.queryDatabase('SELECT id FROM auto_watch_sources'))[0].id;
        const store = standardStore(db), watchLine = require('../../src/commands/handlers/autoextract/list')._internal.watchLine;
        for (const [user, last, next] of [['222222222222229991', 900000, 2700000], ['222222222222229992', 1100000, 1400000]]) {
            await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms) VALUES (?,0)', [user]);
            await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_type,destination_key,last_polled_at_ms,next_poll_at_ms,created_at_ms) VALUES (?,?,'dm',?,?,?,0)", [user, source, 'dm:' + user, last, next]);
            const [row] = await store.listTargets(user);
            assert.equal(row.lastCheckedAtMs, last); assert.equal(row.nextCheckAtMs, next);
            assert.equal(row.sourceLastCheckedAtMs, 1000000); assert.equal(row.sourceNextCheckAtMs, 1300000);
            for (const ja of [true, false]) {
                const line = watchLine(row, ja); assert.ok(line.includes(`<t:${last / 1000}:R>`)); assert.ok(line.includes(`<t:${next / 1000}:R>`));
                assert.ok(!line.includes('<t:1300:R>'));
            }
        }
    } finally { await db.close(); }
});

test('audit R1 additive migration is idempotent and preserves existing targets and receipts', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        await db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES ('github','migrationfixture','https://github.com/migrationfixture',1800000,0,0)");
        const source = (await db.queryDatabase('SELECT id FROM auto_watch_sources'))[0].id;
        await db.queryDatabase("INSERT INTO users (user_id,registered_at_ms) VALUES ('222222222222229999',0)");
        await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_type,destination_key,created_at_ms,last_notification_window_at_ms) VALUES ('222222222222229999',?,'dm','dm:fixture',123,456)", [source]);
        const targetId = (await db.queryDatabase('SELECT id FROM auto_watch_targets'))[0].id;
        const item = await db.queryDatabase("INSERT INTO auto_watch_items (source_id,content_key,content_url,discovered_at_ms) VALUES (?,'legacy-delivery','https://github.com/migrationfixture/legacy',456)", [source]);
        await db.queryDatabase("INSERT INTO auto_watch_deliveries (item_id,target_id,next_attempt_at_ms,cadence_due_at_ms) VALUES (?,?,789,789)", [item.insertId, targetId]);
        await db.queryDatabase('ALTER TABLE auto_watch_targets DROP COLUMN notification_window_json');
        await db.queryDatabase('ALTER TABLE auto_watch_deliveries DROP COLUMN cadence_due_at_ms');
        const { splitSqlStatements, shouldSkipMigrationStatement } = require('../../src/db_schema')._internal;
        const migration = readFileSync(require('node:path').resolve(__dirname, '../../migrations/20261016_add_auto_watch_notification_window.sql'), 'utf8');
        // An interrupted deployment can have applied the first additive ALTER
        // without the second one or the migration ledger entry yet.
        await db.queryDatabase(splitSqlStatements(migration)[0]);
        for (let pass = 0; pass < 2; pass++) for (const sql of splitSqlStatements(migration)) if (!await shouldSkipMigrationStatement(db.queryDatabase, sql)) await db.queryDatabase(sql);
        const target = (await db.queryDatabase('SELECT created_at_ms,last_notification_window_at_ms,notification_window_json FROM auto_watch_targets'))[0];
        assert.equal(Number(target.created_at_ms), 123); assert.equal(Number(target.last_notification_window_at_ms), 456); assert.equal(target.notification_window_json, null);
        const legacy = (await db.queryDatabase('SELECT next_attempt_at_ms,cadence_due_at_ms FROM auto_watch_deliveries'))[0];
        assert.equal(Number(legacy.next_attempt_at_ms), 789); assert.equal(legacy.cadence_due_at_ms, null, 'old due times are not reconstructed by migration');
        const receipt = '{"version":1}'; await db.queryDatabase('UPDATE auto_watch_targets SET notification_window_json=?', [receipt]);
        for (const sql of splitSqlStatements(migration)) assert.equal(await shouldSkipMigrationStatement(db.queryDatabase, sql), true);
        assert.equal((await db.queryDatabase('SELECT notification_window_json FROM auto_watch_targets'))[0].notification_window_json, receipt);
        await db.queryDatabase('UPDATE auto_watch_deliveries SET cadence_due_at_ms=789,next_attempt_at_ms=999');
        for (const sql of splitSqlStatements(migration)) assert.equal(await shouldSkipMigrationStatement(db.queryDatabase, sql), true);
        assert.equal(Number((await db.queryDatabase('SELECT cadence_due_at_ms FROM auto_watch_deliveries'))[0].cadence_due_at_ms), 789);
    } finally { await db.close(); }
});

test('native window receipts reject malformed policy, anchors and IDs and preserve 64-bit delivery IDs', () => {
    const { readWindow, contains, createWindow } = require('../../src/automation/native-notification-window');
    const cadence = { updatedAtMs: 500, effectiveSlotCost: 3, intervalMs: 600000, baseIntervalMs: 1800000 };
    const window = createWindow(cadence, '18446744073709551614', 1000);
    const target = { last_notification_window_at_ms: 1000, notification_window_json: JSON.stringify(window) };
    assert.deepEqual(readWindow(target, cadence, 1000), window);
    assert.equal(contains(window, { id: '18446744073709551613', next_attempt_at_ms: 1000 }), true);
    assert.equal(contains(window, { id: '18446744073709551615', next_attempt_at_ms: 1000 }), false);
    assert.equal(contains(window, { id: '1', next_attempt_at_ms: 1001 }), false);
    assert.equal(contains(window, { id: '1', cadence_due_at_ms: 1000, next_attempt_at_ms: 130000 }), true, 'a retry keeps its original cohort');
    assert.equal(contains(window, { id: '1', cadence_due_at_ms: 1001, next_attempt_at_ms: 999 }), false, 'a future cohort cannot join through an earlier mutable retry time');
    for (const cadence_due_at_ms of [-1, NaN, 0.5]) assert.equal(contains(window, { id: '1', cadence_due_at_ms, next_attempt_at_ms: 999 }), false);
    for (const raw of [null, '', '{broken', '{}', 'null', '[]', JSON.stringify({ ...window, version: 2 }), JSON.stringify({ ...window, upperDeliveryId: '-1' }), JSON.stringify({ ...window, policy: null })]) {
        assert.equal(readWindow({ ...target, notification_window_json: raw }, cadence, 1000), null);
    }
    assert.equal(readWindow(target, { ...cadence, effectiveSlotCost: 1 }, 1000), null);
    assert.equal(readWindow(target, { ...cadence, updatedAtMs: 501 }, 1000), null);
    assert.equal(readWindow({ ...target, last_notification_window_at_ms: 999 }, cadence, 1000), null);
    assert.equal(readWindow(target, cadence, 999), null);
});
