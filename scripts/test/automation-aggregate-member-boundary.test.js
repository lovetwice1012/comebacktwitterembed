'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createGraphStore, namespaceKey } = require('../../src/automation/graph-store');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const { compileWorkflow, copyData } = require('../../src/automation/graph-plan');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('S7-1 accepted 100/2/100 aggregate chain terminalizes 10200 members without starving a healthy batch', { skip: !port, timeout: 30000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        const query = db.queryDatabase, service = createService(db), owner = '222222222222222222', now = Date.now();
        const definition = newWorkflow('Membership boundary');
        const stages = [100, 2, 100].map((maxItems, index) => ({ id: `batch${index}`, type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, minutes: index + 1, maxItems } }));
        definition.nodes.splice(1, 0, ...stages); const path = ['start', ...stages.map(stage => stage.id), 'send'];
        definition.edges = path.slice(1).map((target, index) => ({ id: `edge${index}`, source: path[index], target, port: 'out' }));
        const plan = compileWorkflow(definition); assert.deepEqual(stages.map(stage => plan.byId.get(stage.id).config.maxItems), [100, 2, 100]);
        const rule = await service.createWorkflow({ userId: owner }, { definition });
        const context = { ownerUserId: owner, scope: 'private', workflowId: rule.id, revision: 1 }, namespace = namespaceKey(context), runId = randomUUID();
        await query("INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,1,?,'private','auto',1,'{}','[]','flow_pending',?)", [runId, hash(runId), rule.id, owner, now]);
        await query('INSERT INTO automation_flow_runs (run_id,namespace_key,context_json) VALUES (?,?,?)', [runId, namespace, JSON.stringify(context)]);
        const batch = randomUUID(), healthyBatch = randomUUID(), inputs = [], units = [], steps = [], memberships = [];
        // Persist bounded outputs of the first two accepted stages in bulk;
        // this skips thousands of unrelated source admissions, not validation.
        // Each prior unit is exactly 100*2 members; the final 51-unit aggregate
        // legitimately exceeds the materialization cap despite maxItems=100.
        for (let index = 0; index < 52; index++) {
            const id = randomUUID(), activation = randomUUID(), members = Array.from({ length: index < 51 ? 200 : 1 }, (_unused, ordinal) => ({ id: `m${index}_${ordinal}`, runId, event: {}, dueAtMs: now }));
            const unit = { id, kind: 'batch', ancestry: [], members }; copyData(unit);
            const payload = JSON.stringify(unit); units.push([id, namespace, 'batch', payload, hash(payload), now]);
            steps.push([activation, hash(activation), namespace, 'batch2', id, 'aggregating', now, now, now]);
            inputs.push([index < 51 ? batch : healthyBatch, index < 51 ? index : 0, hash(activation), activation, id, now]);
            memberships.push(...members.map((member, ordinal) => [id, member.id, runId, ordinal]));
        }
        await query('INSERT INTO automation_flow_units (id,namespace_key,kind,payload_json,checksum,created_at_ms) VALUES ?', [units]);
        await query('INSERT INTO automation_flow_members (unit_id,member_id,run_id,ordinal) VALUES ?', [memberships]);
        await query('INSERT INTO automation_flow_steps (id,activation_key,namespace_key,node_id,input_unit_id,state,wake_at_ms,created_at_ms,updated_at_ms) VALUES ?', [steps]);
        for (const [id, due, count] of [[batch, now - 1, 51], [healthyBatch, now, 1]]) await query("INSERT INTO automation_flow_batches (id,namespace_key,group_key,segment,node_id,key_json,window_start_ms,closes_at_ms,max_items,mode,received_count,created_at_ms,updated_at_ms) VALUES (?,?,?,0,'batch2','[]',?,?,100,'all',?,?,?)", [id, namespace, hash(id), now - 180000, due, count, now - 180000, now]);
        await query('INSERT INTO automation_flow_batch_inputs (batch_id,ordinal,admission_key,activation_id,input_unit_id,created_at_ms) VALUES ?', [inputs]);
        const original = await query('SELECT id,payload_json,checksum FROM automation_flow_units ORDER BY id'), store = createGraphStore(db);
        const oldest = await store.dueBatch(now); assert.equal(oldest.id, batch);
        const outcome = await store.closeBatch(oldest, [], now);
        assert.equal(outcome.state, 'failed'); assert.equal(outcome.outcome.code, 'FLOW_UNIT_INVALID'); assert.equal(outcome.outcome.selectedMembers, 10200); assert.equal(outcome.outcome.excluded.length, 10200); assert.equal(outcome.unitId, null);
        const next = await store.dueBatch(now); assert.equal(next.id, healthyBatch);
        const healthy = await store.closeBatch(next, [], now); assert.equal(healthy.state, 'sealed'); assert.equal((await store.readUnit(healthy.unitId)).members.length, 1);
        assert.equal(await store.dueBatch(now), null); assert.equal((await store.closeBatch(oldest, [], now)).state, 'already_sealed');
        assert.deepEqual(await query('SELECT id,payload_json,checksum FROM automation_flow_units WHERE id IN (?) ORDER BY id', [original.map(row => row.id)]), original);
        assert.equal(Number((await query('SELECT COUNT(*) AS n FROM automation_flow_batch_inputs'))[0].n), 52);
        assert.equal(Number((await query("SELECT COUNT(*) AS n FROM automation_flow_steps WHERE state='aggregating'"))[0].n), 0);
    } finally { await db.close(); }
});
