'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { NODE_TYPES } = require('../../src/automation/schema');
const { compileWorkflow } = require('../../src/automation/graph-plan');
const { createGraphStore } = require('../../src/automation/graph-store');
const { createGraphDriver } = require('../../src/automation/graph-driver');
const { stepNode } = require('../../src/automation/graph-step');
const { DictionaryMatcher } = require('../../src/automation/dictionary');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), time = Date.parse('2026-09-22T10:00:00Z');
const node = (id, type, config = {}) => ({ id, type, config: { ...structuredClone(NODE_TYPES[type].defaults), ...config } });
const graph = (nodes, links) => ({ schemaVersion: 1, name: 'driver fixture', nodes, edges: links.map(([source, target, port = 'out'], i) => ({ id: `edge${i}`, source, target, port })) });
async function fixture(definition, work) {
    const db = await createTestDatabase(port), query = db.queryDatabase;
    const service = createService(db), actor = { userId: '222222222222222222' };
    const workflow = await service.createWorkflow(actor, { definition });
    const context = { ownerUserId: actor.userId, scope: 'private', workflowId: workflow.id, revision: 1 };
    const plan = compileWorkflow(definition), store = () => createGraphStore(db);
    const dictionaries = { words: new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', entries: ['sale'] }) };
    const driver = () => createGraphDriver(store(), { assertEnabled: () => {}, loadPlan: async () => plan, evaluateStep: async (node, unit, now) => stepNode(node, unit, { now, dictionaries }) });
    async function add(input) {
        const runId = randomUUID(), event = { ...input, observedAtMs: time };
        await query("INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,1,?,'private','auto',1,?,'[]','queued',?)", [runId, hash(runId), workflow.id, actor.userId, JSON.stringify(event), time]);
        await store().initialize({ runId, context, nodeId: 'start', now: time, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event, display: NODE_TYPES.transform.defaults, schedules: [], dueAtMs: time, deadlineMs: null, defaultPriceText: null }] } });
        return runId;
    }
    async function drain(now) {
        const runner = driver();
        for (let i = 0; i < 5000; i++) { const result = await runner.tick(now); if (result.state === 'idle') return i; }
        throw new Error('Fixture graph did not become quiescent');
    }
    async function sends() {
        const rows = await query('SELECT * FROM automation_flow_sends ORDER BY id');
        return Promise.all(rows.map(async row => ({ ...row, unit: await store().readUnit(row.unit_id, true) })));
    }
    try { await work({ db, query, store, driver, add, drain, sends }); }
    finally { await db.close(); }
}
test('disconnected driver requires an explicit enable boundary and valid clock before any storage work', async () => {
    assert.throws(() => createGraphDriver({}, {}), /FLOW_DRIVER_DEPENDENCIES_REQUIRED/);
    let enabledCalls = 0;
    const runner = createGraphDriver({}, { assertEnabled: () => { enabledCalls++; }, loadPlan: async () => null });
    for (const invalid of [undefined, NaN, Infinity, 1.5, 9e15]) await assert.rejects(runner.tick(invalid), /FLOW_TIME_INVALID/);
    assert.equal(enabledCalls, 0);
});
test('ordered limits count 4 events, 2 intermediate batches, 1 final batch and fan out into two durable send intents', { skip: !port }, async () => {
    const nodes = [node('start', 'start'), node('L0', 'limit', { key: 'all', count: 100 }), node('A10', 'aggregate', { key: 'all', minutes: 10, maxItems: 2 }),
        node('L1', 'limit', { key: 'all', count: 100 }), node('A20', 'aggregate', { key: 'all', minutes: 20 }), node('L2', 'limit', { key: 'all', count: 100 }), node('sendA', 'send'), node('sendB', 'send', { destination: 'second' })];
    const definition = graph(nodes, [['start', 'L0'], ['L0', 'A10'], ['A10', 'L1'], ['L1', 'A20'], ['A20', 'L2'], ['L2', 'sendA'], ['L2', 'sendB']]);
    await fixture(definition, async f => {
        for (let i = 0; i < 4; i++) await f.add({ title: `event${i}`, providerId: 'github' });
        await f.drain(time);
        assert.deepEqual((await f.query('SELECT used_count FROM automation_counters ORDER BY used_count')).map(row => Number(row.used_count)), [4]);
        assert.equal((await f.sends()).length, 0);
        await f.drain(time + 600000);
        assert.deepEqual((await f.query('SELECT used_count FROM automation_counters ORDER BY used_count')).map(row => Number(row.used_count)), [2, 4]);
        assert.equal((await f.sends()).length, 0);
        await f.drain(time + 1200000);
        assert.deepEqual((await f.query('SELECT used_count FROM automation_counters ORDER BY used_count')).map(row => Number(row.used_count)), [1, 2, 4]);
        const sends = await f.sends(); assert.equal(sends.length, 2); assert(sends.every(row => row.state === 'unprojected' && row.unit.members.length === 4));
        const batches = await f.query('SELECT node_id,received_count FROM automation_flow_batches ORDER BY node_id,segment');
        assert.deepEqual(batches.map(row => [row.node_id, Number(row.received_count)]), [['A10', 2], ['A10', 2], ['A20', 2]]);
        await f.drain(time + 1200000); assert.equal((await f.sends()).length, 2);
        assert.equal(Number((await f.query('SELECT COUNT(*) AS n FROM automation_jobs'))[0].n), 0, 'new executor never enters the existing live delivery queue');
    });
});
test('after an aggregate, whole predicates partition yes/no/unknown members and transforms preserve raw metadata', { skip: !port }, async () => {
    const nodes = [node('start', 'start'), node('before', 'transform', { format: 'text', template: 'before {title}' }), node('batch', 'aggregate', { key: 'all', minutes: 10 }),
        node('condition', 'condition', { predicate: { field: 'priceAmount', op: 'lt', value: 150 } }),
        node('yes', 'transform', { format: 'text', template: 'yes {title}' }), node('no', 'send', { destination: 'no' }), node('unknown', 'send', { destination: 'unknown' }), node('send', 'send', { destination: 'yes' })];
    await fixture(graph(nodes, [['start', 'before'], ['before', 'batch'], ['batch', 'condition'], ['condition', 'yes', 'yes'], ['condition', 'no', 'no'], ['condition', 'unknown', 'unknown'], ['yes', 'send']]), async f => {
        await f.add({ title: 'low', priceAmount: 100 }); await f.add({ title: 'high', priceAmount: 200 }); await f.add({ title: 'missing' });
        await f.drain(time); await f.drain(time + 600000);
        const sends = await f.sends(); assert.equal(sends.length, 3);
        const outputs = Object.fromEntries(sends.map(row => [row.destination_alias, row.unit.members]));
        assert.equal(outputs.yes[0].event.title, 'low'); assert.equal(outputs.yes[0].display.template, 'yes {title}');
        assert.equal(outputs.no[0].event.title, 'high'); assert.equal(outputs.no[0].display.template, 'before {title}');
        assert.equal(outputs.unknown[0].event.priceAmount, undefined); assert.equal(outputs.unknown[0].event.title, 'missing');
    });
});
test('unequal overlapping batch joins survive restart and emit lineage intersection or union once', { skip: !port }, async t => {
    for (const mode of ['all', 'any']) await t.test(mode, async () => {
        const nodes = [node('start', 'start'), node('leftSelect', 'condition', { predicate: { field: 'title', op: 'ne', value: 'c' } }), node('rightSelect', 'condition', { predicate: { field: 'title', op: 'ne', value: 'a' } }),
            node('left', 'aggregate', { key: 'all', minutes: 10 }), node('right', 'aggregate', { key: 'all', minutes: 20 }), node('join', 'merge', { mode }), node('send', 'send'), node('stopLeft', 'stop'), node('stopRight', 'stop')];
        const definition = graph(nodes, [['start', 'leftSelect'], ['start', 'rightSelect'], ['leftSelect', 'left', 'yes'], ['leftSelect', 'stopLeft', 'no'], ['rightSelect', 'right', 'yes'], ['rightSelect', 'stopRight', 'no'], ['left', 'join'], ['right', 'join'], ['join', 'send']]);
        await fixture(definition, async f => {
            for (const title of ['a', 'b', 'c']) await f.add({ title });
            await f.drain(time); await f.drain(time + 600000); assert.equal((await f.sends()).length, mode === 'any' ? 1 : 0);
            await f.drain(time + 1200000);
            const sends = await f.sends();
            assert.deepEqual(sends.flatMap(row => row.unit.members.map(member => member.event.title)).sort(), mode === 'all' ? ['b'] : ['a', 'b', 'c']);
            assert.equal(sends.length, mode === 'all' ? 1 : 3);
            await f.drain(time + 1200000); assert.equal((await f.sends()).length, sends.length);
        });
    });
});
test('heterogeneous post-batch limits split into typed-key admissions rather than charging the first member key', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('batch', 'aggregate', { key: 'all', minutes: 10 }), node('limit', 'limit', { key: 'providerId', count: 1, minutes: 60, overflow: 'drop' }), node('send', 'send')], [['start', 'batch'], ['batch', 'limit'], ['limit', 'send']]);
    await fixture(definition, async f => {
        for (const providerId of ['github', 'github', 'spotify', undefined, 'unknown']) await f.add({ title: providerId || 'missing', ...(providerId ? { providerId } : {}) });
        await f.drain(time); await f.drain(time + 600000);
        const first = await f.sends(); assert.equal(first.length, 4);
        assert.deepEqual(first.map(row => row.unit.members.length).sort(), [1, 1, 1, 2]);
        assert.deepEqual((await f.query('SELECT used_count FROM automation_counters')).map(row => Number(row.used_count)), [1, 1, 1, 1]);
        await f.add({ title: 'later', providerId: 'github' });
        await f.drain(time + 600001); await f.drain(time + 1200000);
        assert.equal((await f.sends()).length, 4);
    });
});
test('latest followed by a failing dictionary does not substitute an older matching event', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('batch', 'aggregate', { key: 'all', minutes: 10, mode: 'latest' }), node('dictionary', 'dictionary', { dictionary: 'words', fields: ['title'] }), node('send', 'send'), node('stop', 'stop')], [['start', 'batch'], ['batch', 'dictionary'], ['dictionary', 'send', 'yes'], ['dictionary', 'stop', 'no']]);
    await fixture(definition, async f => {
        await f.add({ title: 'sale' }); await f.drain(time);
        await f.add({ title: 'ordinary' }); await f.drain(time + 1);
        await f.drain(time + 600000);
        assert.equal((await f.sends()).length, 0);
        const batch = (await f.query('SELECT outcome_json FROM automation_flow_batches'))[0];
        assert.equal(JSON.parse(batch.outcome_json).supersededInputs.length, 1);
    });
});
test('a condition after durable delay sees the later age and no send intent appears before the wait ends', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('delay', 'delay', { minutes: 1 }), node('condition', 'condition', { predicate: { field: 'ageMinutes', op: 'gte', value: 1 } }), node('send', 'send'), node('stop', 'stop')], [['start', 'delay'], ['delay', 'condition'], ['condition', 'send', 'yes'], ['condition', 'stop', 'no']]);
    await fixture(definition, async f => {
        await f.add({ title: 'wait', publishedAtMs: time }); await f.drain(time);
        await f.drain(time + 59999); assert.equal((await f.sends()).length, 0);
        await f.drain(time + 60000); assert.equal((await f.sends()).length, 1);
        const member = (await f.sends())[0].unit.members[0];
        assert.equal(member.event.ageMinutes, undefined, 'derived age never overwrites original observation');
    });
});
test('a member pruned from a waiting batch closes only its own merge path; its any-merge does not wait for healthy peers', { skip: !port }, async () => {
    const definition = graph([node('start', 'start'), node('batch', 'aggregate', { key: 'all', minutes: 1 }), node('delay', 'delay', { anchor: 'published', minutes: 60 }), node('join', 'merge', { mode: 'any' }), node('send', 'send')], [['start', 'batch'], ['batch', 'join'], ['batch', 'delay'], ['delay', 'join'], ['join', 'send']]);
    await fixture(definition, async f => {
        await f.add({ title: 'missing published' });
        await f.add({ title: 'healthy', publishedAtMs: time });
        await f.drain(time); await f.drain(time + 60000);
        let sends = await f.sends();
        assert.equal(sends.length, 1);
        assert.deepEqual(sends[0].unit.members.map(member => member.event.title), ['missing published']);
        await f.store().revokeRun(sends[0].unit.members[0].runId, 'MONITOR_CHANGED', time + 60001);
        const waits = await f.query("SELECT continuation_unit_id FROM automation_flow_steps WHERE node_id='delay'");
        assert.equal((await f.store().readUnit(waits[0].continuation_unit_id)).members[0].event.title, 'healthy');
        await f.drain(time + 3600000);
        sends = await f.sends(); assert.equal(sends.length, 2);
        assert.deepEqual(sends.flatMap(row => row.unit.members.map(member => member.event.title)).sort(), ['healthy']);
        assert.equal((await f.query("SELECT state FROM automation_flow_merge_decisions WHERE state='ready'"))[0], undefined, 'a revoked peer cannot leave a ready merge anchor behind');
    });
});
