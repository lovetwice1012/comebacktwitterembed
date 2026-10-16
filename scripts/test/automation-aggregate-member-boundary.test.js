'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue, targetIdentity } = require('../../src/automation/queue');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createRunner } = require('../../src/automation/runtime');
const { createHistory } = require('../../src/automation/history');
const { createGraphStore, namespaceKey } = require('../../src/automation/graph-store');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const { compileWorkflow, copyData } = require('../../src/automation/graph-plan');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

for (const { groupSize, prune } of [{ groupSize: 200 }, { groupSize: 1000 }, { groupSize: 1000, prune: true }]) test(`S7-1 accepted 100/${groupSize / 100}/100 aggregate handles ${51 * groupSize} ${prune ? 'mostly expired' : 'oversized'} members without starving healthy work`, { skip: !port, timeout: 60000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const query = db.queryDatabase, service = createService(db), owner = '222222222222222222', now = Date.now(), actor = { userId: owner };
        await grantTestDonor(db, owner);
        const destination = await service.saveDestination(actor, { name: 'Healthy branch DM', kind: 'dm' });
        const monitor = await createMonitors(db, service, {}).save(actor, 'auto', { name: 'Healthy monitor', providerId: 'github', source: 'octocat', destinationId: destination.id });
        const definition = newWorkflow('Membership boundary');
        const stages = [100, groupSize / 100, 100].map((maxItems, index) => ({ id: `batch${index}`, type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, minutes: index + 1, maxItems } }));
        definition.nodes.splice(1, 0, ...stages); const path = ['start', ...stages.map(stage => stage.id), 'send'];
        definition.edges = path.slice(1).map((target, index) => ({ id: `edge${index}`, source: path[index], target, port: 'out' }));
        definition.edges.push({ id: 'healthy-branch', source: 'start', target: 'send', port: 'out' });
        const plan = compileWorkflow(definition); assert.deepEqual(stages.map(stage => plan.byId.get(stage.id).config.maxItems), [100, groupSize / 100, 100]);
        const rule = await service.createWorkflow(actor, { definition }); await service.activateWorkflow(actor, rule.id, { expectedRevision: 1 }); await service.attach(actor, rule.id, 'auto', monitor.id);
        const target = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [monitor.id]))[0];
        const context = { ownerUserId: owner, scope: 'private', workflowId: rule.id, revision: 1, targetKind: 'auto', targetId: monitor.id, monitorRevision: 2,
            targetIdentity: targetIdentity(target), destinationId: destination.id, bindings: {}, sourceContext: { destinationType: 'dm' } }, namespace = namespaceKey(context), runId = randomUUID(), failedRunId = randomUUID();
        for (const id of [runId, failedRunId]) {
            await query("INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,1,?,'private','auto',?,'{}','[]','flow_pending',?)", [id, hash(id), rule.id, owner, monitor.id, now]);
            await query('INSERT INTO automation_flow_runs (run_id,namespace_key,context_json) VALUES (?,?,?)', [id, namespace, JSON.stringify(context)]);
        }
        const batch = randomUUID(), healthyBatch = randomUUID(), inputs = [], units = [], steps = [], memberships = [];
        // Persist bounded outputs of the first two accepted stages in bulk;
        // this skips thousands of unrelated source admissions, not validation.
        // Each prior unit is exactly 100*2 members; the final 51-unit aggregate
        // legitimately exceeds the materialization cap despite maxItems=100.
        for (let index = 0; index < 52; index++) {
            const id = randomUUID(), activation = randomUUID(), members = Array.from({ length: index < 51 ? groupSize : 1 }, (_unused, ordinal) => ({ id: `m${index}_${ordinal}`, runId: index === 0 && ordinal === 0 ? failedRunId : runId, event: {}, dueAtMs: now,
                ...(prune && index < 51 && !(index === 50 && ordinal === groupSize - 1) ? { deadlineMs: now - 1 } : {}) }));
            const unit = { id, kind: 'batch', ancestry: [], members }; copyData(unit);
            const payload = JSON.stringify(unit); units.push([id, namespace, 'batch', payload, hash(payload), now]);
            steps.push([activation, hash(activation), namespace, 'batch2', id, 'aggregating', now, now, now]);
            inputs.push([index < 51 ? batch : healthyBatch, index < 51 ? index : 0, hash(activation), activation, id, now]);
            memberships.push(...members.map((member, ordinal) => [id, member.id, member.runId, ordinal]));
        }
        await query('INSERT INTO automation_flow_units (id,namespace_key,kind,payload_json,checksum,created_at_ms) VALUES ?', [units]);
        await query('INSERT INTO automation_flow_members (unit_id,member_id,run_id,ordinal) VALUES ?', [memberships]);
        await query('INSERT INTO automation_flow_steps (id,activation_key,namespace_key,node_id,input_unit_id,state,wake_at_ms,created_at_ms,updated_at_ms) VALUES ?', [steps]);
        for (const [id, due, count] of [[batch, now - 1, 51], [healthyBatch, now, 1]]) await query("INSERT INTO automation_flow_batches (id,namespace_key,group_key,segment,node_id,key_json,window_start_ms,closes_at_ms,max_items,mode,received_count,created_at_ms,updated_at_ms) VALUES (?,?,?,0,'batch2','[]',?,?,100,'all',?,?,?)", [id, namespace, hash(id), now - 180000, due, count, now - 180000, now]);
        await query('INSERT INTO automation_flow_batch_inputs (batch_id,ordinal,admission_key,activation_id,input_unit_id,created_at_ms) VALUES ?', [inputs]);
        const original = await query('SELECT id,payload_json,checksum FROM automation_flow_units ORDER BY id'), store = createGraphStore(db);
        const oldest = await store.dueBatch(now); assert.equal(oldest.id, batch);
        const broken = createGraphStore({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(transaction => work(async (sql, params) => { const result = await transaction(sql, params); if (sql.startsWith('UPDATE automation_flow_batches SET state=')) throw new Error('Injected batch bookkeeping rollback'); return result; })) });
        await assert.rejects(broken.closeBatch(oldest, [], now), /bookkeeping rollback/);
        assert.equal((await query('SELECT state FROM automation_flow_batches WHERE id=?', [batch]))[0].state, 'open');
        assert.equal(Number((await query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE receipt_kind LIKE 'batch_%'"))[0].n), 0);
        const outcome = await store.closeBatch(oldest, [], now);
        assert.equal(outcome.state, prune ? 'sealed' : 'failed'); assert.equal(outcome.outcome.code, prune ? undefined : 'FLOW_UNIT_INVALID'); assert.equal(outcome.outcome.selectedMembers, prune ? 1 : 51 * groupSize);
        assert.equal(outcome.outcome.excludedCount, prune ? 51 * groupSize - 1 : 51 * groupSize);
        assert.equal(outcome.outcome.excluded, undefined); assert.equal(outcome.outcome.runIds, undefined); assert(Buffer.byteLength(JSON.stringify(outcome.outcome)) < 2048); assert(outcome.syncRunIds.length <= 1000);
        assert.equal(Number((await query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE receipt_kind LIKE 'batch_%'"))[0].n), outcome.outcome.excludedCount);
        const next = await store.dueBatch(now); assert.equal(next.id, healthyBatch);
        const healthy = await store.closeBatch(next, [], now); assert.equal(healthy.state, 'sealed'); assert.equal((await store.readUnit(healthy.unitId)).members.length, 1);
        assert.equal(await store.dueBatch(now), null); assert.equal((await store.closeBatch(oldest, [], now)).state, 'already_sealed');
        assert.deepEqual(await query('SELECT id,payload_json,checksum FROM automation_flow_units WHERE id IN (?) ORDER BY id', [original.map(row => row.id)]), original);
        assert.equal(Number((await query('SELECT COUNT(*) AS n FROM automation_flow_batch_inputs'))[0].n), 52);
        assert.equal(Number((await query("SELECT COUNT(*) AS n FROM automation_flow_steps WHERE state='aggregating'"))[0].n), 0);
        // A sibling branch of the SAME original run still reaches a real
        // projected job and fake transport. Failure never revokes the run.
        await store.initialize({ runId, context, nodeId: 'send', now, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId,
            event: { providerId: 'github', title: 'Healthy sibling', url: 'https://github.com/octocat/test', observedAtMs: now }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: now }] } });
        const flow = createFlowRuntime(db, {}, createGraphStore(db), { assertEnabled: () => {} });
        try { for (let tick = 0; tick < 12; tick++) await flow.tick(now); } finally { flow.clear(); }
        let clock = now, sent = 0; const queue = createQueue(db, {}, { clock: () => clock });
        const transport = { readiness: () => true, prepare: async () => ({ payloads: [{}] }), sendStep: async () => { sent++; return '777777777777777777'; } };
        for (let tick = 0; tick < 8 && !sent; tick++) await createRunner(db, queue, transport, { clock: () => clock, sleep: async ms => { clock += ms; }, assertAllowed: () => {} }).tick();
        assert.equal(sent, 1);
        await require('../../src/automation/flow-history').refreshFlowHistory(query, [runId, failedRunId]);
        const history = await query('SELECT id,state,trace_json FROM automation_runs WHERE id IN (?)', [[runId, failedRunId]]);
        assert.equal(history.find(row => row.id === runId).state, 'sent'); assert.equal(history.find(row => row.id === failedRunId).state, prune ? 'expired' : 'failed');
        assert(history.every(row => JSON.parse(row.trace_json).some(entry => entry.reason === (prune ? 'DEADLINE_EXCEEDED' : 'FLOW_UNIT_INVALID'))));
        assert((await query('SELECT revoked_at_ms FROM automation_flow_runs')).every(row => row.revoked_at_ms === null));
        const page = await createHistory(db, service).excluded(actor); assert(page.items.some(item => item.id === failedRunId)); assert(!page.items.some(item => item.id === runId));
        assert.equal((await createGraphStore(db).closeBatch(oldest, [], now)).state, 'already_sealed');
    } finally { await db.close(); }
});
