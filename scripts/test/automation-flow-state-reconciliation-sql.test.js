'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createRunner } = require('../../src/automation/runtime');
const { createGraphDriver } = require('../../src/automation/graph-driver');
const { createFlowProjector } = require('../../src/automation/flow-projector');
const { compileWorkflow } = require('../../src/automation/graph-plan');
const { createMarketplace } = require('../../src/automation/marketplace');
const { createHistory } = require('../../src/automation/history');
const { refreshFlowHistory } = require('../../src/automation/flow-history');
const { NODE_TYPES } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const node = (id, type) => ({ id, type, config: structuredClone(NODE_TYPES[type].defaults) });
const definition = multiple => ({ schemaVersion: 1, name: 'Delivery state reconciliation',
    nodes: [node('start', 'start'), node('left', 'send'), ...(multiple ? [node('right', 'send')] : [])],
    edges: [{ id: 'left', source: 'start', target: 'left', port: 'out' }, ...(multiple ? [{ id: 'right', source: 'start', target: 'right', port: 'out' }] : [])] });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const workflowFence = id => require('node:crypto').createHash('sha256').update(JSON.stringify(['flow-workflow-fence', id])).digest('hex');
async function publishedWorkflow(f) {
    const market = createMarketplace(f.db, { service: f.service });
    const pack = await market.save(f.actor, { title: 'Atomic workflow stop', description: 'Local transaction fixture', visibility: 'public', rightsConfirmed: true,
        bundle: { schemaVersion: 1, kind: 'workflow', workflow: definition(true), dictionaries: {}, license: 'CC0-1.0' } });
    const installed = await market.install(f.actor, pack.id, { version: 1 });
    await f.service.activateWorkflow(f.actor, installed.workflow.id, { expectedRevision: 1 });
    await f.service.attach(f.actor, installed.workflow.id, 'auto', f.monitor.id);
    return { market, pack, workflow: installed.workflow };
}
async function unprojectedRun(f, workflow) {
    const run = await f.run('stop before projection', false), plan = compileWorkflow((await f.service.getWorkflow(f.actor, workflow.id)).draft);
    const driver = createGraphDriver(createGraphStore(f.db), { assertEnabled: () => {}, loadPlan: async () => plan });
    for (let index = 0; index < 15; index++) { if ((await driver.tick(f.clock())).state === 'idle') break; }
    assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_sends WHERE state='unprojected'"))[0].n), 2);
    return run;
}
async function fixture(work, input = {}) {
    const db = await createTestDatabase(port), query = db.queryDatabase, actor = { userId: '222222222222228744' }, service = createService(db);
    let evaluator, flow;
    try {
        const destination = await service.saveDestination(actor, { name: 'Reconciliation DM', kind: 'dm' });
        const monitor = await createMonitors(db, service, {}).save(actor, 'auto', { name: 'Reconciliation monitor', providerId: 'github', source: 'reconciliation', destinationId: destination.id });
        const workflow = await service.createWorkflow(actor, { definition: input.definition || definition(input.multiple) });
        await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 }); await service.attach(actor, workflow.id, 'auto', monitor.id);
        let now = Date.now(); evaluator = createEvaluator(service.dictionaryData);
        const store = createGraphStore(db), queue = createQueue(db, evaluator, { clock: () => now, graph: { enabled: true, store } });
        flow = createFlowRuntime(db, evaluator, store, { assertEnabled: () => {} });
        const history = createHistory(db, service);
        async function drain() { for (let index = 0; index < 100; index++) { const result = await flow.tick(now); if (result.state === 'idle' && !result.projected) break; } }
        async function run(label = 'event', project = true, sourceMonitor = monitor) {
            now += 1000;
            const target = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [sourceMonitor.id]))[0], content = randomUUID(), lease = randomUUID();
            const item = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,published_at_ms,discovered_at_ms) VALUES (?,?,?,?,?,?,?)',
                [target.source_id, content, 'https://github.com/example/reconciliation', label, '{}', now, now]);
            const delivery = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [item.insertId, sourceMonitor.id, now, lease, now + 60000]);
            const routed = await queue.route('auto', { id: String(delivery.insertId), target_id: sourceMonitor.id, lease_token: lease, provider_id: 'github', source_key: 'reconciliation',
                content_key: content, content_url: 'https://github.com/example/reconciliation', title: label, payload_json: '{}', published_at_ms: now, discovered_at_ms: now }, now);
            assert.equal(routed.state, 'routed'); if (project) await drain();
            return { runId: routed.runId, jobs: await query('SELECT * FROM automation_jobs WHERE run_id=? ORDER BY id', [routed.runId]) };
        }
        const state = async runId => (await query('SELECT state FROM automation_runs WHERE id=?', [runId]))[0].state;
        await work({ db, query, service, actor, destination, monitor, workflow, evaluator, queue, history, run, state, drain, clock: () => now, advance: amount => { now += amount; } });
    } finally { flow?.clear(); await evaluator?.stop(); await db.close(); }
}

test('real branched runner and all terminal state permutations produce deterministic complete/partial/unknown summaries', { skip: !port, timeout: 90000 }, async () => fixture(async f => {
    const run = await f.run(), [first, second] = run.jobs; assert.equal(run.jobs.length, 2);
    let wireCalls = 0;
    const runner = createRunner(f.db, f.queue, { readiness: () => true, prepare: async () => ({ payloads: [{}] }), sendStep: async (_prepared, job) => {
        wireCalls++; if (job.id === second.id) throw Object.assign(new Error('fixture denied'), { status: 403 }); return '555555555555555551';
    } }, { clock: f.clock, sleep: async amount => f.advance(amount), assertAllowed: () => {}, notificationAllowed: () => true });
    for (let index = 0; index < 5; index++) { await runner.tick(); f.advance(5000); }
    assert.equal(wireCalls, 2); assert.equal(await f.state(run.runId), 'partial');
    const trace = (await f.query('SELECT trace_json FROM automation_runs WHERE id=?', [run.runId]))[0].trace_json;
    const rank = ['unknown', 'failed', 'expired', 'cancelled', 'excluded'];
    const states = ['sent', 'partial', ...rank, 'pending', 'leased', 'sending', 'held', 'aggregated'];
    for (const left of states) for (const right of states) {
        await f.query('UPDATE automation_jobs SET state=? WHERE id=?', [left, first.id]); await f.query('UPDATE automation_jobs SET state=? WHERE id=?', [right, second.id]);
        await f.db.withDatabaseTransaction(query => refreshFlowHistory(query, [run.runId]));
        const expected = [left, right].some(state => ['pending', 'leased', 'sending', 'held', 'aggregated'].includes(state)) ? 'queued'
            : left === 'sent' && right === 'sent' ? 'sent' : [left, right].some(state => ['sent', 'partial'].includes(state)) ? 'partial' : rank.find(state => state === left || state === right);
        assert.equal(await f.state(run.runId), expected, `${left} + ${right}`);
    }
    assert.equal((await f.query('SELECT trace_json FROM automation_runs WHERE id=?', [run.runId]))[0].trace_json, trace);
    await f.query("UPDATE automation_jobs SET state='sent' WHERE id=?", [first.id]); await f.query('DELETE FROM automation_jobs WHERE id=?', [second.id]);
    await f.query("UPDATE automation_flow_sends SET state='failed' WHERE id=?", [JSON.parse(second.plan_json).flowV2.sendId]);
    await f.db.withDatabaseTransaction(query => refreshFlowHistory(query, [run.runId])); assert.equal(await f.state(run.runId), 'partial');
    await f.query("UPDATE automation_flow_sends SET state='unprojected' WHERE id=?", [JSON.parse(second.plan_json).flowV2.sendId]);
    await f.db.withDatabaseTransaction(query => refreshFlowHistory(query, [run.runId])); assert.equal(await f.state(run.runId), 'flow_pending');
}, { multiple: true }));

test('restart lease recovery preserves unknown policy even after an ACK and never reclaims it for delivery', { skip: !port }, async () => fixture(async f => {
    const run = await f.run(), leased = await f.queue.claim(f.clock()); assert.equal((await f.queue.beginSend(leased, f.clock())).state, 'sending');
    await f.queue.acknowledgeStep(leased, '555555555555555552');
    await f.query('UPDATE automation_jobs SET lease_until_ms=? WHERE id=?', [f.clock() - 1, leased.id]);
    const restarted = createQueue(f.db, f.evaluator, { clock: f.clock, graph: { enabled: true, store: createGraphStore(f.db) } });
    assert.equal(await restarted.claim(f.clock()), null); assert.equal(await f.state(run.runId), 'unknown');
    const row = (await f.query('SELECT state,last_error_code,sent_steps,discord_message_id FROM automation_jobs WHERE id=?', [leased.id]))[0];
    assert.deepEqual({ ...row }, { state: 'unknown', last_error_code: 'SEND_LEASE_EXPIRED', sent_steps: 1, discord_message_id: '555555555555555552' });
    assert.equal(await restarted.claim(f.clock() + 999999), null);
    const detail = await f.history.detail(f.actor, leased.id);
    await assert.rejects(f.history.change(f.actor, leased.id, { action: 'retry', expectedVersion: detail.version }), { code: 'DELIVERY_NOT_REPLAYABLE' });
}));

test('cancel, retry, reschedule and legacy held cleanup atomically update the immediately readable run history', { skip: !port }, async () => fixture(async f => {
    const cancelled = await f.run('cancel'), detail = await f.history.detail(f.actor, cancelled.jobs[0].id);
    await f.history.change(f.actor, detail.id, { action: 'cancel', expectedVersion: detail.version }); assert.equal(await f.state(cancelled.runId), 'cancelled');
    const retried = await f.run('retry'), leased = await f.queue.claim(f.clock()); await f.queue.transition(leased, 'failed', 'FIXTURE_FAILED');
    assert.equal(await f.state(retried.runId), 'failed');
    const failed = await f.history.detail(f.actor, leased.id); await f.history.change(f.actor, failed.id, { action: 'retry', expectedVersion: failed.version });
    assert.equal(await f.state(retried.runId), 'queued');
    const pending = await f.history.detail(f.actor, leased.id); await f.history.change(f.actor, pending.id, { action: 'reschedule', dueAtMs: Date.now() + 600000, expectedVersion: pending.version });
    assert.equal(await f.state(retried.runId), 'queued');
    await f.history.change(f.actor, pending.id, { action: 'cancel', expectedVersion: (await f.history.detail(f.actor, pending.id)).version });
    const held = await f.run('held'); await f.query("UPDATE automation_jobs SET state='held' WHERE id=?", [held.jobs[0].id]);
    assert.equal(await f.queue.claim(f.clock()), null); assert.equal(await f.state(held.runId), 'failed');
}));

test('damaged pre-receipt legacy snapshots fail their attested anchor while new multi-member jobs retain every exact lineage', { skip: !port }, async () => {
    await fixture(async f => {
        const run = await f.run(); await f.query("DELETE FROM automation_flow_edges WHERE receipt_kind IN ('job_member','job_excluded')");
        await f.query("UPDATE automation_jobs SET plan_json='{' WHERE id=?", [run.jobs[0].id]);
        assert.equal(await f.queue.claim(f.clock()), null); assert.equal(await f.state(run.runId), 'failed');
        await f.db.withDatabaseTransaction(query => refreshFlowHistory(query, [run.runId])); assert.equal(await f.state(run.runId), 'failed');
    });
    const batch = definition(false); batch.nodes.splice(1, 0, { id: 'batch', type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, minutes: 1, key: 'all' } });
    batch.edges = [{ id: 'a', source: 'start', target: 'batch', port: 'out' }, { id: 'b', source: 'batch', target: 'left', port: 'out' }];
    await fixture(async f => {
        const first = await f.run('first'), second = await f.run('second'); f.advance(60001); await f.drain();
        const jobs = await f.query('SELECT * FROM automation_jobs'); assert.equal(jobs.length, 1);
        const links = await f.query("SELECT run_id FROM automation_flow_edges WHERE edge_id=? AND receipt_kind='job_member'", [jobs[0].id]);
        assert.deepEqual(new Set(links.map(row => row.run_id)), new Set([first.runId, second.runId]));
        await f.query("UPDATE automation_jobs SET plan_json='{}' WHERE id=?", [jobs[0].id]); assert.equal(await f.queue.claim(f.clock()), null);
        assert.equal(await f.state(first.runId), 'failed'); assert.equal(await f.state(second.runId), 'failed');
        const trace = await f.history.trace(f.actor, second.runId); assert(trace.items.length > 0);
    }, { definition: batch });
});

test('audit and projection failures roll back both job and run changes, including restart cleanup', { skip: !port }, async () => fixture(async f => {
    const run = await f.run(), id = run.jobs[0].id, detail = await f.history.detail(f.actor, id);
    const deniedHistory = createHistory(f.db, { ...f.service, audit: async () => { throw new Error('audit unavailable'); } });
    await assert.rejects(deniedHistory.change(f.actor, id, { action: 'cancel', expectedVersion: detail.version }), /audit unavailable/);
    assert.equal((await f.history.detail(f.actor, id)).state, 'pending'); assert.equal(await f.state(run.runId), 'queued');
    const lease = await f.queue.claim(f.clock()); await f.queue.beginSend(lease, f.clock()); await f.query('UPDATE automation_jobs SET lease_until_ms=? WHERE id=?', [f.clock() - 1, id]);
    const broken = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (/^UPDATE automation_runs SET state=/.test(sql)) throw new Error('projection unavailable'); return query(sql, params);
    })) };
    await assert.rejects(createQueue(broken, f.evaluator).claim(f.clock()), /projection unavailable/);
    assert.equal((await f.history.detail(f.actor, id)).state, 'sending'); assert.equal(await f.state(run.runId), 'queued');
    assert.equal(await f.queue.claim(f.clock()), null); assert.equal(await f.state(run.runId), 'unknown');
}));

test('simultaneous sibling transitions serialize before current projection reads and preserve both outcomes', { skip: !port, timeout: 60000 }, async () => fixture(async f => {
    const run = await f.run(), first = await f.queue.claim(f.clock()), second = await f.queue.claim(f.clock()); assert.notEqual(first.id, second.id);
    assert.deepEqual(await Promise.all([f.queue.transition(first, 'sent'), f.queue.transition(second, 'failed', 'FIXTURE_DENIED')]), [true, true]);
    assert.equal(await f.state(run.runId), 'partial');
    const jobs = await f.query('SELECT state FROM automation_jobs ORDER BY id'); assert.deepEqual(new Set(jobs.map(job => job.state)), new Set(['sent', 'failed']));
    assert.equal(await f.queue.claim(f.clock() + 999999), null);
}, { multiple: true }));

test('unattested foreign IDs in a syntactically valid damaged plan cannot lock or reproject another namespace', { skip: !port }, async () => fixture(async f => {
    const own = await f.run(), other = { userId: '222222222222228755' };
    const destination = await f.service.saveDestination(other, { name: 'Other owner', kind: 'dm' });
    const monitor = await createMonitors(f.db, f.service, {}).save(other, 'auto', { name: 'Other monitor', providerId: 'github', source: 'other', destinationId: destination.id });
    const workflow = await f.service.createWorkflow(other, { definition: definition(false) });
    await f.service.activateWorkflow(other, workflow.id, { expectedRevision: 1 }); await f.service.attach(other, workflow.id, 'auto', monitor.id);
    const foreign = await f.run('foreign', true, monitor), before = (await f.query('SELECT state,trace_json FROM automation_runs WHERE id=?', [foreign.runId]))[0];
    const plan = JSON.parse(own.jobs[0].plan_json); plan.flowV2.excludedMembers = [{ memberId: 'unattested', runId: foreign.runId, code: 'MONITOR_CHANGED' }];
    await f.query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(plan), own.jobs[0].id]);
    const touched = [], watched = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (/^UPDATE automation_runs SET state=/.test(sql)) touched.push(params[2]); return query(sql, params);
    })) };
    const history = createHistory(watched, f.service), detail = await history.detail(f.actor, own.jobs[0].id);
    await history.change(f.actor, detail.id, { action: 'cancel', expectedVersion: detail.version });
    assert.deepEqual(touched, [own.runId]);
    assert.deepEqual((await f.query('SELECT state,trace_json FROM automation_runs WHERE id=?', [foreign.runId]))[0], before);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE edge_id=? AND run_id=? AND receipt_kind IN ('job_member','job_excluded')", [detail.id, foreign.runId]))[0].n), 0);
}));

test('housekeeping bounds each transaction to 100 jobs and later claims finish the remaining exact runs', { skip: !port, timeout: 120000 }, async () => fixture(async f => {
    const runs = [];
    for (let index = 0; index < 105; index++) runs.push(await f.run(`bounded-${index}`));
    await f.query("UPDATE automation_jobs SET state='held'");
    assert.equal(await f.queue.claim(f.clock()), null);
    const first = await f.query('SELECT j.state AS job_state,r.state AS run_state,COUNT(*) AS n FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id GROUP BY j.state,r.state');
    assert.deepEqual(new Map(first.map(row => [`${row.job_state}:${row.run_state}`, Number(row.n)])), new Map([['failed:failed', 100], ['held:queued', 5]]));
    assert.equal(await f.queue.claim(f.clock()), null);
    assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE j.state='failed' AND r.state='failed'"))[0].n), 105);
    assert.equal(await f.queue.claim(f.clock()), null);
}));

test('legacy aggregated children retain their own flow histories through parent cancellation, failure and recovery', { skip: !port }, async () => fixture(async f => {
    for (const action of ['cancel', 'transition', 'cleanup', 'corrupt']) {
        const parent = await f.run(`${action}-parent`), child = await f.run(`${action}-child`), id = parent.jobs[0].id;
        await f.query("UPDATE automation_jobs SET state='aggregated',parent_job_id=? WHERE id=?", [id, child.jobs[0].id]);
        if (action === 'cancel') {
            const detail = await f.history.detail(f.actor, id); await f.history.change(f.actor, id, { action: 'cancel', expectedVersion: detail.version });
        } else if (action === 'transition') {
            const lease = await f.queue.claim(f.clock()); assert.equal(lease.id, id); await f.queue.transition(lease, 'failed', 'FIXTURE_FAILED');
        } else if (action === 'cleanup') {
            await f.query("UPDATE automation_jobs SET state='unknown',last_error_code='FIXTURE_UNKNOWN' WHERE id=?", [id]);
            assert.equal(await f.queue.claim(f.clock()), null);
        } else {
            await f.query("UPDATE automation_jobs SET plan_json='{' WHERE id=?", [id]); assert.equal(await f.queue.claim(f.clock()), null);
        }
        const expected = action === 'cancel' ? 'cancelled' : action === 'cleanup' ? 'unknown' : 'failed';
        assert.equal(await f.state(child.runId), expected, action);
        assert.equal((await f.history.detail(f.actor, child.jobs[0].id)).state, expected, action);
    }
}));

test('one pruned occurrence does not erase a surviving occurrence of the same run after snapshot corruption', { skip: !port }, async () => {
    const branched = { schemaVersion: 1, name: 'Repeated lineage', nodes: [node('start', 'start'), node('a', 'transform'), node('b', 'transform'),
        { id: 'batch', type: 'aggregate', config: { ...NODE_TYPES.aggregate.defaults, minutes: 1, maxItems: 2, key: 'all' } }, node('left', 'send')],
    edges: [{ id: 'sa', source: 'start', target: 'a', port: 'out' }, { id: 'sb', source: 'start', target: 'b', port: 'out' },
        { id: 'ab', source: 'a', target: 'batch', port: 'out' }, { id: 'bb', source: 'b', target: 'batch', port: 'out' }, { id: 'send', source: 'batch', target: 'left', port: 'out' }] };
    await fixture(async f => {
        const run = await f.run(); f.advance(60001); await f.drain();
        const job = (await f.query('SELECT * FROM automation_jobs'))[0], plan = JSON.parse(job.plan_json);
        assert.equal(plan.members.length, 2); assert(plan.members.every(member => member.runId === run.runId));
        // Simulate an already-frozen per-occurrence deadline reaching its
        // boundary; exercise the real member-pruning writer and its receipts.
        plan.members[0].deadlineMs = f.clock() - 1; await f.query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(plan), job.id]);
        const lease = await f.queue.claim(f.clock()), refreshed = await f.queue.refreshFlowJob(lease, f.clock());
        assert.equal(refreshed.state, 'ready'); assert.equal(refreshed.job.plan.members.length, 1);
        assert.equal(refreshed.job.plan.flowV2.excludedMembers.length, 1);
        await f.query("UPDATE automation_jobs SET state='pending',lease_token=NULL,lease_until_ms=0,plan_json='{' WHERE id=?", [job.id]);
        assert.equal(await f.queue.claim(f.clock()), null); assert.equal(await f.state(run.runId), 'failed');
        assert.equal(Number((await f.query("SELECT COUNT(*) AS n FROM automation_flow_edges WHERE edge_id=? AND receipt_kind='job_member'", [job.id]))[0].n), 2);
    }, { definition: branched });
});

for (const action of ['delete', 'revoke']) for (const rollback of [false, true]) test(`empty-roster ${action} fences both branch projectors before mutation and ${rollback ? 'releases intact admission on rollback' : 'keeps its stop after commit'}`, { skip: !port, timeout: 60000 }, async () => fixture(async f => {
    const published = action === 'revoke' ? await publishedWorkflow(f) : null, workflow = published?.workflow || f.workflow;
    const run = await unprojectedRun(f, workflow), held = gate(), release = gate(); let paused = false, completed = false;
    const stoppedDb = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (rollback && sql.startsWith('INSERT INTO automation_audit ') && params[3] === (action === 'delete' ? 'workflow.delete' : 'package.revoke')) throw new Error('stop audit unavailable');
        const result = await query(sql, params);
        if (!paused && sql.startsWith('INSERT INTO automation_flow_locks ') && sql.includes('ON DUPLICATE KEY UPDATE') && params[0] === workflowFence(workflow.id)) {
            paused = true; held.resolve(); await release.promise;
        }
        return result;
    })) };
    const stopping = (action === 'delete' ? createService(stoppedDb).remove('workflow', f.actor, workflow.id, 1)
        : createMarketplace(stoppedDb, { service: createService(stoppedDb) }).setStatus({ ...f.actor, isAdmin: true }, published.pack.id, { status: 'revoked', expectedVersion: 1, note: 'transaction fixture' }))
        .then(value => ({ value }), error => ({ error }));
    let projections = [];
    try {
        await Promise.race([held.promise, stopping.then(result => { throw result.error || new Error('stop did not acquire its workflow fence'); })]);
        projections = [1, 2].map(() => createFlowProjector(f.db).projectOne(f.clock()).then(value => { completed = true; return { value }; }, error => { completed = true; return { error }; }));
        // Both real SQL projectors are blocked by the exclusive workflow row,
        // not merely delayed by a mock. No job existed when the stop began.
        await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(completed, false);
        assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0);
        release.resolve(); const result = await stopping;
        if (rollback) assert.match(result.error?.message || '', /stop audit unavailable/); else assert.equal(result.error, undefined);
        for (const result of await Promise.all(projections)) assert.equal(result.error, undefined);
        for (let index = 0; index < 3; index++) await createFlowProjector(f.db).projectOne(f.clock());
        const jobs = await f.query('SELECT state FROM automation_jobs');
        if (rollback) { assert.equal(jobs.length, 2); assert(jobs.every(job => job.state === 'pending')); assert.equal(await f.state(run.runId), 'queued'); }
        else { assert.equal(jobs.length, 0); assert.equal(await f.state(run.runId), 'excluded'); }
    } finally { release.resolve(); await stopping; await Promise.all(projections); }
}, { multiple: true }));

test('revoke revalidates an installation copy committed while waiting for its workflow fence and retries with the complete roster', { skip: !port, timeout: 60000 }, async () => fixture(async f => {
    const published = await publishedWorkflow(f), copying = gate(), copyRelease = gate(), rosterRead = gate(); let paused = false;
    const copyDb = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        const result = await query(sql, params);
        if (!paused && sql.startsWith('INSERT IGNORE INTO automation_flow_locks ') && params[0] === workflowFence(published.workflow.id)) {
            paused = true; copying.resolve(); await copyRelease.promise;
        }
        return result;
    })) };
    const source = await f.service.getWorkflow(f.actor, published.workflow.id);
    const copy = createService(copyDb).createWorkflow(f.actor, { sourceWorkflowId: source.id, expectedSourceRevision: source.revision, definition: source.draft, bindings: source.bindings }).then(value => ({ value }), error => ({ error }));
    let revocation;
    try {
        await copying.promise;
        const revokeDb = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
            const result = await query(sql, params); if (sql === 'SELECT workflow_id FROM automation_package_installs WHERE package_id=?') rosterRead.resolve(); return result;
        })) };
        const admin = { ...f.actor, isAdmin: true }, input = { status: 'revoked', expectedVersion: 1, note: 'roster fixture' };
        revocation = createMarketplace(revokeDb, { service: createService(revokeDb) }).setStatus(admin, published.pack.id, input).then(value => ({ value }), error => ({ error }));
        await rosterRead.promise; copyRelease.resolve(); assert.equal((await copy).error, undefined);
        assert.equal((await revocation).error?.code, 'REVISION_CONFLICT');
        assert.equal((await f.query('SELECT status FROM automation_packages WHERE id=?', [published.pack.id]))[0].status, 'active');
        assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_package_installs WHERE package_id=?', [published.pack.id]))[0].n), 2);
        // Publication attempts retain the real actor rate limit. A second
        // authorized moderator performs the fresh-roster confirmation here.
        await published.market.setStatus({ ...admin, userId: '222222222222228756' }, published.pack.id, input);
        assert((await f.query('SELECT w.enabled FROM automation_workflows w JOIN automation_package_installs i ON i.workflow_id=w.id WHERE i.package_id=?', [published.pack.id])).every(row => Number(row.enabled) === 0));
    } finally { copyRelease.resolve(); await copy; await revocation; }
}, { multiple: true }));

test('package stop namespace inventory preserves both historical workflows without locking mutable monitor revocation rows first', { skip: !port, timeout: 60000 }, async t => fixture(async f => {
    const published = await publishedWorkflow(f), second = await published.market.install(f.actor, published.pack.id, { version: 1 });
    await f.service.activateWorkflow(f.actor, second.workflow.id, { expectedRevision: 1 });
    await f.service.attach(f.actor, second.workflow.id, 'auto', f.monitor.id); await f.run('historical second workflow');
    await f.service.attach(f.actor, published.workflow.id, 'auto', f.monitor.id); const run = await f.run('current first workflow');
    const workflowIds = [published.workflow.id, second.workflow.id], expected = (await f.query('SELECT DISTINCT f.namespace_key FROM automation_flow_runs f JOIN automation_runs r ON r.id=f.run_id WHERE r.workflow_id IN (?)', [workflowIds])).map(row => row.namespace_key).sort();
    assert.equal(expected.length, 2);
    const workflowHeld = gate(), proceed = gate(), namespaceRead = gate(), revocationAttempt = gate(); let paused = false, observed;
    const editingDb = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
        if (sql.startsWith('UPDATE automation_flow_runs f JOIN automation_runs r ON r.id=f.run_id')) revocationAttempt.resolve();
        const result = await query(sql, params);
        if (!paused && sql === 'SELECT * FROM automation_workflows WHERE id=? FOR UPDATE' && params[0] === second.workflow.id) {
            paused = true; workflowHeld.resolve(); await proceed.promise;
        }
        return result;
    })) };
    const editing = createService(editingDb).attach(f.actor, second.workflow.id, 'auto', f.monitor.id).then(value => ({ value }), error => ({ error }));
    let stopping;
    try {
        await workflowHeld.promise;
        const stoppedDb = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
            const result = await query(sql, params);
            if (sql.startsWith('SELECT DISTINCT ') && sql.endsWith('WHERE r.workflow_id IN (?) LOCK IN SHARE MODE')) {
                observed = result.map(row => row.namespace_key).sort(); namespaceRead.resolve(); await revocationAttempt.promise;
            }
            return result;
        })) };
        stopping = createMarketplace(stoppedDb, { service: createService(stoppedDb) }).setStatus({ ...f.actor, isAdmin: true }, published.pack.id,
            { status: 'revoked', expectedVersion: 1, note: 'monitor mutation lock order fixture' }).then(value => ({ value }), error => ({ error }));
        await namespaceRead.promise; proceed.resolve();
        const results = await Promise.all([editing, stopping]); t.diagnostic(JSON.stringify(results.map(result => result.error?.code || 'fulfilled')));
        assert(results.every(result => !result.error), JSON.stringify(results.map(result => result.error?.code || 'fulfilled')));
        assert.deepEqual(observed, expected); assert.equal(await f.state(run.runId), 'excluded');
    } finally { proceed.resolve(); revocationAttempt.resolve(); await editing; await stopping; }
}, { multiple: true }));
