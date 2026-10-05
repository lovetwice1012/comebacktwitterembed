'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileWorkflow } = require('../../src/automation/graph-plan');
const { mergeLineage, propagateClosures } = require('../../src/automation/graph-join');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const member = runId => ({ id: runId, runId, event: { title: runId }, display: { ...NODE_TYPES.transform.defaults }, schedules: [], dueAtMs: 1000, deadlineMs: null });
const unit = (id, runIds, batch = false) => ({ id, kind: batch ? 'batch' : 'event', members: runIds.map(member), ancestry: batch ? [{ batchId: id }] : [] });
const node = { id: 'join', type: 'merge', config: { mode: 'any', displayConflict: 'stop' } };
function merge(runId, arrivals, options = {}) { return mergeLineage({ node, runId, incomingEdgeIds: ['left', 'right'], closedEdgeIds: ['left', 'right'], arrivals, ...options }); }
test('join waits for completion even when both branches already produced data', () => {
    const arrivals = [{ edgeId: 'left', unit: unit('one', ['a']) }, { edgeId: 'right', unit: unit('two', ['a']) }];
    assert.equal(merge('a', arrivals, { closedEdgeIds: ['left'] }).state, 'waiting');
    assert.equal(merge('a', arrivals).state, 'accepted');
});
test('a closed-empty dropped path excludes all but permits any after closure', () => {
    const arrivals = [{ edgeId: 'left', unit: unit('one', ['a']) }];
    assert.equal(merge('a', arrivals).state, 'accepted');
    assert.equal(merge('a', arrivals, { node: { ...node, config: { ...node.config, mode: 'all' } } }).state, 'excluded');
});
test('overlapping batches merge by original event lineage, not batch identity or Cartesian product', () => {
    const arrivals = [{ edgeId: 'left', unit: unit('batch1', ['a', 'b'], true) }, { edgeId: 'right', unit: unit('batch2', ['b', 'c'], true) }];
    const all = ['a', 'b', 'c'].map(runId => merge(runId, arrivals, { node: { ...node, config: { ...node.config, mode: 'all' } } }));
    assert.deepEqual(all.map(result => result.state), ['excluded', 'accepted', 'excluded']);
    const any = ['a', 'b', 'c'].map(runId => merge(runId, arrivals));
    assert(any.every(result => result.state === 'accepted'));
    assert.deepEqual(any.map(result => JSON.parse(result.signature)), [['batch1'], ['batch1', 'batch2'], ['batch2']]);
    assert.deepEqual(any.map(result => result.anchorUnitId), ['batch1', 'batch1', 'batch2']);
});
test('batch and individual bypass inputs share a finite batch anchor and retain the slower restrictions', () => {
    const batch = unit('batch1', ['a', 'b'], true), bypass = unit('single', ['a']);
    bypass.members[0].dueAtMs = 9000; bypass.members[0].deadlineMs = 12000;
    bypass.members[0].schedules = [{ ...NODE_TYPES.schedule.defaults }];
    const result = merge('a', [{ edgeId: 'left', unit: batch }, { edgeId: 'right', unit: bypass }]);
    assert.equal(result.anchorUnitId, 'batch1'); assert.equal(result.member.dueAtMs, 9000);
    assert.equal(result.member.deadlineMs, 12000); assert.equal(result.member.schedules.length, 1);
    result.member.schedules[0].days.length = 0; assert.equal(bypass.members[0].schedules[0].days.length, 7);
});
test('per-event display conflicts stop or explicitly reset without losing time constraints', () => {
    const left = unit('one', ['a']), right = unit('two', ['a']);
    right.members[0].display.format = 'url'; right.members[0].dueAtMs = 8000;
    const arrivals = [{ edgeId: 'left', unit: left }, { edgeId: 'right', unit: right }];
    assert.equal(merge('a', arrivals).code, 'MERGE_DISPLAY_CONFLICT');
    const result = merge('a', arrivals, { node: { ...node, config: { mode: 'any', displayConflict: 'reset' } } });
    assert.equal(result.member.display.format, 'expanded'); assert.equal(result.member.dueAtMs, 8000);
});
test('contradictory immutable event data cannot silently select one arrival', () => {
    const left = unit('one', ['a']), right = unit('two', ['a']); right.members[0].event.title = 'contradiction';
    assert.throws(() => merge('a', [{ edgeId: 'left', unit: left }, { edgeId: 'right', unit: right }]), { code: 'GRAPH_LINEAGE_CONFLICT' });
});
test('display equality ignores JSON key order but distinguishes the frozen default price presentation', () => {
    const left = unit('one', ['a']), right = unit('two', ['a']);
    right.members[0].display = Object.fromEntries(Object.entries(right.members[0].display).reverse());
    const arrivals = [{ edgeId: 'left', unit: left }, { edgeId: 'right', unit: right }];
    assert.equal(merge('a', arrivals).state, 'accepted');
    right.members[0].defaultPriceText = 'observed price';
    assert.equal(merge('a', arrivals).code, 'MERGE_DISPLAY_CONFLICT');
});
function plan() {
    const workflow = newWorkflow();
    workflow.nodes.splice(1, 0, { id: 'gate', type: 'limit', config: NODE_TYPES.limit.defaults }, node);
    workflow.edges = [
        { id: 'start_gate', source: 'start', target: 'gate', port: 'out' },
        { id: 'left', source: 'start', target: 'join', port: 'out' },
        { id: 'right', source: 'gate', target: 'join', port: 'out' },
        { id: 'joined', source: 'join', target: 'send', port: 'out' },
    ];
    return compileWorkflow(workflow);
}
test('closure propagation never treats a deferred gate as an absent path or a received merge as settled', () => {
    const state = { runId: 'a', receipts: [{ runId: 'a', kind: 'data', edgeId: 'start_gate' }, { runId: 'a', kind: 'data', edgeId: 'left' }], activations: [
        { nodeId: 'start', runIds: ['a'], state: 'complete' }, { nodeId: 'gate', runIds: ['a'], state: 'pending' },
    ] };
    assert.deepEqual(propagateClosures(plan(), state).map(edge => edge.edgeId), ['start_gate', 'left']);
    state.activations[1].state = 'excluded';
    assert.deepEqual(propagateClosures(plan(), state).map(edge => edge.edgeId), ['start_gate', 'left', 'right']);
    assert.deepEqual(propagateClosures(plan(), { ...state, settledMerges: ['join'] }).map(edge => edge.edgeId), ['start_gate', 'left', 'right', 'joined']);
});
test('all activations for an ordinary node must settle; missing source state cannot close a run', () => {
    assert.deepEqual(propagateClosures(plan(), { runId: 'a', receipts: [], activations: [] }), []);
    const state = { runId: 'a', receipts: [{ runId: 'a', kind: 'closed', edgeId: 'start_gate' }, { runId: 'a', kind: 'data', edgeId: 'start_gate' }], activations: [
        { nodeId: 'start', runIds: ['a'], state: 'complete' }, { nodeId: 'gate', runIds: ['a'], state: 'complete' }, { nodeId: 'gate', runIds: ['a'], state: 'aggregating' },
    ] };
    assert(!propagateClosures(plan(), state).some(edge => edge.edgeId === 'right'));
});
