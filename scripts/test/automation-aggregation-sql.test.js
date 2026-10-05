'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createHistory } = require('../../src/automation/history');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { newWorkflow } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
async function fixture(work) {
    const db = await createTestDatabase(port), query = db.queryDatabase;
    const service = createService(db), monitors = createMonitors(db, service, {});
    const actor = { userId: '222222222222222222' }, destination = await service.saveDestination(actor, { name: 'DM', kind: 'dm' });
    const monitor = await monitors.save(actor, 'auto', { name: 'fixture', providerId: 'github', source: 'octocat', destinationId: destination.id });
    let now = Date.parse('2026-09-22T10:00:00Z');
    const queue = createQueue(db, { evaluate: async (rule, event, _bindings, at) => evaluateWorkflow(rule, event, { now: at }) }, { clock: () => now });
    async function useRule(mode, maxItems = 2, expiresAfterMinutes) {
        const definition = newWorkflow('集約の検証');
        if (expiresAfterMinutes) definition.expiresAfterMinutes = expiresAfterMinutes;
        definition.nodes.splice(1, 0, { id: 'batch', type: 'aggregate', config: { minutes: 10, key: 'all', mode, maxItems } });
        definition.edges = [{ id: 'a', source: 'start', target: 'batch', port: 'out' }, { id: 'b', source: 'batch', target: 'send', port: 'out' }];
        const rule = await service.createWorkflow(actor, { definition });
        await service.activateWorkflow(actor, rule.id, { expectedRevision: 1 });
        await service.attach(actor, rule.id, 'auto', monitor.id);
        return rule;
    }
    async function event(title, advance = 0) {
        now += advance;
        const target = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0], key = randomUUID(), token = randomUUID();
        const row = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES (?,?,?,?,?,?)', [target.source_id, key, 'https://github.com/octocat/example', title, '{}', now]);
        const delivery = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [row.insertId, monitor.id, now, token, now + 60000]);
        return queue.route('auto', { id: String(delivery.insertId), target_id: monitor.id, lease_token: token, provider_id: 'github', source_key: 'octocat', content_key: key, content_url: 'https://github.com/octocat/example', title, payload_json: '{}', discovered_at_ms: now }, now);
    }
    try { await work({ db, query, service, actor, useRule, event, history: createHistory(db, service), queue, now: () => now }); }
    finally { await db.close(); }
}
test('latest aggregation counts received events, rolls at capacity and previews the retained event', { skip: !port }, async () => fixture(async f => {
    await f.useRule('latest', 2);
    await f.event('first'); await f.event('second', 1000); await f.event('third', 1000);
    const rows = await f.query('SELECT * FROM automation_jobs ORDER BY created_at_ms');
    const parents = rows.filter(row => !row.parent_job_id);
    assert.equal(parents.length, 2);
    const first = JSON.parse(parents[0].plan_json);
    assert.equal(first.aggregateCount, 2); assert.equal(first.members.length, 1);
    assert.equal(first.members[0].event.title, 'second');
    const detail = await f.history.detail(f.actor, parents[0].id);
    assert.equal(detail.title, 'second'); assert.match(detail.preview, /second/); assert.doesNotMatch(detail.preview, /first/);
    assert.equal(detail.aggregateReceived, 2); assert.equal(detail.aggregateItems, 1);
    assert.equal(detail.event.title, 'second'); assert.equal(detail.originalEvent.title, 'first');
}));
test('replaced aggregate children are excluded rather than labelled as delivered', { skip: !port }, async () => fixture(async f => {
    await f.useRule('latest', 10);
    await f.event('first'); await f.event('second', 1000); await f.event('third', 1000);
    const rows = await f.query('SELECT * FROM automation_jobs ORDER BY created_at_ms');
    assert.equal(rows[1].state, 'excluded'); assert.equal(rows[1].last_error_code, 'AGGREGATE_SUPERSEDED');
    assert.equal(rows[2].state, 'aggregated');
    const detail = await f.history.detail(f.actor, rows[0].id);
    assert.equal(detail.aggregateReceived, 3); assert.match(detail.preview, /third/);
}));
test('an aggregate beyond expiry leaves an explicit exclusion, not a queued run without jobs', { skip: !port }, async () => fixture(async f => {
    await f.useRule('all', 10, 1);
    const routed = await f.event('expires before batch');
    const run = (await f.query('SELECT * FROM automation_runs WHERE id=?', [routed.runId]))[0];
    assert.equal(run.state, 'excluded');
    assert(JSON.parse(run.trace_json).some(row => row.outcome === 'expired' && row.nodeId === 'batch'));
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
    assert.equal((await f.history.excluded(f.actor)).items.length, 1);
}));
test('corrupt historical snapshots remain visible but cannot be retried or rescheduled', { skip: !port }, async () => fixture(async f => {
    await f.useRule('all', 10); await f.event('history');
    const row = (await f.query('SELECT * FROM automation_jobs'))[0];
    await f.query("UPDATE automation_jobs SET state='failed',plan_json='broken json' WHERE id=?", [row.id]);
    const item = (await f.history.list(f.actor)).items[0];
    assert.equal(item.snapshotInvalid, true);
    const detail = await f.history.detail(f.actor, row.id);
    assert.deepEqual(detail.trace.length > 0, true);
    await assert.rejects(f.history.change(f.actor, row.id, { action: 'retry', expectedVersion: item.version }), { code: 'HISTORY_SNAPSHOT_INVALID' });
    assert.equal((await f.history.change(f.actor, row.id, { action: 'cancel', expectedVersion: item.version })).state, 'cancelled');
}));

test('malformed but parseable historical fields cannot crash the list or trace viewer', { skip: !port }, async () => fixture(async f => {
    await f.useRule('all', 10); await f.event('safe');
    const row = (await f.query('SELECT * FROM automation_jobs'))[0];
    await f.query('UPDATE automation_runs SET event_json=?,trace_json=? WHERE id=?', [JSON.stringify({ title: { invalid: true } }), '[null]', row.run_id]);
    const view = await f.history.detail(f.actor, row.id);
    assert.equal(view.snapshotInvalid, true); assert.equal(view.title, 'safe'); assert.deepEqual(view.trace, []);
    await f.query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify({ text: { invalid: true } }), row.id]);
    assert.equal((await f.history.list(f.actor)).items[0].snapshotInvalid, true);
}));

test('expired plans become expired even while their workflow is paused', { skip: !port }, async () => fixture(async f => {
    const rule = await f.useRule('all', 10, 20); await f.event('expires');
    const row = (await f.query('SELECT * FROM automation_jobs'))[0];
    const claimed = await f.queue.claim(Number(row.due_at_ms));
    await f.service.setWorkflowState(f.actor, rule.id, { expectedRevision: 1, enabled: false });
    const result = await f.queue.check(claimed, Number(row.deadline_ms) + 1);
    assert.equal(result.state, 'expired');
}));
