'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const { createGraphStore, namespaceKey } = require('../../src/automation/graph-store');
const { uuid } = require('../../src/automation/graph-store');
const { compileWorkflow } = require('../../src/automation/graph-plan');
const { splitSqlStatements, shouldSkipMigrationStatement } = require('../../src/db_schema')._internal;
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), baseTime = Date.parse('2026-09-22T10:00:00Z');
async function fixture(work) {
    const db = await createTestDatabase(port), query = db.queryDatabase;
    const actor = { userId: '222222222222222222' }, service = createService(db);
    const workflow = await service.createWorkflow(actor, { definition: newWorkflow('flow fixture') });
    const context = { ownerUserId: actor.userId, guildId: null, scope: 'private', workflowId: workflow.id, revision: 1 };
    async function origin(title = 'event', patch = {}) {
        const runId = randomUUID(), ctx = { ...context, ...patch };
        await query("INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,guild_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,'auto',1,?,'[]','queued',?)", [runId, hash(runId), ctx.workflowId, ctx.revision, ctx.ownerUserId, ctx.guildId, ctx.scope, JSON.stringify({ title }), baseTime]);
        return { runId, context: ctx, nodeId: 'gate', now: baseTime, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event: { title }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: baseTime, deadlineMs: null }] } };
    }
    try { await work({ db, query, context, origin, store: createGraphStore(db) }); }
    finally { await db.close(); }
}
const gate = { count: 1, minutes: 10, overflow: 'defer', key: ['all'] };
const output = step => ({ gate, outputs: [{ unit: step.unit, edges: [{ id: 'a', target: 'sendA' }, { id: 'b', target: 'sendB' }] }] });
test('flow namespace separates owners/scopes/revisions but ignores incidental private origin guilds', () => {
    const context = { ownerUserId: '1', scope: 'private', workflowId: 'rule', revision: 1 };
    assert.equal(namespaceKey(context), namespaceKey({ ...context, guildId: '2' }));
    assert.notEqual(namespaceKey(context), namespaceKey({ ...context, ownerUserId: '2' }));
    assert.notEqual(namespaceKey(context), namespaceKey({ ...context, revision: 2 }));
    assert.notEqual(namespaceKey(context), namespaceKey({ ...context, scope: 'guild', guildId: '2' }));
});
test('flow activation consumes once before fanout and committed recovery emits no duplicate successors', { skip: !port }, async () => fixture(async f => {
    const first = await f.origin(); await f.store.initialize(first); await f.store.initialize(first);
    const step = await f.store.claim(baseTime); assert.equal(step.node_id, 'gate');
    const settled = await f.store.settle(step, output(step), baseTime);
    assert.equal(settled.state, 'complete'); assert.equal(settled.emitted[0].stepIds.length, 2);
    const restarted = createGraphStore(f.db);
    assert.equal((await restarted.settle(step, output(step), baseTime)).state, 'already_settled');
    assert.equal(Number((await f.query('SELECT SUM(used_count) AS n FROM automation_counters'))[0].n), 1);
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_steps'))[0].n), 3);
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_edges'))[0].n), 2);
}));
test('failure after quota increment rolls back quota, output units, edge receipts and step outcome together', { skip: !port }, async () => fixture(async f => {
    await f.store.initialize(await f.origin()); const step = await f.store.claim(baseTime);
    const broken = createGraphStore({ ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, args) => {
        const value = await query(sql, args);
        if (sql.startsWith('UPDATE automation_counters SET used_count')) throw new Error('injected rollback');
        return value;
    })) });
    await assert.rejects(broken.settle(step, output(step), baseTime), /injected rollback/);
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_counters'))[0].n), 0);
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_flow_units'))[0].n), 1);
    assert.equal((await f.query('SELECT state FROM automation_flow_steps'))[0].state, 'leased');
    assert.equal((await f.store.settle(step, output(step), baseTime)).state, 'complete');
}));
test('a reclaimed graph lease keeps decision time but rejects the old worker fencing token', { skip: !port }, async () => fixture(async f => {
    await f.store.initialize(await f.origin()); const stale = await f.store.claim(baseTime);
    const restarted = createGraphStore(f.db), fresh = await restarted.claim(baseTime + 120001);
    assert.equal(fresh.evaluation_at_ms, baseTime); assert.notEqual(fresh.lease_token, stale.lease_token);
    assert.equal((await f.store.settle(stale, output(stale), baseTime + 120001)).state, 'lease_lost');
    assert.equal((await restarted.settle(fresh, output(fresh), baseTime + 120001)).state, 'complete');
}));
test('defer preserves the pending activation without successors or consumption until the next window', { skip: !port }, async () => fixture(async f => {
    await f.store.initialize(await f.origin('first')); let step = await f.store.claim(baseTime);
    await f.store.settle(step, { gate }, baseTime);
    await f.store.initialize(await f.origin('second')); step = await f.store.claim(baseTime);
    const pending = await f.store.settle(step, output(step), baseTime);
    assert.equal(pending.state, 'pending'); assert.equal(pending.wakeAtMs, baseTime + 600000);
    assert.equal(await f.store.claim(baseTime + 599999), null);
    const next = await createGraphStore(f.db).claim(baseTime + 600000);
    assert.equal(next.evaluation_at_ms, baseTime + 600000);
    assert.equal((await f.store.settle(next, output(next), baseTime + 600000)).state, 'complete');
    assert.deepEqual((await f.query('SELECT used_count FROM automation_counters ORDER BY expires_at_ms')).map(row => Number(row.used_count)), [1, 1]);
}));
test('drop closes an absent path durably and does not spend another quota unit', { skip: !port }, async () => fixture(async f => {
    await f.store.initialize(await f.origin()); let step = await f.store.claim(baseTime); await f.store.settle(step, { gate }, baseTime);
    const other = await f.origin(); await f.store.initialize(other); step = await f.store.claim(baseTime);
    const dropped = await f.store.settle(step, { ...output(step), gate: { ...gate, overflow: 'drop' }, closedEdges: [{ runId: other.runId, edgeId: 'a' }, { runId: other.runId, edgeId: 'b' }] }, baseTime);
    assert.equal(dropped.state, 'excluded');
    assert.equal(Number((await f.query('SELECT SUM(used_count) AS n FROM automation_counters'))[0].n), 1);
    const receipts = await f.query('SELECT receipt_kind,unit_id FROM automation_flow_edges');
    assert.equal(receipts.length, 2); assert(receipts.every(row => row.receipt_kind === 'closed' && row.unit_id === null));
}));
test('revoked members cannot pass a stale activation or silently change an immutable source unit', { skip: !port }, async () => fixture(async f => {
    const original = await f.origin(); const initialized = await f.store.initialize(original);
    const changed = structuredClone(original); changed.unit.members[0].event.title = 'changed';
    await assert.rejects(f.store.initialize(changed), { code: 'FLOW_UNIT_CONFLICT' });
    const step = await f.store.claim(baseTime); await f.store.revokeRun(original.runId, 'MONITOR_CHANGED', baseTime + 1);
    assert.equal((await f.store.settle(step, output(step), baseTime + 2)).state, 'excluded');
    assert.equal((await f.store.readUnit(initialized.unitId)).members.length, 1);
    assert.equal((await f.store.readUnit(initialized.unitId, true)).members.length, 0);
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_counters'))[0].n), 0);
}));
test('flow migration is additive, idempotent and identical to new-schema declarations', { skip: !port }, async () => fixture(async f => {
    const source = fs.readFileSync(path.join(__dirname, '../../migrations/20260922_add_automation_flow_execution.sql'), 'utf8');
    const statements = splitSqlStatements(source);
    assert.equal(statements.length, require('../../src/automation/graph-schema.sql').SCHEMA.length + 1);
    const normalize = sql => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    assert.match(normalize(statements[0]), /^ALTER TABLE automation_jobs ADD COLUMN execution_version/);
    assert.deepEqual(statements.slice(1).map(normalize), require('../../src/automation/graph-schema.sql').SCHEMA.map(normalize));
    for (let pass = 0; pass < 2; pass++) for (const sql of statements) if (!await shouldSkipMigrationStatement(f.query, sql)) await f.query(sql);
    const item = await f.origin(); await f.store.initialize(item);
    assert.equal((await f.query('SELECT owner_user_id FROM automation_runs WHERE id=?', [item.runId]))[0].owner_user_id, f.context.ownerUserId);
}));
const batchConfig = { minutes: 10, maxItems: 2, mode: 'all' };
async function batchInput(f, title, patch = {}, config = batchConfig) {
    const origin = await f.origin(title, patch); origin.nodeId = 'batchA';
    await f.store.initialize(origin); const step = await f.store.claim(baseTime);
    const admitted = await f.store.admitBatch(step, config, [{ key: ['all'], unit: step.unit }], baseTime);
    return { origin, step, admitted };
}
test('cross-monitor candidates share one batch within the owner namespace and selective revocation retains the other origin', { skip: !port }, async () => fixture(async f => {
    const first = await batchInput(f, 'first', { guildId: '111111111111111111' });
    const second = await batchInput(f, 'second', { guildId: '333333333333333333' });
    assert.equal(first.admitted.batches[0], second.admitted.batches[0]);
    const otherOwner = await batchInput(f, 'other owner', { ownerUserId: '444444444444444444' });
    assert.notEqual(first.admitted.batches[0], otherOwner.admitted.batches[0]);
    await f.store.revokeRun(first.origin.runId, 'MONITOR_CHANGED', baseTime + 1);
    const batch = (await f.query('SELECT * FROM automation_flow_batches WHERE id=?', [first.admitted.batches[0]]))[0];
    const closed = await f.store.closeBatch(batch, [{ id: 'out', target: 'send' }], baseTime + 600000);
    assert.equal(closed.outcome.receivedCount, 2); assert.equal(closed.outcome.retainedMembers, 1);
    assert.equal(closed.outcome.excluded[0].runId, first.origin.runId);
    const unit = await f.store.readUnit(closed.unitId); assert.equal(unit.members[0].event.title, 'second');
    assert.equal((await createGraphStore(f.db).closeBatch(batch, [{ id: 'out', target: 'send' }], baseTime + 600000)).state, 'already_sealed');
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_steps WHERE node_id='send'"))[0].n), 1);
}));
test('multiple aggregate stages retain their input units and intervening quota counts batches, not leaf events', { skip: !port }, async () => fixture(async f => {
    await batchInput(f, 'one'); await batchInput(f, 'two');
    const first = await f.store.dueBatch(baseTime + 600000);
    assert.equal(await f.store.dueBatch(baseTime + 599999), null);
    const sealedA = await f.store.closeBatch(first, [{ id: 'toGate', target: 'gate' }], baseTime + 600000);
    let step = await createGraphStore(f.db).claim(baseTime + 600000);
    assert.equal(step.unit.members.length, 2);
    await f.store.settle(step, { gate, outputs: [{ unit: step.unit, edges: [{ id: 'toBatchB', target: 'batchB' }] }] }, baseTime + 600000);
    assert.equal(Number((await f.query('SELECT SUM(used_count) AS n FROM automation_counters'))[0].n), 1);
    step = await f.store.claim(baseTime + 600000);
    await f.store.admitBatch(step, { ...batchConfig, minutes: 20 }, [{ key: ['all'], unit: step.unit }], baseTime + 600000);
    const second = await f.store.dueBatch(baseTime + 1200000);
    const sealedB = await f.store.closeBatch(second, [{ id: 'sendA', target: 'sendA' }, { id: 'sendB', target: 'sendB' }], baseTime + 1200000);
    const unit = await f.store.readUnit(sealedB.unitId);
    assert.equal(unit.receivedCount, 1); assert.equal(unit.members.length, 2);
    assert.deepEqual(unit.ancestry.map(item => item.batchId), [first.id, second.id]);
    const input = await f.store.readUnit(unit.batchInputs[0].unitId);
    assert.equal(input.ancestry[0].batchId, first.id); assert.equal(input.members.length, 2);
    assert.equal(sealedB.stepIds.length, 2); assert.notEqual(sealedA.unitId, sealedB.unitId);
}));
test('batch capacity counts incoming units, concurrent workers cannot double-admit, and segments each seal once', { skip: !port }, async () => fixture(async f => {
    for (let i = 0; i < 3; i++) await batchInput(f, `item${i}`);
    const origin = await f.origin('concurrent'); origin.nodeId = 'batchA'; await f.store.initialize(origin);
    const step = await f.store.claim(baseTime), groups = [{ key: ['all'], unit: step.unit }];
    const outcomes = await Promise.all([f.store.admitBatch(step, batchConfig, groups, baseTime), createGraphStore(f.db).admitBatch(step, batchConfig, groups, baseTime)]);
    assert.deepEqual(outcomes.map(item => item.state).sort(), ['aggregating', 'already_settled']);
    const batches = await f.query('SELECT * FROM automation_flow_batches ORDER BY segment');
    assert.deepEqual(batches.map(row => Number(row.received_count)), [2, 2]);
    for (const batch of batches) {
        const results = await Promise.all([f.store.closeBatch(batch, [{ id: 'out', target: 'send' }], baseTime + 600000), createGraphStore(f.db).closeBatch(batch, [{ id: 'out', target: 'send' }], baseTime + 600000)]);
        assert.deepEqual(results.map(item => item.state).sort(), ['already_sealed', 'sealed']);
    }
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_steps WHERE node_id='send'"))[0].n), 2);
}));
test('latest selects the latest eligible input at closure but never resurrects superseded input after sealing', { skip: !port }, async () => fixture(async f => {
    const config = { ...batchConfig, mode: 'latest', maxItems: 10 };
    const first = await batchInput(f, 'first', {}, config), second = await batchInput(f, 'second', {}, config), third = await batchInput(f, 'third', {}, config);
    await f.store.revokeRun(third.origin.runId, 'MONITOR_CHANGED', baseTime + 1);
    const batch = await f.store.dueBatch(baseTime + 600000), closed = await f.store.closeBatch(batch, [], baseTime + 600000);
    assert.equal(closed.outcome.receivedCount, 3); assert.equal(closed.outcome.supersededInputs.length, 1);
    assert.equal((await f.store.readUnit(closed.unitId)).members[0].event.title, 'second');
    await f.store.revokeRun(second.origin.runId, 'MONITOR_CHANGED', baseTime + 600001);
    assert.equal((await f.store.readUnit(closed.unitId, true)).members.length, 0);
    assert.equal((await f.query('SELECT revoked_at_ms FROM automation_flow_runs WHERE run_id=?', [first.origin.runId]))[0].revoked_at_ms, null);
}));
test('temporal continuation retains a frozen horizon across restart without mutating the original input', { skip: !port }, async () => fixture(async f => {
    const origin = await f.origin(), initialized = await f.store.initialize(origin), step = await f.store.claim(baseTime);
    const continuation = structuredClone(step.unit); continuation.members[0].scheduleDeadlineMs = baseTime + 86400000;
    continuation.members[0].dueAtMs = baseTime + 600000;
    await f.store.settle(step, { state: 'wait', continuation, wakeAtMs: baseTime + 600000 }, baseTime);
    await f.store.initialize(origin);
    const resumed = await createGraphStore(f.db).claim(baseTime + 600000);
    assert.equal(resumed.unit.members[0].scheduleDeadlineMs, baseTime + 86400000);
    assert.equal(resumed.unit.members[0].dueAtMs, baseTime + 600000);
    assert.equal((await f.store.readUnit(initialized.unitId)).members[0].scheduleDeadlineMs, undefined);
}));
function joinPlan(mode) {
    const workflow = newWorkflow();
    workflow.nodes.splice(1, 0, { id: 'gate', type: 'limit', config: { ...NODE_TYPES.limit.defaults, ...gate } }, { id: 'join', type: 'merge', config: { mode, displayConflict: 'stop' } });
    workflow.nodes.find(node => node.id === 'gate').config.key = 'all';
    workflow.edges = [
        { id: 'startGate', source: 'start', target: 'gate', port: 'out' }, { id: 'left', source: 'start', target: 'join', port: 'out' },
        { id: 'right', source: 'gate', target: 'join', port: 'out' }, { id: 'joined', source: 'join', target: 'send', port: 'out' },
    ];
    return compileWorkflow(workflow);
}
test('durable joins distinguish a dropped branch from a deferred branch, including restart before closure', { skip: !port }, async t => {
    for (const mode of ['any', 'all']) for (const overflow of ['drop', 'defer']) await t.test(`${mode}/${overflow}`, async () => fixture(async f => {
        await f.store.initialize(await f.origin('consume quota')); let step = await f.store.claim(baseTime);
        await f.store.settle(step, { gate }, baseTime);
        const origin = await f.origin('join event'); origin.nodeId = 'start';
        const initialized = await f.store.initialize(origin), plan = joinPlan(mode);
        step = await f.store.claim(baseTime);
        await f.store.settle(step, { outputs: [{ unit: step.unit, edges: plan.outgoing.get('start') }] }, baseTime);
        let gateStep = null;
        for (let i = 0; i < 2; i++) {
            const candidate = await f.store.claim(baseTime);
            if (candidate.node_id === 'join') await f.store.parkMerge(candidate, baseTime);
            else { gateStep = candidate; break; }
        }
        assert(gateStep);
        await f.store.settle(gateStep, { gate: { ...gate, overflow }, outputs: [{ unit: gateStep.unit, edges: plan.outgoing.get('gate') }] }, baseTime);
        let store = createGraphStore(f.db);
        await store.synchronize(initialized.namespace, plan, [origin.runId], baseTime);
        let outputs = await f.query("SELECT * FROM automation_flow_steps WHERE node_id='send'");
        if (overflow === 'defer') {
            assert.equal(outputs.length, 0);
            while ((step = await store.claim(baseTime + 600000)) && step.node_id === 'join') await store.parkMerge(step, baseTime + 600000);
            assert.equal(step.node_id, 'gate');
            await store.settle(step, { gate: { ...gate, overflow }, outputs: [{ unit: step.unit, edges: plan.outgoing.get('gate') }] }, baseTime + 600000);
            store = createGraphStore(f.db);
            await store.synchronize(initialized.namespace, plan, [origin.runId], baseTime + 600000);
            outputs = await f.query("SELECT * FROM automation_flow_steps WHERE node_id='send'");
        }
        assert.equal(outputs.length, overflow === 'drop' && mode === 'all' ? 0 : 1);
        const state = (await f.query('SELECT state FROM automation_flow_merge_decisions WHERE run_id=?', [origin.runId]))[0].state;
        assert.equal(state, outputs.length ? 'emitted' : 'excluded');
        await store.synchronize(initialized.namespace, plan, [origin.runId], baseTime + 600000);
        assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_steps WHERE node_id='send'"))[0].n), outputs.length);
}));
});
test('a 1001-member merge makes forward progress across synchronizer pages without a row-limit deadlock', { skip: !port, timeout: 90000 }, async () => fixture(async f => {
    const count = 1001, runIds = Array.from({ length: count }, () => randomUUID()), namespace = namespaceKey(f.context), now = baseTime;
    const workflow = newWorkflow('large merge');
    workflow.nodes.splice(1, 0,
        { id: 'leftNode', type: 'condition', config: { predicate: { field: 'title', op: 'exists' } } },
        { id: 'rightNode', type: 'condition', config: { predicate: { field: 'title', op: 'exists' } } },
        { id: 'join', type: 'merge', config: { mode: 'all', displayConflict: 'stop' } });
    workflow.edges = [
        { id: 'left', source: 'start', target: 'leftNode', port: 'out' }, { id: 'rightStart', source: 'start', target: 'rightNode', port: 'out' },
        { id: 'leftIn', source: 'leftNode', target: 'join', port: 'yes' }, { id: 'rightIn', source: 'rightNode', target: 'join', port: 'yes' },
        { id: 'out', source: 'join', target: 'send', port: 'out' },
    ];
    const plan = compileWorkflow(workflow), anchorId = uuid(`test-anchor:${runIds.join(',')}`), stepId = uuid(`test-join:${anchorId}`);
    const members = runIds.map((runId, index) => ({ id: `member_${index}`, runId, event: { title: `event${index}` }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: now, deadlineMs: null }));
    const payload = JSON.stringify({ id: anchorId, kind: 'batch', members, ancestry: [] });
    await f.query('INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,guild_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES ?', [runIds.map(runId => [runId, hash(`origin:${runId}`), f.context.workflowId, 1, f.context.ownerUserId, null, 'private', 'auto', 1, '{}', '[]', 'queued', now])]);
    await f.query('INSERT INTO automation_flow_runs (run_id,namespace_key,context_json,needs_sync) VALUES ?', [runIds.map(runId => [runId, namespace, JSON.stringify(f.context), 1])]);
    await f.query('INSERT INTO automation_flow_units (id,namespace_key,kind,payload_json,checksum,created_at_ms) VALUES (?,?,?,?,?,?)', [anchorId, namespace, 'batch', payload, hash(payload), now]);
    await f.query('INSERT INTO automation_flow_members (unit_id,member_id,run_id,ordinal) VALUES ?', [members.map((member, index) => [anchorId, member.id, member.runId, index])]);
    await f.query("INSERT INTO automation_flow_steps (id,activation_key,namespace_key,node_id,input_unit_id,state,wake_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'joining',?,?,?)", [stepId, hash(`test-join:${anchorId}`), namespace, 'join', anchorId, now, now, now]);
    const receipts = runIds.flatMap(runId => ['leftIn', 'rightIn'].flatMap(edgeId => ['data', 'closed'].map(kind => [hash(JSON.stringify([namespace, runId, edgeId, kind, kind === 'closed' ? null : anchorId])), namespace, runId, edgeId, stepId, kind, kind === 'closed' ? null : anchorId, now])));
    await f.query('INSERT INTO automation_flow_edges (receipt_key,namespace_key,run_id,edge_id,activation_id,receipt_kind,unit_id,created_at_ms) VALUES ?', [receipts]);
    const store = createGraphStore(f.db);
    await store.synchronize(namespace, plan, runIds.slice(0, 1000), now);
    await store.synchronize(namespace, plan, runIds.slice(1000), now);
    const sendUnits = await f.query("SELECT input_unit_id FROM automation_flow_steps WHERE node_id='send'");
    const emitted = await Promise.all(sendUnits.map(row => store.readUnit(row.input_unit_id)));
    assert.equal(emitted.reduce((sum, unit) => sum + unit.members.length, 0), count);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_merge_decisions WHERE state='ready'"))[0].n), 0);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_merge_decisions WHERE state='emitted'"))[0].n), count);
}));
