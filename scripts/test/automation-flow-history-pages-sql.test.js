'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createQueue, targetIdentity } = require('../../src/automation/queue');
const { createRunner } = require('../../src/automation/runtime');
const { createHistory } = require('../../src/automation/history');
const { NODE_TYPES, validateWorkflow } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), owner = '222222222222222222';
const node = (id, type, config = {}) => ({ id, type, config: { ...structuredClone(NODE_TYPES[type].defaults), ...config } });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function largeHistory(termSize, work) {
    const db = await createTestDatabase(port); let evaluator, flow;
    try {
        const query = db.queryDatabase, now = Date.now(), actor = { userId: owner }, service = createService(db); await grantTestDonor(db, owner);
        const destination = await service.saveDestination(actor, { name: 'History DM', kind: 'dm' });
        const monitor = await createMonitors(db, service, {}).save(actor, 'auto', { name: 'History monitor', providerId: 'github', source: 'octocat', destinationId: destination.id });
        const target = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0];
        const nodes = [node('start','start'), node('batch1','aggregate',{ key: 'all', minutes: 1, maxItems: 100 }), node('batch2','aggregate',{ key: 'all', minutes: 1, maxItems: 100 }), node('join','merge'), node('send','send')], edges = [];
        const edge = (source, target, port = 'out') => edges.push({ id: `edge${edges.length}`, source, target, port });
        for (let index = 0; index < 16; index++) { nodes.push(node(`left${index}`,'transform')); edge('start', `left${index}`); edge(`left${index}`, 'batch1'); nodes.push(node(`right${index}`,'transform')); edge('batch1', `right${index}`); edge(`right${index}`, 'batch2'); }
        for (let index = 0; index < 15; index++) { nodes.push(node(`dict${index}`,'dictionary',{ dictionary: 'words', fields: ['body'] })); edge(index ? `dict${index - 1}` : 'batch2', `dict${index}`, index ? 'yes' : 'out'); } edge('dict14','join','yes'); edge('join','send');
        const definition = { schemaVersion: 1, name: 'Complete diagnostic history', nodes, edges }; assert.equal(nodes.length, 52); assert.equal(edges.length, 81); assert.equal(validateWorkflow(definition).valid, true);
        const term = '雪'.repeat(termSize), dictionary = await service.saveDictionary(actor, { dictionary: { schemaVersion: 1, name: 'Legal term', entries: [term] } });
        const workflow = await service.createWorkflow(actor, { definition, bindings: { dictionaries: { words: { id: dictionary.id, revision: 1 } } } }); await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 }); await service.attach(actor, workflow.id, 'auto', monitor.id);
        const context = { ownerUserId: owner, scope: 'private', workflowId: workflow.id, revision: 1, bindings: workflow.bindings, targetKind: 'auto', targetId: monitor.id, monitorRevision: 2, targetIdentity: targetIdentity(target), destinationId: destination.id, sourceContext: { destinationType: 'dm' } };
        const runId = randomUUID(), event = { providerId: 'github', title: 'One source event', body: (term + ' ').repeat(8), observedAtMs: now };
        await query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,'private','auto',?,?,'[]','flow_pending',?)", [runId, hash(runId), workflow.id, owner, monitor.id, JSON.stringify(event), now]);
        await createGraphStore(db).initialize({ runId, context, nodeId: 'start', now, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: now }] } });
        evaluator = createEvaluator(service.dictionaryData); flow = createFlowRuntime(db, evaluator, createGraphStore(db), { assertEnabled: () => {} });
        let at = now;
        for (let tick = 0; tick < 160; tick++) { const result = await flow.tick(at); if (result.state === 'idle') { const batch = (await query("SELECT MIN(closes_at_ms) AS due FROM automation_flow_batches WHERE state='open'"))[0]; if (batch.due !== null) at = Number(batch.due); else break; } }
        const jobs = await query('SELECT * FROM automation_jobs'); assert.equal(jobs.length, 1);
        const expected = [];
        for (const step of await query('SELECT * FROM automation_flow_steps ORDER BY created_at_ms,id')) { const decision = JSON.parse(step.decision_json || '{}'), entries = (decision.trace || []).filter(entry => !entry.runId || entry.runId === runId); expected.push(...entries); if (!entries.length && !decision.terminalFailure && decision.code) expected.push({ nodeId: step.node_id, outcome: 'excluded', reason: decision.code, wakeAtMs: Number(step.wake_at_ms) }); }
        const stored = (await query('SELECT * FROM automation_runs WHERE id=?', [runId]))[0];
        await work({ db, query, actor, service, runId, jobs, expected, stored, at, evaluator, workflow, context });
    } finally { flow?.clear(); await evaluator?.stop(); await db.close(); }
}

for (const termSize of [255, 1]) test(`S7/N6 full 52-node real-worker history with ${termSize}-character terms sends once and remains completely readable`, { skip: !port, timeout: 240000 }, async () => largeHistory(termSize, async f => {
    if (termSize === 255) { assert(Buffer.byteLength(JSON.stringify(f.expected)) > 16 * 1024 * 1024); assert(Buffer.byteLength(f.stored.trace_json) <= 4 * 1024 * 1024); }
    else assert.deepEqual(JSON.parse(f.stored.trace_json), f.expected, 'Small ordinary arrays keep their original API/storage representation');
    let at = f.at, sent = 0; const queue = createQueue(f.db, f.evaluator, { clock: () => at });
    await createRunner(f.db, queue, { readiness: () => true, prepare: async () => ({ payloads: [{}] }), sendStep: async () => { sent++; return '777777777777777777'; } }, { clock: () => at, sleep: async ms => { at += ms; }, assertAllowed: () => {} }).tick(); assert.equal(sent, 1);
    const original = await f.query('SELECT id,checksum FROM automation_flow_units ORDER BY id'), decisions = await f.query('SELECT id,decision_json FROM automation_flow_steps ORDER BY id');
    const history = createHistory(f.db, f.service), all = []; let cursor, sourceRevision;
    for (let pages = 0; pages < 1000; pages++) {
        const page = await history.trace(f.actor, f.runId, { cursor }); assert(page.items.length <= 50); sourceRevision ||= page.sourceRevision; assert.equal(page.sourceRevision, sourceRevision);
        assert.equal(page.items.length, page.sources.length); all.push(...page.items); cursor = page.nextCursor; if (!cursor) break;
    }
    assert.equal(cursor, null); assert.equal(all.length, f.expected.length); assert.equal(digest(all), digest(f.expected));
    assert.deepEqual(await f.query('SELECT id,checksum FROM automation_flow_units ORDER BY id'), original); assert.deepEqual(await f.query('SELECT id,decision_json FROM automation_flow_steps ORDER BY id'), decisions);
    const restarted = createHistory(f.db, createService(f.db)); assert.equal((await restarted.trace(f.actor, f.runId)).sourceRevision, sourceRevision);
    await assert.rejects(restarted.trace({ userId: '333333333333333333', isAdmin: true }, f.runId), { status: 404 });
}));
