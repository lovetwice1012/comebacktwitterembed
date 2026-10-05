'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createGraphStore } = require('../../src/automation/graph-store');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), now = Date.parse('2026-09-22T10:00:00Z');
async function fixture(work) {
    const db = await createTestDatabase(port), query = db.queryDatabase, service = createService(db), monitors = createMonitors(db, service, {});
    const actor = { userId: '222222222222222222' }, destination = await service.saveDestination(actor, { name: 'DM', kind: 'dm' });
    const monitor = await monitors.save(actor, 'auto', { name: 'flow source', providerId: 'github', source: 'octocat', destinationId: destination.id });
    const definition = newWorkflow('flow route'); definition.nodes.splice(1, 0, { id: 'limit', type: 'limit', config: { ...NODE_TYPES.limit.defaults, count: 2, key: 'all' } });
    definition.edges = [{ id: 'a', source: 'start', target: 'limit', port: 'out' }, { id: 'b', source: 'limit', target: 'send', port: 'out' }];
    const workflow = await service.createWorkflow(actor, { definition }); await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 }); await service.attach(actor, workflow.id, 'auto', monitor.id);
    async function delivery() {
        const target = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0], token = randomUUID(), key = randomUUID();
        const item = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES (?,?,?,?,?,?)', [target.source_id, key, 'https://github.com/octocat/example', 'flow item', JSON.stringify({ author: 'octocat' }), now]);
        const row = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [item.insertId, monitor.id, now, token, now + 60000]);
        return { id: String(row.insertId), target_id: monitor.id, lease_token: token, provider_id: 'github', source_key: 'octocat', content_key: key, content_url: 'https://github.com/octocat/example', title: 'flow item', payload_json: JSON.stringify({ author: 'octocat' }), discovered_at_ms: now };
    }
    try { await work({ db, query, actor, monitor, workflow, delivery }); }
    finally { await db.close(); }
}
test('source handoff atomically creates a frozen flow run and does not invoke the legacy evaluator', { skip: !port }, async () => fixture(async f => {
    let evaluated = 0;
    const queue = createQueue(f.db, { evaluate: async () => { evaluated++; throw new Error('legacy evaluator must not run'); } }, { clock: () => now, graph: { enabled: true, store: createGraphStore(f.db) } });
    const input = await f.delivery(), result = await queue.route('auto', input, now);
    assert.equal(result.execution, 'flow_v2'); assert.equal(evaluated, 0);
    assert.equal((await f.query('SELECT status FROM auto_watch_deliveries WHERE id=?', [input.id]))[0].status, 'routed');
    const run = (await f.query('SELECT * FROM automation_runs WHERE id=?', [result.runId]))[0];
    assert.equal(run.state, 'flow_pending'); assert.equal(run.revision, 1);
    const flow = (await f.query('SELECT * FROM automation_flow_runs WHERE run_id=?', [result.runId]))[0], context = JSON.parse(flow.context_json);
    assert.deepEqual({ workflowId: context.workflowId, revision: context.revision, targetKind: context.targetKind, targetId: context.targetId, destinationId: context.destinationId }, { workflowId: f.workflow.id, revision: 1, targetKind: 'auto', targetId: String(f.monitor.id), destinationId: (await f.query('SELECT destination_id FROM automation_monitors WHERE target_kind=\'auto\' AND target_id=?', [f.monitor.id]))[0].destination_id });
    const step = (await f.query('SELECT * FROM automation_flow_steps WHERE node_id=\'start\''))[0];
    const unit = await createGraphStore(f.db).readUnit(step.input_unit_id);
    assert.equal(unit.members[0].event.title, 'flow item'); assert.equal(unit.members[0].defaultPriceText, null);
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
}));
test('a flow-admission failure rolls back the run and leaves the legacy delivery leased for safe retry', { skip: !port }, async () => fixture(async f => {
    const queue = createQueue(f.db, { evaluate: async () => { throw new Error('not reached'); } }, { clock: () => now, graph: { enabled: true, store: { initializeInTransaction: async () => { throw Object.assign(new Error('fixture abort'), { code: 'FLOW_FIXTURE_ABORT' }); } } } });
    const input = await f.delivery();
    await assert.rejects(queue.route('auto', input, now), { code: 'FLOW_FIXTURE_ABORT' });
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_runs'))[0].n), 0);
    const delivery = (await f.query('SELECT status,lease_token FROM auto_watch_deliveries WHERE id=?', [input.id]))[0];
    assert.equal(delivery.status, 'pending'); assert.equal(delivery.lease_token, input.lease_token);
}));
