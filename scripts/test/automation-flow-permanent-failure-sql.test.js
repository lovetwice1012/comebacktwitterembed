'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue, targetIdentity } = require('../../src/automation/queue');
const { createFlowProjector } = require('../../src/automation/flow-projector');
const { createRunner } = require('../../src/automation/runtime');
const { createHistory } = require('../../src/automation/history');
const { createGraphStore, namespaceKey } = require('../../src/automation/graph-store');
const { createGraphDriver } = require('../../src/automation/graph-driver');
const { compileWorkflow, copyData } = require('../../src/automation/graph-plan');
const { stepNode } = require('../../src/automation/graph-step');
const { NODE_TYPES } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), owner = '222222222222222222';
const node = (id, type, config = {}) => ({ id, type, config: { ...NODE_TYPES[type].defaults, ...config } });
async function fixture(type, config, work, aggregate = false) {
    const db = await createTestDatabase(port);
    try {
        const query = db.queryDatabase, service = createService(db), now = Date.now(); await grantTestDonor(db, owner);
        const destination = await service.saveDestination({ userId: owner }, { name: 'Healthy DM', kind: 'dm' });
        const monitor = await createMonitors(db, service, {}).save({ userId: owner }, 'auto', { name: 'Fixture', providerId: 'github', source: 'octocat', destinationId: destination.id });
        const target = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0];
        const definition = { schemaVersion: 1, name: 'Permanent materialization', nodes: [node('start','start'), node('poison',type,config), node('healthy','condition',{ predicate: { field: 'title', op: 'eq', value: 'member0' } }), node('join','merge'), node('send','send')],
            edges: [{ id: 'into', source: 'start', target: 'poison', port: 'out' }, { id: 'out', source: 'poison', target: 'join', port: NODE_TYPES[type].ports[0] },
                { id: 'healthyIn', source: 'start', target: 'healthy', port: 'out' }, { id: 'healthyOut', source: 'healthy', target: 'join', port: 'yes' }, { id: 'joined', source: 'join', target: 'send', port: 'out' }] };
        if (aggregate) { definition.nodes.splice(1, 0, node('batch','aggregate',{ minutes: 1, key: 'all', maxItems: 100 })); definition.edges[0].target = 'batch'; definition.edges.push({ id: 'batched', source: 'batch', target: 'poison', port: 'out' }); }
        if (aggregate === 'fork') definition.edges.find(edge => edge.id === 'healthyIn').source = 'batch';
        const dictionary = await service.saveDictionary({ userId: owner }, { dictionary: { schemaVersion: 1, name: 'Words', entries: ['sale'] } });
        const workflow = await service.createWorkflow({ userId: owner }, { definition, bindings: type === 'dictionary' ? { dictionaries: { words: { id: dictionary.id, revision: 1 } } } : {} });
        await service.activateWorkflow({ userId: owner }, workflow.id, { expectedRevision: 1 }); await service.attach({ userId: owner }, workflow.id, 'auto', monitor.id);
        const context = { ownerUserId: owner, scope: 'private', workflowId: workflow.id, revision: 1, targetKind: 'auto', targetId: monitor.id, monitorRevision: 2,
            targetIdentity: targetIdentity(target), destinationId: destination.id, bindings: workflow.bindings, sourceContext: { destinationType: 'dm' } }, namespace = namespaceKey(context), runId = randomUUID();
        await query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,'private','auto',?,'{}','[]','flow_pending',?)", [runId, hash(runId), workflow.id, owner, monitor.id, now]);
        await query('INSERT INTO automation_flow_runs(run_id,namespace_key,context_json) VALUES(?,?,?)', [runId, namespace, JSON.stringify(context)]);
        async function input(count, extra = {}) {
            const unit = { kind: 'batch', ancestry: [], members: Array.from({ length: count }, (_, index) => ({ id: `member${index}`, runId,
                event: { providerId: 'github', title: `member${index}`, body: 'sale sale sale sale sale sale sale sale', observedAtMs: now }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: now, baseTimeMs: now, ...extra })) };
            copyData(unit); await store.initialize({ runId, context, nodeId: 'start', unit, now }); await driver.tick(now);
            await query("UPDATE automation_flow_steps SET wake_at_ms=? WHERE node_id='healthy'", [now + 1]);
            const step = (await query("SELECT * FROM automation_flow_steps WHERE node_id='poison'"))[0], stored = await store.readUnit(step.input_unit_id);
            return { unit: stored, stepId: step.id, payload: (await query('SELECT payload_json FROM automation_flow_units WHERE id=?', [step.input_unit_id]))[0].payload_json };
        }
        const plan = compileWorkflow(definition), store = createGraphStore(db), evaluateStep = (selected, unit, at) => stepNode(selected, unit, { now: at, dictionaries: { words: { match: () => Array.from({ length: 8 }, (_, i) => ({ term: 'sale', start: i * 5, end: i * 5 + 4 })) } } });
        const driver = createGraphDriver(store, { assertEnabled: () => {}, loadPlan: async () => plan, evaluateStep });
        async function healthy(at = now + 1) {
            for (let tick = 0; tick < 18; tick++) { await driver.tick(at); await createFlowProjector(db).projectOne(at); }
            let sent = 0, clock = at; const queue = createQueue(db, {}, { clock: () => clock });
            for (let tick = 0; tick < 5 && !sent; tick++) await createRunner(db, queue, { readiness: () => true, prepare: async () => ({ payloads: [{}] }), sendStep: async () => { sent++; return '777777777777777777'; } }, { clock: () => clock, sleep: async ms => { clock += ms; }, assertAllowed: () => {} }).tick();
            return sent;
        }
        const driverFor = (adapter = db, evaluate = evaluateStep) => createGraphDriver(createGraphStore(adapter), { assertEnabled: () => {}, loadPlan: async () => plan, evaluateStep: evaluate });
        await work({ db, query, now, store, driver, driverFor, plan, evaluateStep, input, runId, namespace, healthy, service, context });
    } finally { await db.close(); }
}
test('S7 valid 5000-member dictionary trace failure becomes terminal after its output transaction rolls back', { skip: !port }, async () => fixture('dictionary', { fields: ['body'] }, async f => {
    const input = await f.input(5000), transition = f.evaluateStep(f.plan.byId.get('poison'), input.unit, f.now);
    assert.equal(transition.emissions[0].unit.members.length, 5000); assert.throws(() => copyData({ trace: transition.trace }), { code: 'GRAPH_INPUT_LIMIT' });
    const before = Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_units'))[0].n);
    const result = await f.driver.tick(f.now); assert.equal(result.state, 'failed');
    assert.equal((await f.query('SELECT state FROM automation_flow_steps WHERE id=?', [input.stepId]))[0].state, 'excluded');
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_units'))[0].n), before, 'partial output insertion was rolled back');
    assert.equal((await f.query('SELECT payload_json FROM automation_flow_units WHERE id=?', [input.unit.id]))[0].payload_json, input.payload);
    assert.equal(await f.healthy(), 1, 'any merge keeps the healthy sibling of this same run');
    await require('../../src/automation/flow-history').refreshFlowHistory(f.query, [f.runId]);
    const run = (await f.query('SELECT state,trace_json FROM automation_runs WHERE id=?', [f.runId]))[0];
    // The healthy sibling still delivers once. The failed branch remains part
    // of this run, so a complete-success summary would hide that failure.
    assert.equal(run.state, 'partial'); assert(JSON.parse(run.trace_json).some(entry => entry.reason === 'GRAPH_INPUT_LIMIT'));
    assert.deepEqual((await f.query('SELECT state,sent_steps FROM automation_jobs WHERE run_id=?', [f.runId])).map(row => ({ ...row })), [{ state: 'sent', sent_steps: 1 }]);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE run_id=? AND receipt_kind='step_failed'", [f.runId]))[0].n), 1);
}));

test('S7 permanent trace failure is visible as failed when no sibling matches, with its full original input retained', { skip: !port }, async () => fixture('dictionary', { fields: ['body'] }, async f => {
    await f.input(5000, { event: { providerId: 'github', title: 'no healthy match', body: 'sale sale sale sale sale sale sale sale', observedAtMs: f.now } });
    assert.equal((await f.driver.tick(f.now)).state, 'failed'); assert.equal(await f.healthy(), 0);
    const page = await createHistory(f.db, f.service).excluded({ userId: owner }); assert.equal(page.items.find(item => item.id === f.runId).state, 'failed');
    assert(page.items.find(item => item.id === f.runId).trace.some(item => item.reason === 'GRAPH_INPUT_LIMIT'));
}));

test('S7 genuine 95-input aggregate can fail downstream transform once and release the next healthy execution', { skip: !port, timeout: 120000 }, async () => fixture('transform', { template: 'あ'.repeat(4000) }, async f => {
    for (let index = 0; index < 95; index++) {
        const runId = randomUUID(), event = { providerId: 'github', kind: 'new', title: 'T'.repeat(4096), body: 'B'.repeat(65536), author: 'A'.repeat(4096), url: `https://github.com/${'u'.repeat(4000)}`, observedAtMs: f.now };
        await f.query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,'private','auto',?,?,'[]','flow_pending',?)", [runId, hash(runId), f.context.workflowId, owner, f.context.targetId, JSON.stringify(event), f.now]);
        await f.store.initialize({ runId, context: f.context, nodeId: 'batch', now: f.now, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: f.now, baseTimeMs: f.now }] } });
    }
    for (let tick = 0; tick < 95; tick++) await f.driver.tick(f.now);
    assert.equal((await f.driver.tick(f.now + 60000)).state, 'sealed');
    const selected = (await f.query("SELECT * FROM automation_flow_steps WHERE node_id='poison'"))[0], unit = await f.store.readUnit(selected.input_unit_id); copyData(unit);
    assert.equal(unit.members.length, 95); assert(Buffer.byteLength(JSON.stringify(unit)) > 7000000);
    assert.equal((await f.driver.tick(f.now + 60000)).state, 'failed');
    assert.equal((await f.query('SELECT state FROM automation_flow_steps WHERE id=?', [selected.id]))[0].state, 'excluded');
    await f.store.initialize({ runId: f.runId, context: f.context, nodeId: 'send', now: f.now, unit: { kind: 'event', ancestry: [], members: [{ id: f.runId, runId: f.runId,
        event: { providerId: 'github', title: 'Next healthy', observedAtMs: f.now }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: f.now }] } });
    assert.equal(await f.healthy(f.now + 60000), 1);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_steps WHERE node_id='poison' AND state='leased'"))[0].n), 0);
}, true));

for (const count of [127, 128]) test(`S7 accepted ${count}-schedule input keeps the existing schedule cap and ${count === 128 ? 'terminalizes growth' : 'remains a legitimate control'}`, { skip: !port }, async () => fixture('schedule', {}, async f => {
    const schedules = Array.from({ length: count }, (_, index) => ({ ...NODE_TYPES.schedule.defaults, zone: 'UTC', windows: [{ start: '00:00', end: '24:00' }], maxWaitDays: index + 1 }));
    await f.input(1, { schedules }); const result = await f.driver.tick(f.now);
    if (count === 128) { assert.equal(result.state, 'failed'); assert.equal(await f.healthy(), 1); }
    else { assert(['complete','pending'].includes(result.state)); assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE receipt_kind='step_failed'"))[0].n), 0); }
}));

for (const variant of ['duplicate', 'cycle', 'memberLimit']) test(`S7 storage shape ${variant} rolls back every partial output before bounded terminal settlement`, { skip: !port }, async () => fixture('transform', {}, async f => {
    const code = variant === 'cycle' ? 'GRAPH_INPUT_INVALID' : 'FLOW_UNIT_INVALID';
    const input = await f.input(1), before = Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_units'))[0].n);
    const driver = f.driverFor(f.db, (selected, unit, at) => { const transition = f.evaluateStep(selected, unit, at), output = transition.emissions[0].unit;
        if (variant === 'duplicate') output.members.push({ ...output.members[0] }); else if (variant === 'memberLimit') output.members = Array.from({ length: 10001 }, () => ({ ...output.members[0] })); else output.cycle = output; return transition; });
    assert.equal((await driver.tick(f.now)).code, code); assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_units'))[0].n), before);
    assert.equal((await f.query('SELECT payload_json FROM automation_flow_units WHERE id=?', [input.unit.id]))[0].payload_json, input.payload); assert.equal(await f.healthy(), 1);
}));

test('S7 matcher output outside its immutable eight-match shape is terminal while the legal sibling remains sendable', { skip: !port }, async () => fixture('dictionary', { fields: ['body'] }, async f => {
    await f.input(1);
    const driver = f.driverFor(f.db, (selected, unit, at) => stepNode(selected, unit, { now: at, dictionaries: { words: { match: () => Array.from({ length: 9 }, (_, index) => ({ term: 'sale', start: index, end: index + 1 })) } } }));
    assert.equal((await driver.tick(f.now)).code, 'GRAPH_MATCHER_INVALID'); assert.equal(await f.healthy(), 1);
}));

test('S7 failed failure-bookkeeping transaction rolls back all receipts, then lease-expiry restart terminalizes exactly once', { skip: !port }, async () => fixture('dictionary', { fields: ['body'] }, async f => {
    const input = await f.input(5000);
    const broken = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(transaction => work(async (sql, params) => { const result = await transaction(sql, params); if (sql.startsWith("UPDATE automation_flow_steps SET state='excluded',decision_json=COALESCE")) throw Object.assign(new Error('Injected failure settlement rollback'), { code: 'EIO' }); return result; })) };
    await assert.rejects(f.driverFor(broken).tick(f.now), { code: 'EIO' });
    assert.equal((await f.query('SELECT state FROM automation_flow_steps WHERE id=?', [input.stepId]))[0].state, 'leased');
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE receipt_kind='step_failed'"))[0].n), 0);
    assert.equal((await f.driverFor().tick(f.now + 120001)).state, 'failed'); assert.equal(await f.healthy(f.now + 120001), 1);
}));

test('S7 stale lease/version cannot terminalize a successor and concurrent current settlements remain idempotent', { skip: !port }, async () => fixture('transform', {}, async f => {
    await f.input(1); const stale = await f.store.claim(f.now), successor = await createGraphStore(f.db).claim(f.now + 120001), edges = f.plan.outgoing.get('poison');
    assert.equal((await f.store.failStep(stale, 'GRAPH_INPUT_LIMIT', edges, f.now + 120001)).state, 'lease_lost');
    assert.equal((await f.store.failStep({ ...successor, version: successor.version - 1 }, 'GRAPH_INPUT_LIMIT', edges, f.now + 120001)).state, 'lease_lost');
    const results = await Promise.all([f.store.failStep(successor, 'GRAPH_INPUT_LIMIT', edges, f.now + 120001), createGraphStore(f.db).failStep(successor, 'GRAPH_INPUT_LIMIT', edges, f.now + 120001)]);
    assert.deepEqual(results.map(row => row.state).sort(), ['already_settled','failed']);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE receipt_kind='step_failed'"))[0].n), 1); assert.equal(await f.healthy(f.now + 120001), 1);
}));

test('S7 an evaluator finishing after concurrent lease takeover cannot fail the successor activation', { skip: !port }, async () => fixture('transform', {}, async f => {
    const input = await f.input(1); let entered, resume;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; });
    const old = f.driverFor(f.db, async () => { entered(); await gate; throw Object.assign(new Error('Deterministic old evaluation limit'), { code: 'GRAPH_INPUT_LIMIT' }); }).tick(f.now);
    await started; const successor = await createGraphStore(f.db).claim(f.now + 120001); assert.equal(successor.id, input.stepId); resume();
    assert.equal((await old).state, 'lease_lost');
    const current = (await f.query('SELECT state,lease_token,version FROM automation_flow_steps WHERE id=?', [input.stepId]))[0]; assert.equal(current.state, 'leased'); assert.equal(current.lease_token, successor.lease_token); assert.equal(Number(current.version), successor.version);
    await assert.rejects(f.store.failStep(successor, 'UNVERIFIED_FAILURE', f.plan.outgoing.get('poison'), f.now + 120001), { code: 'FLOW_FAILURE_INVALID' });
    assert.equal((await f.store.failStep(successor, 'GRAPH_INPUT_LIMIT', f.plan.outgoing.get('poison'), f.now + 120001)).state, 'failed'); assert.equal(await f.healthy(f.now + 120001), 1);
}));

test('S7 transient evaluator failure remains leased and a later legitimate retry can deliver normally', { skip: !port }, async () => fixture('dictionary', { fields: ['body'] }, async f => {
    const input = await f.input(1); await assert.rejects(f.driverFor(f.db, () => { throw Object.assign(new Error('Temporary worker unavailable'), { code: 'DICTIONARY_UNAVAILABLE' }); }).tick(f.now), { code: 'DICTIONARY_UNAVAILABLE' });
    assert.equal((await f.query('SELECT state FROM automation_flow_steps WHERE id=?', [input.stepId]))[0].state, 'leased');
    assert.equal((await f.driverFor().tick(f.now + 120001)).state, 'complete'); assert.equal(await f.healthy(f.now + 120001), 1);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE receipt_kind='step_failed'"))[0].n), 0);
}));

test('S7 wait/prune history stays byte-identical and a later failure belongs only to the immutable continuation', { skip: !port }, async () => fixture('delay', { minutes: 1 }, async f => {
    const input = await f.input(1), waitingRun = randomUUID(), id = randomUUID();
    await f.query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,'private','auto',?,'{}','[]','flow_pending',?)", [waitingRun, hash(waitingRun), f.context.workflowId, owner, f.context.targetId, f.now]);
    await f.query('INSERT INTO automation_flow_runs(run_id,namespace_key,context_json) VALUES(?,?,?)', [waitingRun, f.namespace, JSON.stringify(f.context)]);
    const source = { id, kind: 'batch', ancestry: [], members: [{ ...input.unit.members[0], deadlineMs: f.now - 1 }, { ...input.unit.members[0], id: 'waiting', runId: waitingRun }] }, payload = JSON.stringify(source); copyData(source);
    await f.query('INSERT INTO automation_flow_units(id,namespace_key,kind,payload_json,checksum,created_at_ms) VALUES(?,?,?,?,?,?)', [id, f.namespace, source.kind, payload, hash(payload), f.now]);
    await f.query('INSERT INTO automation_flow_members(unit_id,member_id,run_id,ordinal) VALUES ?', [source.members.map((member, index) => [id, member.id, member.runId, index])]);
    await f.query('UPDATE automation_flow_steps SET input_unit_id=? WHERE id=?', [id, input.stepId]);
    assert.equal((await f.driver.tick(f.now)).state, 'pending');
    const pending = (await f.query('SELECT decision_json,continuation_unit_id FROM automation_flow_steps WHERE id=?', [input.stepId]))[0];
    assert.equal(await f.healthy(), 1, 'already-pruned lineage can complete its independent any-merge branch');
    const lease = await f.store.claim(f.now + 60000); assert.equal(lease.id, input.stepId); assert.deepEqual(lease.unit.members.map(member => member.runId), [waitingRun]);
    assert.equal((await f.store.failStep(lease, 'GRAPH_INPUT_LIMIT', f.plan.outgoing.get('poison'), f.now + 60000)).state, 'failed');
    assert.equal((await f.query('SELECT decision_json FROM automation_flow_steps WHERE id=?', [input.stepId]))[0].decision_json, pending.decision_json);
    const failed = await f.query("SELECT run_id,unit_id FROM automation_flow_edges WHERE receipt_kind='step_failed'"); assert.equal(failed.length, 1); assert.equal(failed[0].run_id, waitingRun); assert.equal(failed[0].unit_id, pending.continuation_unit_id);
    await require('../../src/automation/flow-history').refreshFlowHistory(f.query, [f.runId, waitingRun]);
    const history = await f.query('SELECT id,state,trace_json FROM automation_runs WHERE id IN (?)', [[f.runId, waitingRun]]), healthy = history.find(row => row.id === f.runId), terminal = history.find(row => row.id === waitingRun);
    assert.equal(healthy.state, 'partial'); assert(JSON.parse(healthy.trace_json).some(entry => entry.outcome === 'expired'));
    assert(!JSON.parse(healthy.trace_json).some(entry => entry.reason === 'GRAPH_INPUT_LIMIT'));
    assert.equal(terminal.state, 'failed'); assert(JSON.parse(terminal.trace_json).some(entry => entry.reason === 'GRAPH_INPUT_LIMIT'));
}));

test('S7 two individually legal wide arrivals terminalize a merge budget failure without blocking another execution', { skip: !port }, async () => fixture('delay', { minutes: 0 }, async f => {
    await f.input(95, { event: { providerId: 'github', title: 'member0', body: 'B'.repeat(65536), author: 'A'.repeat(4096), url: `https://github.com/${'u'.repeat(4000)}`, observedAtMs: f.now } });
    assert.equal((await f.driver.tick(f.now)).state, 'complete');
    const original = await f.query('SELECT id,checksum FROM automation_flow_units ORDER BY id');
    for (let tick = 0; tick < 8; tick++) await f.driverFor().tick(f.now + 1);
    const run = (await f.query('SELECT state,trace_json FROM automation_runs WHERE id=?', [f.runId]))[0]; assert.equal(run.state, 'failed'); assert(JSON.parse(run.trace_json).some(entry => entry.reason === 'GRAPH_INPUT_LIMIT'));
    const decision = (await f.query("SELECT state,decision_json FROM automation_flow_merge_decisions WHERE node_id='join'"))[0]; assert.equal(decision.state, 'excluded'); assert(Buffer.byteLength(decision.decision_json) < 4096);
    assert.deepEqual(await f.query('SELECT id,checksum FROM automation_flow_units WHERE id IN (?) ORDER BY id', [original.map(row => row.id)]), original);
    const other = randomUUID(); await f.query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,'private','auto',?,'{}','[]','flow_pending',?)", [other, hash(other), f.context.workflowId, owner, f.context.targetId, f.now]);
    await f.store.initialize({ runId: other, context: f.context, nodeId: 'send', now: f.now, unit: { kind: 'event', ancestry: [], members: [{ id: other, runId: other, event: { providerId: 'github', title: 'Next healthy', observedAtMs: f.now }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: f.now }] } });
    assert.equal(await f.healthy(), 1);
}));

test('S7 large unrelated batch peers are projected per lineage and a legal wide merge still succeeds', { skip: !port, timeout: 120000 }, async () => fixture('delay', { minutes: 0 }, async f => {
    await f.query('UPDATE automation_flow_runs SET needs_sync=0 WHERE run_id=?', [f.runId]);
    const origins = [];
    for (let index = 0; index < 95; index++) {
        const runId = randomUUID(), event = { providerId: 'github', title: 'member0', body: 'B'.repeat(65536), author: 'A'.repeat(4096), url: `https://github.com/${'u'.repeat(4000)}`, observedAtMs: f.now }; origins.push(runId);
        await f.query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,'private','auto',?,?,'[]','flow_pending',?)", [runId, hash(runId), f.context.workflowId, owner, f.context.targetId, JSON.stringify(event), f.now]);
        await f.store.initialize({ runId, context: f.context, nodeId: 'batch', now: f.now, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: f.now, baseTimeMs: f.now }] } });
    }
    for (let tick = 0; tick < 95; tick++) await f.driver.tick(f.now);
    assert.equal((await f.driver.tick(f.now + 60000)).state, 'sealed');
    for (let tick = 0; tick < 12; tick++) await f.driver.tick(f.now + 60000);
    const decisions = await f.query("SELECT state,decision_json FROM automation_flow_merge_decisions WHERE node_id='join'"); assert.equal(decisions.length, 95); assert(decisions.every(row => row.state === 'emitted' && !JSON.parse(row.decision_json).terminalFailure));
    const send = (await f.query('SELECT unit_id FROM automation_flow_sends'))[0]; assert(send); const output = await f.store.readUnit(send.unit_id); copyData(output);
    assert.deepEqual(new Set(output.members.map(member => member.runId)), new Set(origins)); assert.equal(output.members.length, 95);
}, 'fork'));

test('S7 merge output savepoint removes partial unit writes before recording a bounded group failure', { skip: !port }, async () => fixture('delay', { minutes: 0 }, async f => {
    await f.input(1); await f.driver.tick(f.now); let injected = false;
    const broken = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(transaction => work(async (sql, params) => {
        const result = await transaction(sql, params);
        if (!injected && sql.startsWith('INSERT INTO automation_flow_units') && String(params[3]).includes('"mergeNodeId":"join"')) { injected = true; throw Object.assign(new Error('Injected post-write materialization guard'), { code: 'FLOW_SNAPSHOT_LIMIT' }); }
        return result;
    })) };
    for (let tick = 0; tick < 8; tick++) await f.driverFor(broken).tick(f.now + 1); assert.equal(injected, true);
    const decision = (await f.query("SELECT state,decision_json FROM automation_flow_merge_decisions WHERE node_id='join'"))[0]; assert.equal(decision.state, 'excluded'); assert.equal(JSON.parse(decision.decision_json).code, 'FLOW_SNAPSHOT_LIMIT');
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_units WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.mergeNodeId'))='join'"))[0].n), 0);
    const run = (await f.query('SELECT state,trace_json FROM automation_runs WHERE id=?', [f.runId]))[0]; assert.equal(run.state, 'failed'); assert(JSON.parse(run.trace_json).some(entry => entry.reason === 'FLOW_SNAPSHOT_LIMIT'));
}));

test('S7 merge failure bookkeeping DB error rolls back and restart preserves the exact original arrivals', { skip: !port }, async () => fixture('delay', { minutes: 0 }, async f => {
    await f.input(95, { event: { providerId: 'github', title: 'member0', body: 'B'.repeat(65536), author: 'A'.repeat(4096), url: `https://github.com/${'u'.repeat(4000)}`, observedAtMs: f.now } });
    await f.driver.tick(f.now); let injected = false;
    const broken = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(transaction => work(async (sql, params) => {
        const result = await transaction(sql, params); if (!injected && sql.startsWith('INSERT INTO automation_flow_merge_decisions') && params[3] === 'excluded') { injected = true; throw Object.assign(new Error('Injected merge decision DB failure'), { code: 'EIO' }); } return result;
    })) };
    await assert.rejects(async () => { for (let tick = 0; tick < 8; tick++) await f.driverFor(broken).tick(f.now + 1); }, { code: 'EIO' }); assert.equal(injected, true);
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_merge_decisions'))[0].n), 0);
    for (let tick = 0; tick < 8; tick++) await f.driverFor().tick(f.now + 1);
    const decision = (await f.query("SELECT state,decision_json FROM automation_flow_merge_decisions WHERE node_id='join'"))[0]; assert.equal(decision.state, 'excluded'); assert.equal(JSON.parse(decision.decision_json).code, 'GRAPH_INPUT_LIMIT');
    assert.equal((await f.query('SELECT revoked_at_ms FROM automation_flow_runs WHERE run_id=?', [f.runId]))[0].revoked_at_ms, null);
}));
