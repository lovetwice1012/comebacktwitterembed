'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NODE_TYPES, LIMITS, newWorkflow, validateWorkflow, assertWorkflow } = require('../../src/automation/schema');
const { analyzeFanout } = require('../../src/automation/fanout');
const { parseWorkflow, stringifyDraft } = require('../../src/automation/format');
const { compileWorkflow } = require('../../src/automation/graph-plan');
const { evaluateWorkflow } = require('../../src/automation/engine');

function node(type, id, config = {}) { return { id, type, config: { ...structuredClone(NODE_TYPES[type].defaults), ...config } }; }
function connect(rule, source, target, port = 'out') { rule.edges.push({ id: `e${rule.edges.length}`, source, target, port }); }
function diamonds(stages, terminal = 'send') {
    const rule = newWorkflow('並列通知'); rule.edges = []; let previous = 'start';
    if (terminal === 'stop') rule.nodes[1] = node('stop', 'send');
    for (let i = 0; i < stages; i++) {
        for (const suffix of ['left', 'right', 'join']) rule.nodes.push(node('transform', `${suffix}${i}`));
        connect(rule, previous, `left${i}`); connect(rule, previous, `right${i}`);
        connect(rule, `left${i}`, `join${i}`); connect(rule, `right${i}`, `join${i}`);
        previous = `join${i}`;
    }
    connect(rule, previous, 'send'); return rule;
}
function fanoutIssue(rule) { return validateWorkflow(rule).issues.find(issue => issue.code === 'AUTOMATION_FANOUT_LIMIT'); }
function rejectsWithFeedback(action) {
    assert.throws(action, error => error.code === 'AUTOMATION_RULE_INVALID'
        && error.issues.some(issue => issue.code === 'AUTOMATION_FANOUT_LIMIT' && issue.nodeId && issue.path.startsWith('$.nodes[') && /32/.test(issue.message)));
}

test('a single send behind six reconverging diamonds rejects its 64 event copies with node feedback', () => {
    const rule = diamonds(6), before = structuredClone(rule);
    assert.equal(rule.nodes.length, 20); assert.equal(rule.edges.length, 25);
    assert.equal(rule.nodes.filter(item => item.type === 'send').length, 1);
    const issue = fanoutIssue(rule);
    assert.equal(validateWorkflow(rule).valid, false); assert.equal(issue.nodeId, 'send'); assert.equal(issue.path, '$.nodes[1]');
    assert.match(issue.message, /経路を合流/); assert.deepEqual(rule, before);
});

test('the 32-output boundary accepts five diamonds, but rejects total outputs across different sends', () => {
    const rule = diamonds(5);
    assert.equal(validateWorkflow(rule).valid, true); assert.equal(analyzeFanout(rule, LIMITS.outputs).maximumOutputs, 32);
    assert.equal(evaluateWorkflow(rule, { title: 'sale' }, { now: 0 }).outputs.length, 32);
    rule.nodes.push(node('send', 'extra')); connect(rule, 'start', 'extra');
    assert.equal(fanoutIssue(rule).code, 'AUTOMATION_FANOUT_LIMIT');
    const parallel = newWorkflow('通知先ごと'); parallel.nodes = [parallel.nodes[0]]; parallel.edges = [];
    for (let i = 0; i < 32; i++) { parallel.nodes.push(node('send', `send${i}`)); connect(parallel, 'start', `send${i}`); }
    assert.equal(validateWorkflow(parallel).valid, true);
    parallel.nodes.push(node('send', 'send32')); connect(parallel, 'start', 'send32');
    assert.equal(validateWorkflow(parallel).valid, false);
});

test('exactly 32 notifications may finish processing a later excluded branch without an evaluation error', () => {
    const rule = newWorkflow('32件と対象外'); rule.nodes = [rule.nodes[0]]; rule.edges = [];
    for (let i = 0; i < 32; i++) { const id = `send${i}`; rule.nodes.push(node('send', id)); connect(rule, 'start', id); }
    rule.nodes.push(node('stop', 'excluded')); connect(rule, 'start', 'excluded');
    const result = evaluateWorkflow(rule, { title: 'sale' }, { now: 0 });
    assert.equal(result.outputs.length, 32); assert.ok(result.trace.some(item => item.nodeId === 'excluded' && item.outcome === 'excluded'));
});

test('mutually exclusive yes/no/unknown outcomes are not counted as parallel copies', () => {
    const rule = newWorkflow('三つの結果'); rule.edges = [];
    let previous = 'start';
    for (let i = 0; i < 35; i++) {
        rule.nodes.push(node(i % 2 ? 'dictionary' : 'condition', `branch${i}`), node('transform', `join${i}`));
        connect(rule, previous, `branch${i}`);
        for (const port of ['yes', 'no', 'unknown']) connect(rule, `branch${i}`, `join${i}`, port);
        previous = `join${i}`;
    }
    connect(rule, previous, 'send');
    const result = analyzeFanout(rule, LIMITS.outputs);
    assert.equal(result.maximumOutputs, 1); assert.equal(result.conservative, false); assert.equal(validateWorkflow(rule).valid, true);
});

test('96 send blocks can be valid when each exclusive outcome has only 32 notifications', () => {
    const rule = newWorkflow('結果別の通知先'); rule.nodes = [rule.nodes[0], node('condition', 'choice')]; rule.edges = [];
    connect(rule, 'start', 'choice');
    for (const port of ['yes', 'no', 'unknown']) for (let i = 0; i < 32; i++) {
        const id = `${port}${i}`; rule.nodes.push(node('send', id)); connect(rule, 'choice', id, port);
    }
    assert.equal(validateWorkflow(rule).valid, true); assert.equal(analyzeFanout(rule, LIMITS.outputs).maximumOutputs, 32);
    for (const event of [{ title: 'セール' }, { title: '通常' }, {}]) assert.equal(evaluateWorkflow(rule, event, { now: 0 }).outputs.length, 32);
});

test('same-port splits really multiply event copies and are not hidden by exclusive siblings', () => {
    const rule = diamonds(5);
    rule.nodes.push(node('condition', 'choice'), node('send', 'other'));
    rule.edges.find(edge => edge.source === 'start').source = 'choice';
    rule.edges.find(edge => edge.source === 'start').source = 'choice';
    for (const edge of rule.edges.filter(edge => edge.source === 'choice')) edge.port = 'yes';
    connect(rule, 'start', 'choice'); connect(rule, 'choice', 'other', 'yes');
    assert.equal(analyzeFanout(rule, LIMITS.outputs).maximumOutputs, 33); assert.ok(fanoutIssue(rule));
    rule.edges.find(edge => edge.target === 'other').port = 'no';
    assert.equal(analyzeFanout(rule, LIMITS.outputs).maximumOutputs, 32); assert.equal(validateWorkflow(rule).valid, true);
});

test('an explicit merge collapses multiplied arrivals once for the event for both merge modes', () => {
    for (const mode of ['any', 'all']) {
        const rule = diamonds(6); rule.nodes.push(node('merge', 'merge', { mode }));
        rule.edges.find(edge => edge.target === 'send').target = 'merge'; connect(rule, 'merge', 'send');
        assert.equal(validateWorkflow(rule).valid, true); assert.equal(analyzeFanout(rule, LIMITS.outputs).maximumOutputs, 1);
        assert.equal(evaluateWorkflow(rule, { title: 'sale' }, { now: 0 }).outputs.length, 1);
    }
});

test('merge all retains mutual exclusion: yes and no can never arrive for the same event', () => {
    const rule = diamonds(6); rule.nodes.push(node('condition', 'choice'), node('merge', 'merge', { mode: 'all' }));
    rule.edges.filter(edge => edge.source === 'start').forEach(edge => { edge.source = 'merge'; });
    connect(rule, 'start', 'choice'); connect(rule, 'choice', 'merge', 'yes'); connect(rule, 'choice', 'merge', 'no');
    assert.equal(analyzeFanout(rule, LIMITS.outputs).maximumOutputs, 0); assert.equal(validateWorkflow(rule).valid, true);
    assert.equal(evaluateWorkflow(rule, { title: 'セール' }, { now: 0 }).outputs.length, 0);
});

test('time-dependent conditions cannot hide different delayed arrivals behind exclusive outcome merges', () => {
    const rule = newWorkflow('遅延した条件'); rule.nodes = [rule.nodes[0], node('delay', 'early', { minutes: 1 }), node('delay', 'late', { minutes: 10 }),
        node('condition', 'age', { predicate: { op: 'all', conditions: [{ field: 'ageMinutes', op: 'gte', value: 5 }] } }),
        node('merge', 'young'), node('merge', 'old')]; rule.edges = [];
    connect(rule, 'start', 'early'); connect(rule, 'start', 'late'); connect(rule, 'early', 'age'); connect(rule, 'late', 'age');
    connect(rule, 'age', 'young', 'no'); connect(rule, 'age', 'old', 'yes');
    for (let i = 0; i < 32; i++) for (const source of ['young', 'old']) {
        const id = `${source}Send${i}`; rule.nodes.push(node('send', id)); connect(rule, source, id);
    }
    assert.equal(analyzeFanout(rule, LIMITS.outputs).conservative, false); assert.ok(fanoutIssue(rule));
    // One arrival still has exactly one result, even when its condition uses
    // age; removing the parallel input restores the 32-output allowance.
    rule.nodes = rule.nodes.filter(item => item.id !== 'late'); rule.edges = rule.edges.filter(edge => edge.source !== 'late' && edge.target !== 'late');
    assert.equal(validateWorkflow(rule).valid, true); assert.equal(analyzeFanout(rule, LIMITS.outputs).maximumOutputs, 32);
});

test('two delayed event copies still produce only 20 notifications when every age outcome has 10 sends', () => {
    const rule = newWorkflow('条件別の10通知'); rule.nodes = [rule.nodes[0], node('delay', 'early', { minutes: 0 }), node('delay', 'late', { minutes: 60 }),
        node('condition', 'age', { predicate: { field: 'ageMinutes', op: 'gte', value: 30 } })]; rule.edges = [];
    connect(rule, 'start', 'early'); connect(rule, 'start', 'late'); connect(rule, 'early', 'age'); connect(rule, 'late', 'age');
    for (const port of ['yes', 'no', 'unknown']) for (let i = 0; i < 10; i++) {
        const id = `${port}${i}`; rule.nodes.push(node('send', id)); connect(rule, 'age', id, port);
    }
    const fanout = analyzeFanout(rule, LIMITS.outputs);
    assert.equal(fanout.maximumOutputs, 20); assert.equal(fanout.conservative, false); assert.equal(validateWorkflow(rule).valid, true);
});

test('delays, per-rule limits and aggregate intents do not disable the service output budget', () => {
    for (const type of ['delay', 'limit', 'aggregate']) {
        const rule = diamonds(6); rule.nodes.push(node(type, 'gate'));
        rule.edges.find(edge => edge.target === 'send').target = 'gate'; connect(rule, 'gate', 'send');
        assert.ok(fanoutIssue(rule), type);
    }
    // Many non-delivering paths are not a spam output, and ordinary detailed
    // rules can still use the full 128-block structural allowance.
    assert.equal(validateWorkflow(diamonds(6, 'stop')).valid, true);
    const chain = newWorkflow('詳細なルール'); chain.edges = []; let previous = 'start';
    for (let i = 0; i < 126; i++) { const id = `step${i}`; chain.nodes.push(node('transform', id)); connect(chain, previous, id); previous = id; }
    connect(chain, previous, 'send'); assert.equal(chain.nodes.length, 128); assert.equal(validateWorkflow(chain).valid, true);
});

test('JSON, YAML, shared assertions, simulation and graph compilation reject the same amplifying rule', () => {
    const rule = diamonds(6);
    for (const format of ['json', 'yaml']) rejectsWithFeedback(() => parseWorkflow(stringifyDraft(rule, format), format));
    rejectsWithFeedback(() => assertWorkflow(rule)); rejectsWithFeedback(() => compileWorkflow(rule));
    rejectsWithFeedback(() => evaluateWorkflow(rule, { title: 'sale' }, { now: 0 }));
});

test('malformed and cyclic graph errors stay structural and skip amplification analysis', () => {
    for (const change of [rule => { rule.edges.push({ id: 'cycle', source: 'join5', target: 'left0', port: 'out' }); },
        rule => { rule.edges[0].target = 'absent'; }, rule => { rule.nodes[2].type = 'unsupported'; }]) {
        const rule = diamonds(6); change(rule); const result = validateWorkflow(rule);
        assert.equal(result.valid, false); assert.equal(result.issues.some(issue => issue.code === 'AUTOMATION_FANOUT_LIMIT'), false);
    }
});

test('symbolic bounds equal exhaustive outcomes on independently generated reconvergent DAGs', () => {
    let seed = 9371;
    const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
    for (let example = 0; example < 100; example++) {
        const rule = newWorkflow('経路計算'); rule.nodes = [rule.nodes[0]]; rule.edges = [];
        for (let i = 1; i < 10; i++) rule.nodes.push(node(i % 3 === 1 ? 'condition' : random(3) ? 'transform' : 'merge', `n${i}`));
        for (const item of rule.nodes.filter(item => item.type === 'merge')) item.config.mode = random(2) ? 'any' : 'all';
        const ports = ['yes', 'no', 'unknown'];
        for (let target = 1; target < rule.nodes.length; target++) {
            const predecessors = new Set([target - 1]);
            for (let extra = 0; extra < 3; extra++) predecessors.add(random(target));
            for (const source of predecessors) connect(rule, rule.nodes[source].id, rule.nodes[target].id,
                rule.nodes[source].type === 'condition' ? ports[random(3)] : 'out');
        }
        for (let i = 0; i < 3; i++) {
            const id = `send${i}`; rule.nodes.push(node('send', id));
            const sourceId = `n${1 + random(8)}`, source = rule.nodes.find(item => item.id === sourceId);
            connect(rule, 'n9', id); connect(rule, source.id, id, source.type === 'condition' ? ports[random(3)] : 'out');
        }
        const branches = rule.nodes.filter(item => item.type === 'condition'), choices = new Map();
        let maximum = 0;
        const outcome = index => {
            if (index < branches.length) {
                for (const port of ports) { choices.set(branches[index].id, port); outcome(index + 1); }
                return;
            }
            const arrivals = new Map(); let outputs = 0;
            for (const item of rule.nodes) {
                const incoming = rule.edges.filter(edge => edge.target === item.id).map(edge => choices.has(edge.source) && choices.get(edge.source) !== edge.port ? 0 : arrivals.get(edge.source));
                let count = item.type === 'start' ? 1 : incoming.reduce((sum, value) => sum + value, 0);
                if (item.type === 'merge') count = item.config.mode === 'all' ? Number(incoming.every(value => value > 0)) : Number(count > 0);
                arrivals.set(item.id, count); if (item.type === 'send') outputs += count;
            }
            maximum = Math.max(maximum, outputs);
        };
        outcome(0);
        const result = analyzeFanout(rule, LIMITS.outputs);
        assert.equal(result.conservative, false); assert.equal(result.maximumOutputs, Math.min(33, maximum), `graph ${example}`);
        assert.equal(validateWorkflow(rule).valid, maximum <= 32, `graph ${example}`);
    }
});
