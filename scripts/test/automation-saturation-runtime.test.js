'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createQueue } = require('../../src/automation/queue');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createFlowRuntime } = require('../../src/automation/flow-runtime');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createTransport, snapshotSteps } = require('../../src/automation/transport');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { NODE_TYPES } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), base = Date.parse('2026-10-01T00:00:00Z'), U = '222222222222222222', C = '333333333333333333', G = '111111111111111111', M = '444444444444444444';
const node = (id, type, config = {}) => ({ id, type, config: { ...structuredClone(NODE_TYPES[type].defaults), ...config } });
const graph = (nodes, links) => ({ schemaVersion: 1, name: 'saturation runtime regression', nodes, edges: links.map(([source, target, port = 'out'], i) => ({ id: `edge${i}`, source, target, port })) });
const direct = (start = 'start', format = 'text') => graph([node(start, 'start'), node('format', 'transform', { format }), node('send', 'send')], [[start, 'format'], ['format', 'send']]);
async function fixture(definition, work, bindings = {}) {
    const db = await createTestDatabase(port); let evaluator, flow;
    try {
        const query = db.queryDatabase, service = createService(db), actor = { userId: U };
        await grantTestDonor(db, U);
        const destination = await service.saveDestination(actor, { name: 'DM', kind: 'dm' });
        const monitors = createMonitors(db, service, {}), monitor = await monitors.save(actor, 'auto', { name: 'github fixture', providerId: 'github', source: 'octocat', destinationId: destination.id });
        if (typeof bindings === 'function') bindings = await bindings({ service, actor });
        const workflow = await service.createWorkflow(actor, { definition, bindings });
        await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 }); await service.attach(actor, workflow.id, 'auto', monitor.id);
        let now = base;
        evaluator = createEvaluator(service.dictionaryData);
        const store = createGraphStore(db), queue = createQueue(db, evaluator, { clock: () => now, graph: { enabled: true, store } });
        flow = createFlowRuntime(db, evaluator, store, { assertEnabled: () => {} });
        async function add(title, extra = {}, target = monitor) {
            const source = (await query('SELECT * FROM auto_watch_targets WHERE id=?', [target.id]))[0], key = randomUUID(), token = randomUUID();
            const item = await query('INSERT INTO auto_watch_items (source_id,content_key,content_url,title,payload_json,published_at_ms,discovered_at_ms) VALUES (?,?,?,?,?,?,?)', [source.source_id, key, 'https://github.com/octocat/test', title, JSON.stringify(extra), base, now]);
            const delivery = await query("INSERT INTO auto_watch_deliveries (item_id,target_id,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,'pending',?,?,?)", [item.insertId, target.id, now, token, now + 60000]);
            return queue.route('auto', { id: String(delivery.insertId), target_id: target.id, lease_token: token, provider_id: 'github', source_key: 'octocat', content_key: key, content_url: 'https://github.com/octocat/test', title, payload_json: JSON.stringify(extra), published_at_ms: base, discovered_at_ms: now }, now);
        }
        async function drain(at = now, ticks = 70) { now = at; for (let i = 0; i < ticks; i++) { const result = await flow.tick(now); if (result.state === 'idle' && !result.projected) break; } }
        await work({ db, query, service, actor, monitor, monitors, destination, workflow, store, queue, evaluator, flow, add, drain, get now() { return now; }, set now(value) { now = value; } });
    } finally { flow?.clear(); try { await evaluator?.stop(); } finally { await db.close(); } }
}
test('S4-1 actual start ID is used and send called start cannot bypass selection', { skip: !port }, async () => {
    await fixture(direct('entry'), async f => { await f.add('custom start'); await f.drain(); assert.equal((await f.query('SELECT state FROM automation_jobs'))[0].state, 'pending'); });
    const definition = graph([node('entry', 'start', { providers: ['youtube'] }), node('start', 'send')], [['entry', 'start']]);
    await fixture(definition, async f => { const result = await f.add('wrong service'); await f.drain(); assert.equal((await f.query('SELECT * FROM automation_jobs')).length, 0); assert.equal((await f.query('SELECT state FROM automation_runs WHERE id=?', [result.runId]))[0].state, 'excluded'); });
});
test('S4-1 historical pending and expired-leased initial activations recover the immutable start guard', { skip: !port, timeout: 45000 }, async () => {
    const cases = [
        { definition: direct('entry'), sends: 1 },
        { definition: graph([node('entry', 'start', { providers: ['youtube'] }), node('start', 'send')], [['entry', 'start']]), sends: 0 },
        { definition: graph([node('entry', 'start', { providers: ['github'] }), node('start', 'send')], [['entry', 'start']]), sends: 1 },
        { definition: direct(), sends: 1 },
    ];
    for (const state of ['pending', 'leased']) for (const scenario of cases) await fixture(scenario.definition, async f => {
        const admitted = await f.add(`historical ${state}`);
        const initial = (await f.query('SELECT s.* FROM automation_flow_steps s JOIN automation_flow_members m ON m.unit_id=s.input_unit_id WHERE m.run_id=?', [admitted.runId]))[0];
        // Recreate the exact pre-fix initial shape; no completed work is reset.
        await f.query("UPDATE automation_flow_steps SET node_id='start',state=?,lease_token=?,lease_until_ms=?,evaluation_at_ms=? WHERE id=?", [state, state === 'leased' ? randomUUID() : null, state === 'leased' ? base - 1 : 0, state === 'leased' ? base - 1000 : null, initial.id]);
        f.flow.clear();
        const restarted = createFlowRuntime(f.db, f.evaluator, createGraphStore(f.db), { assertEnabled: () => {} });
        try { for (let tick = 0; tick < 12; tick++) await restarted.tick(base); }
        finally { restarted.clear(); }
        const saved = (await f.query('SELECT node_id,state,input_unit_id,activation_key FROM automation_flow_steps WHERE id=?', [initial.id]))[0];
        assert.equal(saved.node_id, scenario.definition.nodes.find(item => item.type === 'start').id); assert.equal(saved.state, 'complete'); assert.equal(saved.input_unit_id, initial.input_unit_id); assert.equal(saved.activation_key, initial.activation_key);
        assert.equal((await f.query('SELECT * FROM automation_jobs')).length, scenario.sends);
        if (!scenario.sends) assert.equal((await f.query('SELECT state FROM automation_runs WHERE id=?', [admitted.runId]))[0].state, 'excluded');
    });
});
test('S4-1 progressed downstream node named start is preserved across restart', { skip: !port }, async () => {
    const definition = graph([node('entry', 'start', { providers: ['github'] }), node('start', 'send')], [['entry', 'start']]);
    await fixture(definition, async f => {
        await f.add('accepted post'); await f.flow.tick(base);
        const downstream = (await f.query("SELECT * FROM automation_flow_steps WHERE node_id='start'"))[0]; assert(downstream.via_edge_id);
        f.flow.clear(); const restarted = createFlowRuntime(f.db, f.evaluator, createGraphStore(f.db), { assertEnabled: () => {} });
        try { for (let tick = 0; tick < 8; tick++) await restarted.tick(base); } finally { restarted.clear(); }
        assert.equal((await f.query('SELECT * FROM automation_flow_steps')).length, 2);
        assert.equal((await f.query('SELECT node_id,state FROM automation_flow_steps WHERE id=?', [downstream.id]))[0].node_id, 'start');
        assert.equal((await f.query('SELECT * FROM automation_jobs')).length, 1);
    });
});
test('N1 legacy DM and two webhook destinations project beside Dashboard registrations', { skip: !port }, async () => fixture(direct(), async f => {
    const targets = [f.monitor];
    for (const name of ['github', 'microsoft', 'google']) targets.push(await f.monitors.save(f.actor, 'auto', { name, providerId: 'github', source: name, destinationId: f.destination.id }));
    for (const target of targets.slice(1)) await f.service.attach(f.actor, f.workflow.id, 'auto', target.id);
    await f.query('DELETE FROM automation_monitors WHERE target_kind=? AND target_id IN (?)', ['auto', targets.slice(0, 3).map(target => target.id)]);
    const webhookIds = [];
    for (const target of targets.slice(1, 3)) {
        const url = `https://discord.com/api/webhooks/${M}/${String(target.id).padStart(60, 'a')}`;
        const endpoint = await f.query('INSERT INTO webhook_endpoints (webhook_url,webhook_url_hash) VALUES (?,?)', [url, createHash('sha256').update(url).digest('hex')]); webhookIds.push(String(endpoint.insertId));
        await f.query("UPDATE auto_watch_targets SET destination_type='webhook',destination_key=?,webhook_endpoint_id=?,guild_id=? WHERE id=?", [`webhook:${endpoint.insertId}`, endpoint.insertId, G, target.id]);
    }
    const guildActor = { ...f.actor, guildId: G, canEdit: true, canView: true };
    const guildWorkflow = await f.service.createWorkflow(guildActor, { scope: 'guild', definition: direct() });
    await f.service.activateWorkflow(guildActor, guildWorkflow.id, { expectedRevision: 1 });
    for (const target of targets.slice(1, 3)) await f.service.attach(guildActor, guildWorkflow.id, 'auto', target.id);
    for (const [index, target] of targets.entries()) await f.add(`destination ${index}`, {}, target);
    await f.drain(); const jobs = await f.query('SELECT destination_id,plan_json FROM automation_jobs');
    assert.equal(jobs.length, 4); assert.equal(jobs.filter(job => job.destination_id === null).length, 3);
    assert.deepEqual(jobs.map(job => JSON.parse(job.plan_json).context.webhookEndpointId).filter(Boolean).sort(), webhookIds.sort());
}));
test('N1 one invalid legacy destination is terminal and never blocks a later healthy send intent', { skip: !port }, async () => fixture(direct(), async f => {
    const invalid = await f.add('invalid destination'), healthy = await f.add('healthy destination');
    const row = (await f.query('SELECT context_json FROM automation_flow_runs WHERE run_id=?', [invalid.runId]))[0], context = JSON.parse(row.context_json);
    context.destinationId = null; context.sourceContext.destinationType = 'invalid';
    await f.query('UPDATE automation_flow_runs SET context_json=? WHERE run_id=?', [JSON.stringify(context), invalid.runId]);
    await f.drain();
    assert.equal((await f.query("SELECT * FROM automation_flow_sends WHERE state='unprojected'")).length, 0);
    assert.equal((await f.query('SELECT state FROM automation_runs WHERE id=?', [invalid.runId]))[0].state, 'failed');
    assert.equal((await f.query('SELECT * FROM automation_jobs WHERE run_id=?', [healthy.runId])).length, 1);
    for (let tick = 0; tick < 4; tick++) await f.flow.tick(f.now);
}));
test('N3 single direct expansion invokes provider and retains hide/links controls', { skip: !port }, async () => fixture(direct('start', 'expanded'), async f => {
    await f.add('rich'); await f.drain();
    // Exercise a queued pre-fix snapshot as well as newly projected output.
    const saved = (await f.query('SELECT id,plan_json FROM automation_jobs'))[0], oldPlan = JSON.parse(saved.plan_json); delete oldPlan.aggregateSnapshot;
    await f.query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(oldPlan), saved.id]);
    const job = (await f.queue.refreshFlowJob(await f.queue.claim(f.now), f.now)).job;
    assert.equal(job.plan.aggregateSnapshot, false);
    const loader = require('../../src/providers/_loader'), original = loader.loadProviders; let calls = 0;
    loader.loadProviders = () => [{ id: 'github', extract: async () => { calls++; return [{ embeds: [{ title: 'provider image', image: { url: 'https://example.org/image.png' } }] }]; } }];
    try {
        const transport = createTransport(f.db, {}, { options: { jsonTransformer: value => value } }, { rest: { post: async () => ({ id: C }) }, skipProviderBudget: true });
        for (const mode of ['inherit', 'hide', 'links']) {
            job.plan.display.media = mode;
            const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: U }), payload = prepared.payloads[0].body;
            assert.equal(payload.embeds[0].title, 'provider image'); assert.equal(!!payload.embeds[0].image, mode === 'inherit');
            assert.equal(String(payload.content || '').includes('https://example.org/image.png'), mode === 'links');
        }
        assert.equal(calls, 3);
    } finally { loader.loadProviders = original; }
}));
test('N6 excluded, waiting and queued decisions survive as public run history', { skip: !port }, async () => {
    const stopped = graph([node('start', 'start'), node('stop', 'stop', { reason: 'この条件では通知しません' })], [['start', 'stop']]);
    await fixture(stopped, async f => { const result = await f.add('excluded'); await f.drain(); const run = (await f.query('SELECT state,trace_json FROM automation_runs WHERE id=?', [result.runId]))[0]; assert.equal(run.state, 'excluded'); assert(JSON.parse(run.trace_json).some(entry => entry.reason === 'この条件では通知しません')); assert.equal((await require('../../src/automation/history').createHistory(f.db, f.service).excluded(f.actor)).items.length, 1); });
    const delayed = graph([node('start', 'start'), node('wait', 'delay', { minutes: 1 }), node('send', 'send')], [['start', 'wait'], ['wait', 'send']]);
    await fixture(delayed, async f => { const result = await f.add('wait'); await f.drain(); assert.equal((await f.query('SELECT state FROM automation_runs WHERE id=?', [result.runId]))[0].state, 'waiting'); const history = require('../../src/automation/history').createHistory(f.db, f.service); assert.equal((await history.excluded(f.actor)).items[0].state, 'waiting'); await f.drain(base + 60000); assert.equal((await f.query('SELECT state FROM automation_runs WHERE id=?', [result.runId]))[0].state, 'queued'); assert.equal((await history.excluded(f.actor)).items.length, 0, 'projected jobs use the delivery list rather than duplicate run rows'); });
});
test('N7 observed-price normal sends retain ordinary Bot expansion handoff', () => {
    const plan = { defaultPriceText: '価格 900円\nhttps://example.org/product', display: { format: 'normal' } };
    assert.equal(snapshotSteps(plan, 'price')[0].normalExpansion, true);
    assert.equal(snapshotSteps({ ...plan, display: { format: 'expanded' } }, 'price')[0].normalExpansion, undefined);
});
test('T2 dictionary diagnostic cardinality agrees for 8,9,21 matches and unmatched control', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('words', 'dictionary', { dictionary: 'words', fields: ['body'] }), node('send', 'send'), node('stop', 'stop')], [['start', 'words'], ['words', 'send', 'yes'], ['words', 'stop', 'no'], ['words', 'stop', 'unknown']]);
    await fixture(definition, async f => {
        for (const count of [8, 9, 21, 0]) {
            const body = count ? 'sale '.repeat(count) : 'ordinary release';
            const bindings = JSON.parse((await f.query('SELECT bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=1', [f.workflow.id]))[0].bindings_json);
            const simulation = await f.evaluator.evaluate(definition, { providerId: 'github', title: 'fixture', body, observedAtMs: base }, bindings, f.now);
            await f.add(`matches ${count}`, { body }); await f.drain(); assert.equal(simulation.outputs.length, count ? 1 : 0);
        }
        assert.equal((await f.query('SELECT * FROM automation_jobs')).length, 3);
        assert.equal((await f.query("SELECT * FROM automation_flow_steps WHERE state='leased'")).length, 0);
    }, async ({ service, actor }) => { const dictionary = await service.saveDictionary(actor, { dictionary: { schemaVersion: 1, name: 'matching words', entries: ['sale'] } }); return { dictionaries: { words: { id: dictionary.id, revision: 1 } } }; });
});
test('T6 projected frozen maximum wait survives reload and exact deadline boundary', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('time', 'schedule', { zone: 'UTC', windows: [{ start: '00:00', end: '24:00' }], maxWaitDays: 1 }), node('send', 'send')], [['start', 'time'], ['time', 'send']]);
    await fixture(definition, async f => { await f.add('deadline'); await f.drain(); const job = await f.queue.claim(base); assert.equal(Number(job.deadline_ms), base + 86400000); assert.equal((await f.queue.check(job, base + 86400000)).state, 'ready'); f.flow.clear(); assert.equal((await createQueue(f.db, f.evaluator, { clock: () => base + 86400001 }).check(job, base + 86400001)).state, 'expired'); });
});
test('S4-2 expired aggregate member is pruned while its healthy peer remains sendable', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('batch', 'aggregate', { minutes: 1, key: 'all' }), node('send', 'send')], [['start', 'batch'], ['batch', 'send']]); definition.expiresAfterMinutes = 3;
    await fixture(definition, async f => { await f.add('older'); await f.drain(); f.now = base + 30000; await f.add('healthy'); await f.drain(); await f.drain(base + 60000); const job = await f.queue.claim(base + 180001); assert.equal(job.plan.members.length, 2); const refreshed = await f.queue.refreshFlowJob(job, base + 180001); assert.equal(refreshed.state, 'ready'); assert.deepEqual(refreshed.job.plan.members.map(member => member.event.title), ['healthy']); assert.equal((await f.queue.check(refreshed.job, base + 180001)).state, 'ready'); });
});
test('S4-2 and N6 expired anchor and non-anchor runs stay visible only in their own monitor history', { skip: !port, timeout: 30000 }, async () => {
    const definition = graph([node('start', 'start'), node('choose', 'condition', { predicate: { field: 'title', op: 'contains', value: 'older' } }),
        node('short', 'schedule', { zone: 'UTC', maxWaitDays: 1, windows: [{ start: '00:00', end: '24:00' }] }),
        node('long', 'schedule', { zone: 'UTC', maxWaitDays: 2, windows: [{ start: '00:00', end: '24:00' }] }),
        node('batch', 'aggregate', { minutes: 1, key: 'all' }), node('send', 'send'), node('stop', 'stop')],
    [['start', 'choose'], ['choose', 'short', 'yes'], ['choose', 'long', 'no'], ['choose', 'stop', 'unknown'], ['short', 'batch'], ['long', 'batch'], ['batch', 'send']]);
    for (const expiredAnchor of [true, false]) await fixture(definition, async f => {
        const second = await f.monitors.save(f.actor, 'auto', { name: 'second source', providerId: 'github', source: 'github', destinationId: f.destination.id }); await f.service.attach(f.actor, f.workflow.id, 'auto', second.id);
        const firstRun = await f.add(expiredAnchor ? 'older first' : 'healthy first'); await f.drain(); f.now = base + 30000;
        const secondRun = await f.add(expiredAnchor ? 'healthy second' : 'older second', {}, second); await f.drain(); await f.drain(base + 60000);
        const expiredTarget = expiredAnchor ? f.monitor : second, healthyTarget = expiredAnchor ? second : f.monitor, expiredRun = expiredAnchor ? firstRun : secondRun, healthyRun = expiredAnchor ? secondRun : firstRun;
        const original = (await f.query('SELECT id,run_id FROM automation_jobs'))[0]; assert.equal(original.run_id, firstRun.runId);
        f.now = base + 86400000 + (expiredAnchor ? 0 : 30000) + 1;
        f.flow.clear(); const refreshed = await f.queue.refreshFlowJob(await f.queue.claim(f.now), f.now); assert.equal(refreshed.state, 'ready'); assert.deepEqual(refreshed.job.plan.members.map(member => member.runId), [healthyRun.runId]);
        const history = require('../../src/automation/history').createHistory(f.db, f.service);
        const allRuns = await history.excluded(f.actor); assert.deepEqual(allRuns.items.map(run => run.id), [expiredRun.runId]); assert.equal(allRuns.items[0].state, 'expired'); assert(allRuns.items[0].trace.some(item => item.reason === 'DEADLINE_EXCEEDED'));
        const expiredPage = await history.list(f.actor, { targetKind: 'auto', targetId: expiredTarget.id }); assert.equal(expiredPage.items.length, 0); assert.deepEqual(expiredPage.activity, { lastSentAtMs: null, nextDueAtMs: null }); assert.deepEqual(expiredPage.ruleRuns.map(run => run.id), [expiredRun.runId]);
        const healthyPage = await history.list(f.actor, { targetKind: 'auto', targetId: healthyTarget.id }); assert.equal(healthyPage.items.length, 1); assert.equal(healthyPage.items[0].targetId, healthyTarget.id); assert.match(healthyPage.items[0].title, /healthy/); assert.equal(healthyPage.ruleRuns.length, 0);
        const detail = await history.detail(f.actor, original.id); assert.match(detail.event.title, /healthy/); assert(!detail.trace.some(item => item.outcome === 'expired'));
        const query = new URLSearchParams({ targetKind: 'auto', targetId: expiredTarget.id }); const { dispatch } = require('../../src/automation/api');
        assert.deepEqual((await dispatch({ method: 'GET', path: ['excluded'], search: query }, f.actor, { history })).items.map(run => run.id), [expiredRun.runId]);
        assert.equal((await history.excluded({ userId: '999999999999999999' }, '', { targetKind: 'auto', targetId: expiredTarget.id })).items.length, 0);
        await assert.rejects(history.excluded(f.actor, '', { targetKind: 'auto' }), { code: 'INVALID_TARGET' });
        await f.queue.transition(refreshed.job, 'pending', null, f.now);
        const transport = require('../../src/automation/transport').createTransport(f.db, {}, { options: { jsonTransformer: value => value } }, { clock: () => f.now, rest: { post: async route => route === '/users/@me/channels' ? { id: C } : { id: M, channel_id: C } } });
        const runner = require('../../src/automation/runtime').createRunner(f.db, f.queue, transport, { clock: () => f.now, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => { f.now += ms; } });
        assert.equal((await runner.tick()).state, 'sent');
        const sentPage = await history.list(f.actor, { targetKind: 'auto', targetId: healthyTarget.id }); assert.equal(sentPage.items[0].state, 'sent'); assert(sentPage.activity.lastSentAtMs); assert.equal(sentPage.ruleRuns.length, 0);
        const stillExpired = await history.list(f.actor, { targetKind: 'auto', targetId: expiredTarget.id }); assert.equal(stillExpired.items.length, 0); assert.equal(stillExpired.ruleRuns.length, 1); assert.equal(stillExpired.activity.lastSentAtMs, null);
    });
});
test('S4-2 disjoint member schedules wake at the first expiry and preserve a manual lower bound', { skip: !port }, async () => {
    const day = 86400000, monday = Date.parse('2026-10-05T00:00:00Z');
    const definition = graph([node('start', 'start'), node('kind', 'condition', { predicate: { field: 'title', op: 'contains', value: 'older' } }),
        node('mondays', 'schedule', { zone: 'UTC', days: [1], windows: [{ start: '00:00', end: '24:00' }], maxWaitDays: 14 }),
        node('tuesdays', 'schedule', { zone: 'UTC', days: [2], windows: [{ start: '00:00', end: '24:00' }], maxWaitDays: 15 }),
        node('batch', 'aggregate', { minutes: 10080, key: 'all' }), node('send', 'send'), node('stop', 'stop')],
    [['start', 'kind'], ['kind', 'mondays', 'yes'], ['kind', 'tuesdays', 'no'], ['kind', 'stop', 'unknown'], ['mondays', 'batch'], ['tuesdays', 'batch'], ['batch', 'send']]);
    for (const manual of [false, true]) await fixture(definition, async f => {
        f.now = monday; await f.add('older member'); await f.drain(); f.now = monday + day; await f.add('healthy member'); await f.drain();
        const closes = Number((await f.query("SELECT closes_at_ms FROM automation_flow_batches WHERE node_id='batch'"))[0].closes_at_ms);
        await f.drain(closes); let jobs = await f.query('SELECT * FROM automation_jobs');
        assert.equal(jobs.length, 1, 'healthy member has a Tuesday window after the Monday member expires');
        assert.equal(Number(jobs[0].due_at_ms), monday + 14 * day + 1);
        const requested = monday + 15 * day + 12 * 3600000;
        if (manual) {
            const history = require('../../src/automation/history').createHistory(f.db, f.service), selected = await history.detail(f.actor, jobs[0].id), actualNow = Date.now;
            try { Date.now = () => f.now; await history.change(f.actor, selected.id, { action: 'reschedule', expectedVersion: selected.version, dueAtMs: requested }); }
            finally { Date.now = actualNow; }
        }
        f.now = monday + 14 * day + 1;
        if (manual) assert.equal(await f.queue.claim(f.now), null, 'manual reservation cannot be advanced by internal expiry wakeup');
        else {
            const refreshed = await f.queue.refreshFlowJob(await f.queue.claim(f.now), f.now); assert.deepEqual(refreshed.job.plan.members.map(member => member.event.title), ['healthy member']);
            const checked = await f.queue.check(refreshed.job, f.now); assert.equal(checked.state, 'pending'); assert.equal(checked.dueAtMs, monday + 15 * day);
            await f.queue.transition(refreshed.job, 'pending', checked.code, checked.dueAtMs);
        }
        f.now = manual ? requested : monday + 15 * day;
        const ready = await f.queue.refreshFlowJob(await f.queue.claim(f.now), f.now); assert.equal(ready.state, 'ready'); assert.deepEqual(ready.job.plan.members.map(member => member.event.title), ['healthy member']);
        assert.equal((await f.queue.check(ready.job, f.now)).state, 'ready');
        jobs = await f.query('SELECT plan_json FROM automation_jobs'); assert.equal(JSON.parse(jobs[0].plan_json).members.some(member => member.event.title === 'older member'), false);
    });
});
for (const after of [true, false]) for (const op of ['gte', 'lte']) test(`S5-1 age ${op} ${after ? 'after' : 'before'} delay matches ordered SQL execution`, { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('wait', 'delay', { minutes: 60 }), node('age', 'condition', { predicate: { field: 'ageMinutes', op, value: 30 } }), node('send', 'send'), node('stop', 'stop')], after ? [['start', 'wait'], ['wait', 'age'], ['age', 'send', 'yes'], ['age', 'stop', 'no'], ['age', 'stop', 'unknown']] : [['start', 'age'], ['age', 'wait', 'yes'], ['age', 'stop', 'no'], ['age', 'stop', 'unknown'], ['wait', 'send']]);
    const simulated = evaluateWorkflow(definition, { title: 'post', publishedAtMs: base, observedAtMs: base }, { now: base }).outputs.length;
    assert.equal(simulated, after === (op === 'gte') ? 1 : 0);
    await fixture(definition, async f => { await f.add('post'); await f.drain(); f.flow.clear(); await f.drain(base + 3600000); assert.equal((await f.query('SELECT * FROM automation_jobs')).length, simulated); });
});
for (const scheduleFirst of [true, false]) test(`S5-1 horizon freezes at schedule entry ${scheduleFirst}`, { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('time', 'schedule', { zone: 'UTC', windows: [{ start: '00:00', end: '24:00' }], maxWaitDays: 1 }), node('wait', 'delay', { minutes: 2880 }), node('send', 'send')], scheduleFirst ? [['start', 'time'], ['time', 'wait'], ['wait', 'send']] : [['start', 'wait'], ['wait', 'time'], ['time', 'send']]);
    const simulated = evaluateWorkflow(definition, { observedAtMs: base }, { now: base }).outputs.length;
    assert.equal(simulated, scheduleFirst ? 0 : 1);
    await fixture(definition, async f => { await f.add('post'); await f.drain(); f.flow.clear(); await f.drain(base + 2 * 86400000); assert.equal((await f.query('SELECT * FROM automation_jobs')).length, simulated); });
});
test('S5-1 unequal aggregate branches merge at the later close without false rejection', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('one', 'aggregate', { minutes: 1 }), node('two', 'aggregate', { minutes: 2 }), node('join', 'merge', { mode: 'all' }), node('send', 'send')], [['start', 'one'], ['start', 'two'], ['one', 'join'], ['two', 'join'], ['join', 'send']]);
    const result = evaluateWorkflow(definition, { observedAtMs: base }, { now: base }); assert.equal(result.outputs.length, 1); assert.equal(result.outputs[0].dueAtMs, base + 120000);
    await fixture(definition, async f => { await f.add('post'); await f.drain(); await f.drain(base + 60000); assert.equal((await f.query('SELECT * FROM automation_jobs')).length, 0); f.flow.clear(); await f.drain(base + 120000); const jobs = await f.query('SELECT due_at_ms,created_at_ms FROM automation_jobs'); assert.equal(jobs.length, result.outputs.length); assert.equal(Math.max(Number(jobs[0].due_at_ms), Number(jobs[0].created_at_ms)), result.outputs[0].dueAtMs); });
});
test('S7-1 oversized accepted aggregate records terminal failure and healthy work still advances', { skip: !port, timeout: 60000 }, async () => {
    const branches = Array.from({ length: 32 }, (_unused, index) => node(`copy${index}`, 'delay', { minutes: 0 }));
    const definition = graph([node('start', 'start'), ...branches, node('hour', 'aggregate', { key: 'all', minutes: 60, maxItems: 100 }), node('days', 'aggregate', { key: 'all', minutes: 2880, maxItems: 100 }), node('send', 'send')], [...branches.flatMap(branch => [['start', branch.id], [branch.id, 'hour']]), ['hour', 'days'], ['days', 'send']]);
    await fixture(definition, async f => {
        for (let index = 0; index < 5; index++) {
            f.now = Math.floor(base / (2880 * 60000)) * 2880 * 60000 + index * 6 * 3600000; await f.add(`release ${index}`, { body: 'a'.repeat(60000) });
            await f.drain(f.now, 300); await f.drain(f.now + 3600000, 300);
        }
        const closing = (await f.query("SELECT MAX(closes_at_ms) AS due FROM automation_flow_batches WHERE node_id='days'"))[0];
        await f.drain(Number(closing.due), 300);
        const failed = await f.query("SELECT state,outcome_json FROM automation_flow_batches WHERE node_id='days'");
        assert.equal(failed.length, 1); assert.equal(failed[0].state, 'failed'); assert.equal(JSON.parse(failed[0].outcome_json).code, 'GRAPH_INPUT_LIMIT');
        assert.equal((await f.query('SELECT * FROM automation_jobs')).length, 0);
        assert((await f.query('SELECT trace_json FROM automation_runs')).every(run => JSON.parse(run.trace_json).some(entry => entry.reason === 'GRAPH_INPUT_LIMIT')));
        const healthy = await f.monitors.save(f.actor, 'auto', { name: 'healthy monitor', providerId: 'github', source: 'github', destinationId: f.destination.id });
        const workflow = await f.service.createWorkflow(f.actor, { definition: direct() }); await f.service.activateWorkflow(f.actor, workflow.id, { expectedRevision: 1 }); await f.service.attach(f.actor, workflow.id, 'auto', healthy.id);
        await f.add('healthy', {}, healthy); await f.drain(f.now, 300); assert.equal((await f.query('SELECT * FROM automation_jobs')).length, 1);
        for (let index = 0; index < 4; index++) await f.flow.tick(f.now);
        assert.equal((await f.query("SELECT * FROM automation_flow_batches WHERE node_id='days' AND state='open'")).length, 0);
        assert.equal((await f.query('SELECT * FROM automation_flow_batch_inputs')).length, 165, 'original inputs remain for diagnosis; no truncation or silent split');
    });
});
