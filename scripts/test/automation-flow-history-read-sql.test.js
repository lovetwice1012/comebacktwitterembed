'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const { createGraphStore, namespaceKey } = require('../../src/automation/graph-store');
const { refreshFlowHistory } = require('../../src/automation/flow-history');
const { createHistory } = require('../../src/automation/history');
const { dispatch } = require('../../src/automation/api');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), owner = '222222222222222222', guildId = '111111111111111111';
const entries = count => Array.from({ length: count }, (_, i) => ({ nodeId: 'words', outcome: 'yes', memberId: `member${i}`, reason: 'user reason', source: { original: i }, detail: Array.from({ length: 8 }, (_, n) => ({ term: '雪'.repeat(255), start: n * 256, end: n * 256 + 255, category: 'user category' })) }));
async function fixture(work, options = {}) {
    const db = await createTestDatabase(port);
    try {
        const query = db.queryDatabase, service = createService(db), runId = randomUUID(), now = Date.now(), scope = options.scope || 'private';
        const actor = { userId: owner, ...(scope === 'guild' ? { guildId, canView: true, canEdit: true } : {}) };
        const definition = newWorkflow('History read');
        if (options.aggregate) { definition.nodes.splice(1, 0, { id: 'batch', type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, minutes: 1, key: 'all' } }); definition.edges = [{ id: 'into', source: 'start', target: 'batch', port: 'out' }, { id: 'out', source: 'batch', target: 'send', port: 'out' }]; }
        const workflow = await service.createWorkflow(actor, { definition, scope });
        await query('INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,guild_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,?,?,\'auto\',1,\'{}\',\'[]\',\'flow_pending\',?)', [runId, hash(runId), workflow.id, owner, scope === 'guild' ? guildId : null, scope, now]);
        const context = { ownerUserId: owner, scope, guildId: scope === 'guild' ? guildId : undefined, workflowId: workflow.id, revision: 1, targetKind: 'auto', targetId: '1' };
        const initial = await createGraphStore(db).initialize({ runId, context, now, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event: { title: 'History', observedAtMs: now }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: now }] } });
        const trace = entries(options.count ?? 123);
        await query("UPDATE automation_flow_steps SET state='complete',decision_json=? WHERE id=?", [JSON.stringify({ trace }), initial.stepId]);
        await refreshFlowHistory(query, [runId]);
        const readOnly = { queryDatabase: query, withDatabaseTransaction: () => { throw new Error('Read paths must not acquire mutation authority'); } };
        const history = createHistory(readOnly, service);
        await work({ db, query, service, runId, now, actor, context, initial, trace, history, readOnly });
    } finally { await db.close(); }
}

test('history read pages preserve every original field, match and position, with read-only restart and stable cursor', { skip: !port }, async () => fixture(async f => {
    const all = []; let cursor, revision;
    do { const page = await f.history.trace(f.actor, f.runId, { cursor }); revision ||= page.sourceRevision; assert.equal(page.sourceRevision, revision); assert.equal(page.complete, page.nextCursor === null); assert(page.items.length <= 50); assert.equal(page.sources.length, page.items.length); all.push(...page.items); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(all, f.trace); assert.deepEqual(all[0].source, { original: 0 }, 'sidecar provenance never overwrites an existing source field');
    assert.equal((await createHistory(f.readOnly, f.service).trace(f.actor, f.runId)).sourceRevision, revision);
    const viaApi = await dispatch({ method: 'GET', path: ['runs', f.runId, 'trace'] }, f.actor, { history: f.history }); assert.equal(viaApi.sourceRevision, revision);
    await assert.rejects(f.history.trace({ userId: '333333333333333333', isAdmin: true }, f.runId), { code: 'NOT_FOUND', status: 404 });
    for (const cursor of ['?', 'x'.repeat(4097), Buffer.from('{}').toString('base64url')]) await assert.rejects(f.history.trace(f.actor, f.runId, { cursor }), { code: 'INVALID_CURSOR', status: 400 });
    const other = randomUUID(); await assert.rejects(f.history.trace(f.actor, other), { status: 404 });
}));

test('history guild reads require the current guild view permission and do not inherit platform admin access', { skip: !port }, async () => fixture(async f => {
    const viewer = { userId: '333333333333333333', guildId, canView: true, canEdit: false };
    assert((await f.history.trace(viewer, f.runId)).items.length);
    for (const actor of [{ ...viewer, canView: false }, { ...viewer, guildId: '444444444444444444' }, { userId: owner, isAdmin: true }]) await assert.rejects(f.history.trace(actor, f.runId), { status: 403 });
}, { scope: 'guild' }));

test('history refuses stale cursors and a source changed during a read without mixing records', { skip: !port }, async () => fixture(async f => {
    const first = await f.history.trace(f.actor, f.runId); assert(first.nextCursor);
    const next = { trace: [...f.trace, { nodeId: 'new', outcome: 'complete' }] };
    await f.query('UPDATE automation_flow_steps SET decision_json=?,version=version+1 WHERE id=?', [JSON.stringify(next), f.initial.stepId]);
    await assert.rejects(f.history.trace(f.actor, f.runId, { cursor: first.nextCursor }), { code: 'HISTORY_TRACE_CHANGED', status: 409 });
    assert.notEqual((await f.history.trace(f.actor, f.runId)).sourceRevision, first.sourceRevision);
    let changed = false;
    const racing = createHistory({ ...f.readOnly, queryDatabase: async (sql, params) => {
        const result = await f.query(sql, params);
        if (!changed && sql.startsWith('SELECT decision_json FROM automation_flow_steps')) { changed = true; await f.query('UPDATE automation_flow_steps SET version=version+1 WHERE id=?', [f.initial.stepId]); }
        return result;
    } }, f.service);
    await assert.rejects(racing.trace(f.actor, f.runId), { code: 'HISTORY_TRACE_CHANGED', status: 409 });
    let changedBody = false;
    const bodyRace = createHistory({ ...f.readOnly, queryDatabase: async (sql, params) => {
        if (!changedBody && sql.startsWith('SELECT decision_json FROM automation_flow_steps')) { changedBody = true; await f.query('UPDATE automation_flow_steps SET decision_json=? WHERE id=?', [JSON.stringify({ trace: [] }), f.initial.stepId]); }
        return f.query(sql, params);
    } }, f.service);
    await assert.rejects(bodyRace.trace(f.actor, f.runId), { code: 'HISTORY_TRACE_CHANGED', status: 409 });
}));

test('history rechecks authorization after reading a page and sanitizes DB and parse failures', { skip: !port }, async () => fixture(async f => {
    for (const needle of ['SELECT s.id,s.node_id,s.state,s.version', 'SELECT decision_json FROM automation_flow_steps']) {
        const failed = createHistory({ ...f.readOnly, queryDatabase: async (sql, params) => { if (sql.startsWith(needle)) throw new Error('db credential / signed-url must remain private'); return f.query(sql, params); } }, f.service);
        await assert.rejects(failed.trace(f.actor, f.runId), error => error.code === 'HISTORY_TRACE_UNAVAILABLE' && error.status === 503 && !error.message.includes('credential'));
    }
    let headerCalls = 0;
    const lost = createHistory({ ...f.readOnly, queryDatabase: async (sql, params) => {
        if (sql.startsWith('SELECT id,owner_user_id') && ++headerCalls === 2) await f.query('UPDATE automation_runs SET owner_user_id=? WHERE id=?', ['333333333333333333', f.runId]);
        return f.query(sql, params);
    } }, f.service);
    await assert.rejects(lost.trace(f.actor, f.runId), { status: 404 });
    await f.query('UPDATE automation_runs SET owner_user_id=? WHERE id=?', [owner, f.runId]);
    await f.query('UPDATE automation_flow_steps SET decision_json=? WHERE id=?', ['not JSON / private', f.initial.stepId]);
    await assert.rejects(f.history.trace(f.actor, f.runId), { code: 'HISTORY_TRACE_UNAVAILABLE', status: 503 });
}));

test('large indexed detail and pre-job history expose complete pages; page failures retain canonical delivery actions', { skip: !port }, async () => fixture(async f => {
    const stored = JSON.parse((await f.query('SELECT trace_json FROM automation_runs WHERE id=?', [f.runId]))[0].trace_json); assert.equal(stored[0].traceIndex.version, 1);
    const excluded = await f.history.excluded(f.actor); assert.equal(excluded.items[0].traceHistory.indexed, true); assert.equal(excluded.items[0].traceHistory.firstPage, false);
    const targeted = await f.history.list(f.actor, { targetKind: 'auto', targetId: '1' }); assert.equal(targeted.ruleRuns[0].traceHistory.runId, f.runId);
    const jobId = randomUUID(); await f.query("INSERT INTO automation_jobs(id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES(?,?,'{}',?,'pending',?,?)", [jobId, f.runId, f.now, f.now, f.now]);
    const detail = await f.history.detail(f.actor, jobId); assert.equal(detail.traceHistory.firstPage, true); assert.equal(detail.traceHistory.indexed, true); assert.equal(detail.traceHistory.runId, f.runId); assert.deepEqual(detail.trace, f.trace.slice(0, detail.trace.length)); assert(detail.traceHistory.nextCursor);
    const unavailable = createHistory({ ...f.readOnly, queryDatabase: async (sql, params) => { if (sql.startsWith('SELECT decision_json FROM automation_flow_steps')) throw new Error('private DB error'); return f.query(sql, params); } }, f.service);
    const readable = await unavailable.detail(f.actor, jobId); assert.equal(readable.state, detail.state); assert.equal(readable.version, detail.version); assert.equal(readable.traceHistory.firstPage, false); assert.equal(readable.traceHistory.errorCode, 'HISTORY_TRACE_UNAVAILABLE');
    const listed = (await f.history.list(f.actor)).items[0]; assert.equal(listed.id, jobId); assert.equal(listed.state, detail.state); assert.equal(listed.version, detail.version); assert.equal(listed.snapshotInvalid, false);
}, { count: 700 }));

test('history projection rollback retains prior history, and restart reconstructs all indexed entries from immutable sources', { skip: !port }, async () => fixture(async f => {
    await f.query("UPDATE automation_runs SET trace_json='[]',state='waiting' WHERE id=?", [f.runId]);
    await assert.rejects(f.db.withDatabaseTransaction(async query => refreshFlowHistory(async (sql, params) => { const result = await query(sql, params); if (sql.startsWith('UPDATE automation_runs SET state=')) throw new Error('injected projection rollback'); return result; }, [f.runId])), /injected projection rollback/);
    const old = (await f.query('SELECT state,trace_json FROM automation_runs WHERE id=?', [f.runId]))[0]; assert.deepEqual({ ...old }, { state: 'waiting', trace_json: '[]' });
    await f.db.withDatabaseTransaction(query => refreshFlowHistory(query, [f.runId]));
    const all = []; let cursor; do { const page = await createHistory(f.readOnly, f.service).trace(f.actor, f.runId, { cursor }); all.push(...page.items); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(all, f.trace);
}, { count: 700 }));

test('legacy raw-array history stays readable without graph rows, including an intact oversized entry', { skip: !port }, async () => fixture(async f => {
    const legacy = randomUUID(), trace = [{ nodeId: 'legacy', outcome: 'complete', data: 'x'.repeat(300000) }, { nodeId: 'next', outcome: 'excluded', reason: 'User explanation' }];
    await f.query("INSERT INTO automation_runs(id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?, ?,?,'private','auto',1,'{}',?,'excluded',?)", [legacy, hash(legacy), owner, JSON.stringify(trace), f.now]);
    const first = await f.history.trace(f.actor, legacy); assert.deepEqual(first.items, trace.slice(0, 1)); assert(first.nextCursor); const second = await f.history.trace(f.actor, legacy, { cursor: first.nextCursor }); assert.deepEqual(second.items, trace.slice(1)); assert.equal(second.complete, true);
    const row = (await f.history.excluded(f.actor)).items.find(item => item.id === legacy); assert.deepEqual(row.trace, trace); assert.equal(row.traceHistory, undefined);
}));

test('1000 distinct runs read one shared 1.7MiB immutable decision once during projection, not 1000 JSON copies', { skip: !port, timeout: 120000 }, async () => fixture(async f => {
    const runs = Array.from({ length: 1000 }, () => randomUUID()), namespace = namespaceKey(f.context), unitId = randomUUID(), stepId = randomUUID();
    await f.query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES ?", [runs.map(id => [id, hash(id), f.context.workflowId, 1, owner, 'private', 'auto', 1, '{}', '[]', 'flow_pending', f.now])]);
    await f.query('INSERT INTO automation_flow_runs(run_id,namespace_key,context_json) VALUES ?', [runs.map(id => [id, namespace, JSON.stringify(f.context)])]);
    const unit = { id: unitId, kind: 'batch', ancestry: [], members: runs.map((runId, i) => ({ id: `m${i}`, runId, event: { title: 'Same bounded batch' }, schedules: [], display: NODE_TYPES.transform.defaults, dueAtMs: f.now })) }, payload = JSON.stringify(unit);
    require('../../src/automation/graph-plan').copyData(unit);
    await f.query('INSERT INTO automation_flow_units(id,namespace_key,kind,payload_json,checksum,created_at_ms) VALUES(?,?,\'batch\',?,?,?)', [unitId, namespace, payload, hash(payload), f.now]);
    await f.query('INSERT INTO automation_flow_members(unit_id,member_id,run_id,ordinal) VALUES ?', [runs.map((id, i) => [unitId, `m${i}`, id, i])]);
    const decision = { trace: runs.map((runId, i) => ({ nodeId: 'shared', outcome: 'yes', runId, memberId: `m${i}`, detail: [{ term: '雪'.repeat(255), start: 0, end: 255 }, { term: '雪'.repeat(255), start: 256, end: 511 }] })) }; require('../../src/automation/graph-plan').copyData(decision);
    const body = JSON.stringify(decision); assert(Buffer.byteLength(body) > 1700000);
    await f.query("INSERT INTO automation_flow_steps(id,activation_key,namespace_key,node_id,input_unit_id,state,decision_json,wake_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,'shared',?,'complete',?,?,?,?)", [stepId, hash(stepId), namespace, unitId, body, f.now, f.now, f.now]);
    let bodies = 0, readBytes = 0;
    await refreshFlowHistory(async (sql, params) => { const result = await f.query(sql, params); if (/SELECT s.id,s.node_id,s.state,s.decision_json/.test(sql)) { bodies += result.length; readBytes += result.reduce((n, row) => n + Buffer.byteLength(row.decision_json || ''), 0); } return result; }, runs);
    assert.equal(bodies, 1); assert.equal(readBytes, Buffer.byteLength(body));
    const first = await f.history.trace(f.actor, runs[0]); assert.deepEqual(first.items, [decision.trace[0]]);
    const last = (await f.query('SELECT trace_json FROM automation_runs WHERE id=?', [runs.at(-1)]))[0]; assert.deepEqual(JSON.parse(last.trace_json), [decision.trace.at(-1)]);
}));

for (const kind of ['step', 'batch']) test(`full ${kind} failure history reconstructs every original member from relational receipts across pages`, { skip: !port }, async () => fixture(async f => {
    const runId = randomUUID(), store = createGraphStore(f.db), members = Array.from({ length: 120 }, (_, i) => ({ id: `member${i}`, runId, event: { title: 'Expiring event', observedAtMs: f.now }, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: f.now, deadlineMs: f.now + 1 }));
    await f.query("INSERT INTO automation_runs(id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,1,?,'private','auto',1,'{}','[]','flow_pending',?)", [runId, hash(runId), f.context.workflowId, owner, f.now]);
    const initial = await store.initialize({ runId, context: f.context, now: f.now, nodeId: kind === 'batch' ? 'batch' : 'start', unit: { kind: 'batch', ancestry: [], members } }), claimed = await store.claim(f.now);
    assert.equal(claimed.id, initial.stepId);
    if (kind === 'step') assert.equal((await store.failStep(claimed, 'GRAPH_INPUT_LIMIT', [], f.now)).state, 'failed');
    else { await store.admitBatch(claimed, { ...NODE_TYPES.aggregate.defaults, key: 'all', minutes: 1 }, [{ key: ['all'], unit: claimed.unit }], f.now); const batch = await store.dueBatch(f.now + 60000); assert(batch); await store.closeBatch(batch, [], f.now + 60000); }
    await refreshFlowHistory(f.query, [runId]);
    const all = []; let cursor;
    do { const page = await f.history.trace(f.actor, runId, { cursor }); all.push(...page.items); cursor = page.nextCursor; } while (cursor);
    const failures = all.filter(entry => entry.memberId); assert.equal(failures.length, members.length); assert.deepEqual(new Set(failures.map(entry => entry.memberId)), new Set(members.map(member => member.id))); assert(failures.every(entry => entry.reason === (kind === 'step' ? 'GRAPH_INPUT_LIMIT' : 'DEADLINE_EXCEEDED')));
    assert.equal(JSON.parse((await f.query('SELECT trace_json FROM automation_runs WHERE id=?', [runId]))[0].trace_json).length, 1, 'ordinary small summary stays compatible while complete member detail is available');
}, { aggregate: kind === 'batch' }));
