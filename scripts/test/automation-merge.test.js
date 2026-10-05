'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { parseWorkflow, stringifyDraft } = require('../../src/automation/format');
function fixture() {
    const rule = newWorkflow('合流');
    rule.nodes.push({ id: 'left', type: 'condition', config: { predicate: { field: 'title', op: 'contains', value: 'sale' } } },
        { id: 'right', type: 'delay', config: { minutes: 30, anchor: 'observed' } },
        { id: 'long', type: 'limit', config: { ...NODE_TYPES.limit.defaults } },
        { id: 'join', type: 'merge', config: { ...NODE_TYPES.merge.defaults } });
    rule.edges = [['a', 'start', 'left', 'out'], ['b', 'start', 'right', 'out'], ['c', 'right', 'long', 'out'], ['d', 'left', 'join', 'yes'], ['e', 'long', 'join', 'out'], ['f', 'join', 'send', 'out']].map(([id, source, target, port]) => ({ id, source, target, port }));
    return rule;
}
test('explicit merge produces one output at unequal path depths and preserves all restrictions', () => {
    const rule = fixture();
    const result = evaluateWorkflow(rule, { title: 'sale', observedAtMs: 1000 }, { now: 1000 });
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].dueAtMs, 1801000);
    assert.equal(result.outputs[0].limits.length, 1);
    assert(result.trace.some(t => t.outcome === 'merged' && t.arrivals === 2));
    for (const format of ['json', 'yaml']) assert.deepEqual(evaluateWorkflow(parseWorkflow(stringifyDraft(rule, format), format), { title: 'sale', observedAtMs: 1000 }, { now: 1000 }), result);
});
test('all merge excludes missing paths; any merge accepts remaining paths without weakening their delay', () => {
    const rule = fixture(), merge = rule.nodes.find(n => n.id === 'join');
    merge.config.mode = 'all';
    assert.equal(evaluateWorkflow(rule, { title: 'normal' }, { now: 1000 }).outputs.length, 0);
    merge.config.mode = 'any';
    const result = evaluateWorkflow(rule, { title: 'normal' }, { now: 1000 });
    assert.equal(result.outputs.length, 1); assert.equal(result.outputs[0].dueAtMs, 1801000);
});
test('display conflicts stop unless the rule explicitly resets them; legacy parallel edges keep their meaning', () => {
    const rule = fixture();
    rule.nodes.find(n => n.id === 'right').type = 'transform';
    rule.nodes.find(n => n.id === 'right').config = { ...NODE_TYPES.transform.defaults, format: 'text', template: 'different' };
    assert.equal(evaluateWorkflow(rule, { title: 'sale' }, { now: 1000 }).outputs.length, 0);
    rule.nodes.find(n => n.id === 'join').config.displayConflict = 'reset';
    assert.equal(evaluateWorkflow(rule, { title: 'sale' }, { now: 1000 }).outputs.length, 1);
    rule.nodes = rule.nodes.filter(n => n.id !== 'join'); rule.edges = rule.edges.filter(e => e.source !== 'join').map(e => e.target === 'join' ? { ...e, target: 'send' } : e);
    assert.equal(evaluateWorkflow(rule, { title: 'sale' }, { now: 1000 }).outputs.length, 2);
});
