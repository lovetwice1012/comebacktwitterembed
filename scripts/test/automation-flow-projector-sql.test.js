'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createGraphDriver } = require('../../src/automation/graph-driver');
const { createFlowProjector } = require('../../src/automation/flow-projector');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createRunner } = require('../../src/automation/runtime');
const { compileWorkflow } = require('../../src/automation/graph-plan');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), baseTime = Date.parse('2026-09-22T10:00:00Z');
async function fixture(work) {
    const db = await createTestDatabase(port), query = db.queryDatabase, service = createService(db), monitors = createMonitors(db, service, {});
    const actor = { userId: '222222222222222222' }, firstDestination = await service.saveDestination(actor, { name: 'DM first', kind: 'dm' }), secondDestination = await service.saveDestination(actor, { name: 'DM second', kind: 'dm' });
    const first = await monitors.save(actor, 'auto', { name: 'first', providerId: 'github', source: 'octocat', destinationId: firstDestination.id });
    const second = await monitors.save(actor, 'auto', { name: 'second', providerId: 'github', source: 'github', destinationId: secondDestination.id });
    try { await work({ db, query, service, monitors, actor, first, second, firstDestination, secondDestination }); }
    finally { await db.close(); }
}
async function input(query, monitor, title, now) {
    const target = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0], token = randomUUID(), key = randomUUID();
    const item = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,discovered_at_ms) VALUES (?,?,?,?,?,?)', [target.source_id, key, `https://github.com/${title}`, title, '{}', now]);
    const delivery = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [item.insertId, monitor.id, now, token, now + 60000]);
    return { id: String(delivery.insertId), target_id: monitor.id, lease_token: token, provider_id: 'github', source_key: title, content_key: key, content_url: `https://github.com/${title}`, title, payload_json: '{}', discovered_at_ms: now };
}
async function runFlow({ db, query, definition, queue, at }) {
    const store = createGraphStore(db), plan = compileWorkflow(definition), driver = createGraphDriver(store, { assertEnabled: () => {}, loadPlan: async () => plan });
    for (let index = 0; index < 100; index++) { const result = await driver.tick(at); if (result.state === 'idle') break; }
    return { store, driver };
}
test('flow projection creates a regular pending job from a frozen send intent without re-evaluating its rule', { skip: !port }, async () => fixture(async f => {
    const definition = newWorkflow('project'); const workflow = await f.service.createWorkflow(f.actor, { definition }); await f.service.activateWorkflow(f.actor, workflow.id, { expectedRevision: 1 }); await f.service.attach(f.actor, workflow.id, 'auto', f.first.id);
    const queue = createQueue(f.db, { evaluate: async () => { throw new Error('legacy must not evaluate'); } }, { clock: () => baseTime, graph: { enabled: true, store: createGraphStore(f.db) } });
    await queue.route('auto', await input(f.query, f.first, 'single', baseTime), baseTime);
    await runFlow({ db: f.db, query: f.query, definition, queue, at: baseTime });
    const projected = await createFlowProjector(f.db).projectOne(baseTime);
    assert.equal(projected.state, 'projected'); assert.equal(projected.jobs.length, 1);
    const job = (await f.query('SELECT * FROM automation_jobs WHERE id=?', [projected.jobs[0]]))[0], plan = JSON.parse(job.plan_json);
    assert.equal(job.destination_id, f.firstDestination.id); assert.equal(plan.flowV2.members.length, 1); assert.equal(plan.members[0].event.title, 'single');
    assert.equal(plan.members[0].text, 'single\nhttps://github.com/single'); assert.equal(plan.context.userId, f.actor.userId);
    assert.equal((await createFlowProjector(f.db).projectOne(baseTime)), null);
}));
test('one cross-monitor aggregate is partitioned into destination-specific jobs and revoked members are excluded before projection', { skip: !port }, async () => fixture(async f => {
    const definition = newWorkflow('partitioned'); definition.nodes.splice(1, 0, { id: 'batch', type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, minutes: 1, key: 'all' } }); definition.edges = [{ id: 'a', source: 'start', target: 'batch', port: 'out' }, { id: 'b', source: 'batch', target: 'send', port: 'out' }];
    const workflow = await f.service.createWorkflow(f.actor, { definition }); await f.service.activateWorkflow(f.actor, workflow.id, { expectedRevision: 1 }); await f.service.attach(f.actor, workflow.id, 'auto', f.first.id); await f.service.attach(f.actor, workflow.id, 'auto', f.second.id);
    const queue = createQueue(f.db, { evaluate: async () => { throw new Error('legacy must not evaluate'); } }, { clock: () => baseTime, graph: { enabled: true, store: createGraphStore(f.db) } });
    const first = await queue.route('auto', await input(f.query, f.first, 'first', baseTime), baseTime), second = await queue.route('auto', await input(f.query, f.second, 'second', baseTime), baseTime);
    await runFlow({ db: f.db, query: f.query, definition, queue, at: baseTime }); await runFlow({ db: f.db, query: f.query, definition, queue, at: baseTime + 60000 });
    await createGraphStore(f.db).revokeRun(first.runId, 'MONITOR_CHANGED', baseTime + 60001);
    const projected = await createFlowProjector(f.db).projectOne(baseTime + 60001);
    assert.equal(projected.jobs.length, 1);
    const job = (await f.query('SELECT * FROM automation_jobs WHERE id=?', [projected.jobs[0]]))[0], plan = JSON.parse(job.plan_json);
    assert.equal(job.destination_id, f.secondDestination.id); assert.deepEqual(plan.members.map(member => member.event.title), ['second']);
    assert.equal(plan.flowV2.members[0].runId, second.runId);
}));
test('a queued flow job drops only a monitor changed after projection and rechecks the remaining member before send', { skip: !port }, async () => fixture(async f => {
    const third = await f.monitors.save(f.actor, 'auto', { name: 'third', providerId: 'github', source: 'microsoft', destinationId: f.firstDestination.id });
    const definition = newWorkflow('refresh'); definition.nodes.splice(1, 0, { id: 'batch', type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, minutes: 1, key: 'all' } }); definition.edges = [{ id: 'a', source: 'start', target: 'batch', port: 'out' }, { id: 'b', source: 'batch', target: 'send', port: 'out' }];
    const workflow = await f.service.createWorkflow(f.actor, { definition }); await f.service.activateWorkflow(f.actor, workflow.id, { expectedRevision: 1 }); await f.service.attach(f.actor, workflow.id, 'auto', f.first.id); await f.service.attach(f.actor, workflow.id, 'auto', third.id);
    const queue = createQueue(f.db, { evaluate: async () => { throw new Error('legacy must not evaluate'); } }, { clock: () => baseTime, graph: { enabled: true, store: createGraphStore(f.db) } });
    const firstRoute = await queue.route('auto', await input(f.query, f.first, 'first', baseTime), baseTime), thirdRoute = await queue.route('auto', await input(f.query, third, 'third', baseTime), baseTime);
    assert.equal(firstRoute.execution, 'flow_v2', JSON.stringify(firstRoute)); assert.equal(thirdRoute.execution, 'flow_v2', JSON.stringify(thirdRoute));
    await runFlow({ db: f.db, query: f.query, definition, queue, at: baseTime }); await runFlow({ db: f.db, query: f.query, definition, queue, at: baseTime + 60000 });
    const projected = await createFlowProjector(f.db).projectOne(baseTime + 60000), claimed = await queue.claim(baseTime + 60000);
    assert(projected, JSON.stringify({ sends: await f.query('SELECT * FROM automation_flow_sends'), steps: await f.query('SELECT node_id,state FROM automation_flow_steps') }));
    assert.equal(projected.jobs.length, 1); assert.equal(claimed.plan.members.length, 2);
    await f.monitors.save(f.actor, 'auto', { expectedRevision: 1, enabled: false }, f.first.id);
    const refreshed = await queue.refreshFlowJob(claimed, baseTime + 60001);
    assert.equal(refreshed.state, 'ready'); assert.deepEqual(refreshed.job.plan.members.map(member => member.event.title), ['third']);
    assert.equal((await queue.check(refreshed.job, baseTime + 60001)).state, 'ready');
    assert.equal(JSON.parse((await f.query('SELECT plan_json FROM automation_jobs WHERE id=?', [claimed.id]))[0].plan_json).members.length, 1);
}));
test('flow runtime resolves only the pinned dictionary revision and projects a matched branch without the legacy evaluator', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const dictionary = await f.service.saveDictionary(f.actor, { dictionary: { schemaVersion: 1, name: 'words', entries: ['sale'] } });
    const definition = newWorkflow('dictionary flow'); definition.nodes.splice(1, 0, { id: 'words', type: 'dictionary', config: { dictionary: 'words', fields: ['title'] } }, { id: 'stop', type: 'stop', config: { reason: 'no match' } }); definition.edges = [{ id: 'a', source: 'start', target: 'words', port: 'out' }, { id: 'b', source: 'words', target: 'send', port: 'yes' }, { id: 'c', source: 'words', target: 'stop', port: 'no' }, { id: 'd', source: 'words', target: 'stop', port: 'unknown' }];
    const workflow = await f.service.createWorkflow(f.actor, { definition, bindings: { dictionaries: { words: { id: dictionary.id, revision: dictionary.revision } } } }); await f.service.activateWorkflow(f.actor, workflow.id, { expectedRevision: 1 }); await f.service.attach(f.actor, workflow.id, 'auto', f.first.id);
    const evaluator = createEvaluator(f.service.dictionaryData), store = createGraphStore(f.db), queue = createQueue(f.db, evaluator, { clock: () => baseTime, graph: { enabled: true, store } }), flow = createFlowRuntime(f.db, evaluator, store, { assertEnabled: () => {} });
    try {
        await queue.route('auto', await input(f.query, f.first, 'sale', baseTime), baseTime);
        for (let i = 0; i < 10; i++) await flow.tick(baseTime);
        const jobs = await f.query('SELECT * FROM automation_jobs'); assert.equal(jobs.length, 1);
        assert.equal(JSON.parse(jobs[0].plan_json).members[0].event.title, 'sale');
    } finally { flow.clear(); evaluator.stop(); }
}));
test('a projected flow job goes through the normal durable runner once, with no Discord transport in this fixture', { skip: !port, timeout: 30000 }, async () => fixture(async f => {
    const definition = newWorkflow('runner flow'); const workflow = await f.service.createWorkflow(f.actor, { definition }); await f.service.activateWorkflow(f.actor, workflow.id, { expectedRevision: 1 }); await f.service.attach(f.actor, workflow.id, 'auto', f.first.id);
    const evaluator = createEvaluator(f.service.dictionaryData), store = createGraphStore(f.db), queue = createQueue(f.db, evaluator, { clock: () => baseTime, graph: { enabled: true, store } }), flow = createFlowRuntime(f.db, evaluator, store, { assertEnabled: () => {} });
    let prepared = 0, sent = 0;
    const transport = { readiness: () => true, prepare: async (_job, destination) => { prepared++; assert.equal(destination.kind, 'dm'); return { payloads: [{ body: { content: 'fixture' } }] }; }, sendStep: async () => { sent++; return '444444444444444444'; } };
    try {
        await queue.route('auto', await input(f.query, f.first, 'runner', baseTime), baseTime);
        for (let i = 0; i < 10; i++) await flow.tick(baseTime);
        let now = baseTime;
        const runner = createRunner(f.db, queue, transport, { clock: () => now, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => { now += ms; } });
        assert.equal((await runner.tick()).state, 'sent'); assert.equal(prepared, 1); assert.equal(sent, 1);
        assert.equal((await f.query('SELECT state FROM automation_jobs'))[0].state, 'sent');
    } finally { flow.clear(); evaluator.stop(); }
}));
