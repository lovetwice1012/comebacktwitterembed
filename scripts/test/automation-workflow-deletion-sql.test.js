'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { newWorkflow } = require('../../src/automation/schema');
const { createQueue } = require('../../src/automation/queue');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createEvaluator } = require('../../src/automation/evaluation');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), U = '222222222222222222', V = '333333333333333333', G = '111111111111111111';
const actor = { userId: U };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(work) {
    const db = await createTestDatabase(port); let evaluator, flow;
    try {
        const query = db.queryDatabase, service = createService(db), monitors = createMonitors(db, service, {});
        await grantTestDonor(db, U); await query('UPDATE users SET additional_auto_extract_slots=2 WHERE user_id=?', [U]);
        const destination = await service.saveDestination(actor, { name: 'DM destination', kind: 'dm' });
        const workflow = await service.createWorkflow(actor, { definition: newWorkflow('delete lifecycle') }); await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 });
        const auto = await monitors.save(actor, 'auto', { name: 'new posts', providerId: 'github', source: 'octocat', destinationId: destination.id });
        const price = await monitors.save(actor, 'price', { name: 'price changes', providerId: 'steam', source: 'https://store.steampowered.com/app/730', mode: 'change', destinationId: destination.id });
        await service.attach(actor, workflow.id, 'auto', auto.id); await service.attach(actor, workflow.id, 'price', price.id);
        const quota = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' });
        const x = await quota.register(actor, { accountHandle: 'fixture', name: 'X watch', notificationSettings: { workflowId: workflow.id, destinationId: destination.id }, processingMode: 'batch' });
        const store = createGraphStore(db); evaluator = createEvaluator(service.dictionaryData);
        const queue = createQueue(db, evaluator, { graph: { enabled: true, store } }); flow = createFlowRuntime(db, evaluator, store, { assertEnabled: () => {} });
        async function input(kind, target, title) {
            const token = randomUUID(), now = Date.now();
            if (kind === 'price') {
                const event = { providerId: 'steam', kind: 'price', title, observedAtMs: now, url: 'https://store.steampowered.com/app/730' };
                const delivery = await query("INSERT INTO price_watch_deliveries (target_id,event_key,message_text,event_json,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,?,?,'pending',?,?,?)", [target.id, hash(title), title, JSON.stringify(event), now, token, now + 60000]);
                return queue.route(kind, { id: String(delivery.insertId), target_id: target.id, lease_token: token, event_json: JSON.stringify(event), message_text: title }, now);
            }
            const source = (await query('SELECT source_id FROM auto_watch_targets WHERE id=?', [target.id]))[0], key = randomUUID();
            const item = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES (?,?,?,?,?,?)', [source.source_id, key, 'https://github.com/octocat/test', title, '{}', now]);
            const delivery = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [item.insertId, target.id, now, token, now + 60000]);
            return queue.route(kind, { id: String(delivery.insertId), target_id: target.id, lease_token: token, provider_id: 'github', source_key: 'octocat', content_key: key, content_url: 'https://github.com/octocat/test', title, payload_json: '{}', discovered_at_ms: now }, now);
        }
        async function drain() { for (let tick = 0; tick < 30; tick++) { const result = await flow.tick(); if (result.state === 'idle' && !result.projected) break; } }
        await work({ db, query, service, monitors, destination, workflow, auto, price, x, quota, queue, flow, input, drain });
    } finally { flow?.clear(); try { await evaluator?.stop(); } finally { await db.close(); } }
}
test('S21-1 deleting a used rule pauses and detaches auto, price and X while preserving registrations and slots', { skip: !port }, async () => fixture(async f => {
    const otherWorkflow = await f.service.createWorkflow(actor, { definition: newWorkflow('unaffected rule') }); await f.service.activateWorkflow(actor, otherWorkflow.id, { expectedRevision: 1 });
    const otherTarget = await f.monitors.save(actor, 'auto', { name: 'unaffected monitor', providerId: 'github', source: 'github', destinationId: f.destination.id }); await f.service.attach(actor, otherWorkflow.id, 'auto', otherTarget.id);
    const otherRun = await f.input('auto', otherTarget, 'unaffected pending'); await f.drain();
    const slots = await f.query('SELECT * FROM automation_notification_slots ORDER BY owner_user_id,slot_index');
    const xBefore = (await f.query('SELECT * FROM automation_x_monitors WHERE id=?', [f.x.id]))[0];
    const pending = await f.input('auto', f.auto, 'pending job'); await f.drain();
    const sent = await f.input('auto', f.auto, 'historical sent'); await f.drain();
    await f.query("UPDATE automation_jobs SET state='sent',sent_steps=1,discord_message_id='444444444444444444' WHERE run_id=?", [sent.runId]);
    const unknown = await f.input('auto', f.auto, 'unknown result'); await f.drain();
    await f.query("UPDATE automation_jobs SET state='unknown',last_error_code='DELIVERY_UNKNOWN' WHERE run_id=?", [unknown.runId]);
    const graphPending = await f.input('price', f.price, 'unprojected graph');
    const result = await f.service.remove('workflow', actor, f.workflow.id, 1); assert.deepEqual(result, { deleted: true, pausedTargets: 3 });
    for (const [kind, target] of [['auto', f.auto], ['price', f.price]]) {
        const table = kind === 'auto' ? 'auto_watch' : 'price_watch';
        assert.equal(Number((await f.query(`SELECT enabled FROM ${table}_targets WHERE id=?`, [target.id]))[0].enabled), 0);
        const metadata = (await f.query('SELECT destination_id,revision FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, target.id]))[0]; assert.equal(metadata.destination_id, f.destination.id); assert.equal(Number(metadata.revision), 3);
    }
    assert.equal((await f.query('SELECT * FROM automation_assignments WHERE workflow_id=?', [f.workflow.id])).length, 0);
    const xAfter = (await f.query('SELECT * FROM automation_x_monitors WHERE id=?', [f.x.id]))[0], settings = JSON.parse(xAfter.notification_settings_json);
    assert.equal(Number(xAfter.enabled), 0); assert.equal(Number(xAfter.revision), Number(xBefore.revision) + 1); assert.equal(xAfter.pool_kind, xBefore.pool_kind); assert.equal(xAfter.state, xBefore.state); assert.equal(xAfter.subscription_state, xBefore.subscription_state);
    assert.equal(settings.workflowId, undefined); assert.equal(settings.destinationId, f.destination.id); assert.equal(settings.processingMode, 'batch');
    assert.deepEqual(await f.query('SELECT * FROM automation_notification_slots ORDER BY owner_user_id,slot_index'), slots);
    for (const [run, state] of [[pending, 'cancelled'], [sent, 'sent'], [unknown, 'unknown']]) assert.equal((await f.query('SELECT state FROM automation_jobs WHERE run_id=?', [run.runId]))[0].state, state);
    assert.equal((await f.query('SELECT state FROM automation_jobs WHERE run_id=?', [otherRun.runId]))[0].state, 'pending'); assert.equal(Number((await f.query('SELECT enabled FROM auto_watch_targets WHERE id=?', [otherTarget.id]))[0].enabled), 1);
    assert.equal((await f.query("SELECT workflow_id FROM automation_assignments WHERE target_kind='auto' AND target_id=?", [otherTarget.id]))[0].workflow_id, otherWorkflow.id);
    assert.equal((await f.query('SELECT revocation_code FROM automation_flow_runs WHERE run_id=?', [graphPending.runId]))[0].revocation_code, 'WORKFLOW_DELETED');
    await f.drain(); assert.equal((await f.query('SELECT * FROM automation_jobs WHERE run_id=?', [graphPending.runId])).length, 0);
    // Explicit resume keeps the registration and uses its ordinary defaults.
    await f.monitors.save(actor, 'auto', { expectedRevision: 3, enabled: true }, f.auto.id);
    const resumed = await f.input('auto', f.auto, 'after explicit resume'); assert.equal(resumed.state, 'routed'); assert.equal(resumed.execution, undefined);
    const resumedJob = (await f.query('SELECT plan_json FROM automation_jobs WHERE run_id=?', [resumed.runId]))[0]; assert.equal(JSON.parse(resumedJob.plan_json).display.format, 'normal');
}));
test('S21-1 legacy native consumers receive a paused CAS row without losing their source or destination identity', { skip: !port }, async () => fixture(async f => {
    await f.query("DELETE FROM automation_monitors WHERE target_kind='auto' AND target_id=?", [f.auto.id]);
    const before = (await f.query('SELECT source_id,destination_type,destination_key,user_id FROM auto_watch_targets WHERE id=?', [f.auto.id]))[0];
    await f.service.remove('workflow', actor, f.workflow.id, 1);
    assert.deepEqual((await f.query('SELECT source_id,destination_type,destination_key,user_id FROM auto_watch_targets WHERE id=?', [f.auto.id]))[0], before);
    const metadata = (await f.query("SELECT revision,scope FROM automation_monitors WHERE target_kind='auto' AND target_id=?", [f.auto.id]))[0]; assert.equal(Number(metadata.revision), 2); assert.equal(metadata.scope, 'private');
}));
test('S21-1 no-consumer delete succeeds, stale revision and foreign owner cannot mutate a used rule', { skip: !port }, async () => fixture(async f => {
    const empty = await f.service.createWorkflow(actor, { definition: newWorkflow('unused') }); assert.deepEqual(await f.service.remove('workflow', actor, empty.id, 1), { deleted: true, pausedTargets: 0 });
    await assert.rejects(f.service.remove('workflow', { userId: V }, f.workflow.id, 1), { status: 404 });
    await assert.rejects(f.service.remove('workflow', actor, f.workflow.id, 2), { code: 'REVISION_CONFLICT' });
    assert.equal((await f.service.getWorkflow(actor, f.workflow.id)).revision, 1); assert.equal((await f.query('SELECT * FROM automation_assignments WHERE workflow_id=?', [f.workflow.id])).length, 2);
    assert.equal(Number((await f.query('SELECT enabled FROM automation_x_monitors WHERE id=?', [f.x.id]))[0].enabled), 1);
}));
test('S21-1 DB failure after pause rolls back monitor state, assignment, audit and workflow deletion atomically', { skip: !port }, async () => fixture(async f => {
    const before = await f.query('SELECT * FROM automation_x_monitors WHERE id=?', [f.x.id]);
    const auditCount = (await f.query('SELECT COUNT(*) AS n FROM automation_audit'))[0].n;
    const broken = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => { const result = await query(sql, params); if (sql.startsWith('DELETE FROM automation_assignments')) throw new Error('injected fixture rollback'); return result; })) };
    await assert.rejects(createService(broken).remove('workflow', actor, f.workflow.id, 1), /injected fixture rollback/);
    assert.deepEqual(await f.query('SELECT * FROM automation_x_monitors WHERE id=?', [f.x.id]), before);
    assert.equal((await f.query('SELECT COUNT(*) AS n FROM automation_audit'))[0].n, auditCount);
    assert.equal(Number((await f.query('SELECT enabled FROM auto_watch_targets WHERE id=?', [f.auto.id]))[0].enabled), 1);
    assert.equal((await f.query('SELECT * FROM automation_assignments WHERE workflow_id=?', [f.workflow.id])).length, 2); assert.equal((await f.service.getWorkflow(actor, f.workflow.id)).revision, 1);
}));
test('S21-1 a guild attachment committed before final workflow lock produces a clean conflict rather than a missed consumer', { skip: !port }, async () => fixture(async f => {
    const editor = { userId: U, guildId: G, canView: true, canEdit: true }, other = { userId: V, guildId: G, canView: true, canEdit: true };
    await grantTestDonor(f.db, V);
    const shared = await f.service.createWorkflow(editor, { scope: 'guild', definition: newWorkflow('shared delete race') });
    async function native(who, label) {
        const source = await f.query("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/synthetic/race',3600000,0)", [randomUUID()]);
        const row = await f.query("INSERT INTO auto_watch_targets (source_id,user_id,guild_id,destination_type,destination_key,enabled,created_at_ms) VALUES (?,?,?,'webhook',?,1,0)", [source.insertId, who.userId, G, label]);
        await f.query("INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES ('auto',?,?,'guild',1)", [row.insertId, label]); return String(row.insertId);
    }
    const original = await native(editor, 'original'), addition = await native(other, 'addition'); await f.service.attach(editor, shared.id, 'auto', original);
    const entered = deferred(), release = deferred(); let paused = false;
    const adapter = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => { if (!paused && sql === 'SELECT * FROM automation_workflows WHERE id=? FOR UPDATE' && params[0] === shared.id) { paused = true; entered.resolve(); await release.promise; } return query(sql, params); })) };
    const deleting = createService(adapter).remove('workflow', editor, shared.id, 1); await entered.promise;
    try { await f.service.attach(editor, shared.id, 'auto', addition); } finally { release.resolve(); }
    await assert.rejects(deleting, { code: 'WORKFLOW_TARGETS_CHANGED' });
    assert.equal((await f.query('SELECT * FROM automation_assignments WHERE workflow_id=?', [shared.id])).length, 2); assert.equal((await f.service.getWorkflow(editor, shared.id)).revision, 1);
    assert.equal((await f.service.remove('workflow', editor, shared.id, 1)).pausedTargets, 2);
    assert((await f.query('SELECT enabled FROM auto_watch_targets WHERE id IN (?)', [[original, addition]])).every(row => Number(row.enabled) === 0));
}));
test('S21-1 same-owner concurrent attach and delete serialize without leaving an enabled orphan assignment', { skip: !port }, async () => fixture(async f => {
    const next = await f.monitors.save(actor, 'auto', { name: 'competing attach', providerId: 'github', source: 'github', destinationId: f.destination.id });
    const results = await Promise.allSettled([f.service.remove('workflow', actor, f.workflow.id, 1), f.service.attach(actor, f.workflow.id, 'auto', next.id)]);
    assert(results.some(result => result.status === 'fulfilled'));
    const workflow = (await f.query('SELECT deleted_at_ms FROM automation_workflows WHERE id=?', [f.workflow.id]))[0];
    if (workflow.deleted_at_ms != null) assert.equal((await f.query('SELECT * FROM automation_assignments WHERE workflow_id=?', [f.workflow.id])).length, 0);
    else assert(results.some(result => result.status === 'rejected' && result.reason.code === 'WORKFLOW_TARGETS_CHANGED'));
}));
