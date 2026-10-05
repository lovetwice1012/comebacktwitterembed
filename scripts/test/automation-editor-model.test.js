'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { newWorkflow, assertWorkflow, validateWorkflow } = require('../../src/automation/schema');
const { parseWorkflow, stringifyWorkflow, semanticWorkflow, stringifyDraft } = require('../../src/automation/format');
const { evaluateWorkflow, evaluatePredicate } = require('../../src/automation/engine');
const model = require('../../src/automation/editor-model');

function rule() {
    const data = newWorkflow();
    data.nodes.splice(1, 0, { id: 'filter', type: 'condition', config: { predicate: { field: 'title', op: 'in', value: ['sale', 'new'] } }, position: { x: 200, y: 80 } });
    data.edges = [{ id: 'a', source: 'start', target: 'filter', port: 'out' }, { id: 'b', source: 'filter', target: 'send', port: 'yes' }];
    return data;
}
test('GUI connection rejects invalid ports, start destinations, duplicates and cycles before changing the graph', () => {
    const data = rule();
    assert.equal(model.connect(data, 'filter', 'send', 'yes'), data);
    for (const [from, to, port] of [['filter', 'start', 'yes'], ['send', 'filter', 'out'], ['filter', 'filter', 'no'], ['start', 'send', 'no']]) assert.throws(() => model.connect(data, from, to, port));
    const extra = { ...data, nodes: [...data.nodes, { id: 'filter2', type: 'condition', config: { predicate: { field: 'title', op: 'exists' } } }], edges: [...data.edges, { id: 'c', source: 'filter', target: 'filter2', port: 'no' }] };
    assert.throws(() => model.connect(extra, 'filter2', 'filter', 'yes'), /循環/);
    assert.equal(model.removeNodes(data, ['start', 'filter']).nodes.some(n => n.type === 'start'), true);
    assert.deepEqual(model.removeNodes(data, ['filter']).edges, []);
});
test('grouping, collapse, viewport and auto-layout preserve JSON/YAML semantic execution', () => {
    const original = rule();
    const grouped = model.addGroup(original, '選別して通知', ['filter', 'send'], 'selection');
    grouped.layout.groups[0].collapsed = true;
    grouped.layout.viewport = { x: 12, y: 30, zoom: 0.8 };
    const arranged = model.autoLayout(grouped);
    assert.deepEqual(semanticWorkflow(original), semanticWorkflow(arranged));
    for (const format of ['json', 'yaml']) {
        const roundtrip = parseWorkflow(stringifyWorkflow(arranged, format), format);
        assert.deepEqual(roundtrip, arranged);
        assert.deepEqual(evaluateWorkflow(roundtrip, { title: 'sale' }, { now: 1 }).outputs, evaluateWorkflow(original, { title: 'sale' }, { now: 1 }).outputs);
    }
    const removed = model.removeGroup(grouped, 'selection');
    assert.equal(removed.nodes.some(n => n.group), false); assertWorkflow(removed);
    assert.equal(validateWorkflow({ ...grouped, layout: { groups: [grouped.layout.groups[0], grouped.layout.groups[0]] } }).valid, false);
    assert.equal(validateWorkflow({ ...grouped, layout: { groups: [] } }).valid, false);
});
test('reusable groups remap IDs and internal connections, preserve content and require an explicit outside connection', () => {
    const original = model.addGroup(rule(), '部品', ['filter', 'send'], 'g');
    const part = model.exportGroup(original, 'g');
    assert.deepEqual(model.validateFragment(JSON.parse(JSON.stringify(part))), part);
    let sequence = 0;
    const imported = model.importGroup(newWorkflow(), part, prefix => `${prefix}copy${sequence++}`);
    assert.equal(imported.nodes.length, 4);
    assert.equal(new Set(imported.nodes.map(n => n.id)).size, 4);
    assert.equal(imported.edges.length, 2);
    assert.equal(validateWorkflow(imported).valid, false, 'detached fragment must not silently become executable');
    const newFilter = imported.nodes.find(n => n.type === 'condition');
    const connected = model.connect(imported, 'start', newFilter.id, 'out', 'linked');
    assertWorkflow(connected);
    assert.equal(evaluateWorkflow(connected, { title: 'sale' }, { now: 1 }).outputs.length, 2);
    assert.throws(() => model.validateFragment({ ...part, edges: [{ id: 'outside', source: 'filter', target: 'outside', port: 'yes' }] }));
    assert.throws(() => model.exportGroup(model.addGroup(newWorkflow(), '開始', ['start'], 'g'), 'g'), /開始/);
});
test('an incomplete graphical draft can be exported without claiming it is executable', () => {
    const invalid = rule(); invalid.edges = [];
    assert.equal(validateWorkflow(invalid).valid, false);
    assert(JSON.parse(stringifyDraft(invalid, 'json')).nodes.length > 0);
    assert.throws(() => parseWorkflow(stringifyDraft(invalid, 'yaml'), 'yaml'));
});

test('one-click insertion keeps existing connections and free placement never silently rewires them', () => {
    const { insertNode } = require('../../src/automation/editor-model');
    const { newWorkflow, validateWorkflow } = require('../../src/automation/schema');
    let sequence = 0; const ids = prefix => `${prefix}${++sequence}`;
    const original = newWorkflow('挿入');
    const inserted = insertNode(original, 'condition', 'start', 'out', false, ids);
    assert.equal(validateWorkflow(inserted).valid, true);
    assert.equal(inserted.nodes.length, 3);
    const condition = inserted.nodes.at(-1);
    assert(inserted.edges.some(e => e.source === condition.id && e.port === 'yes' && e.target === 'send'));
    const unknown = insertNode(inserted, 'stop', condition.id, 'unknown', false, ids);
    assert.equal(validateWorkflow(unknown).valid, true);
    assert.throws(() => insertNode(inserted, 'send', 'start', 'out', false, ids), /接続済み/);
    const beforeSend = insertNode(inserted, 'delay', 'send', 'out', false, ids);
    assert.equal(validateWorkflow(beforeSend).valid, true);
    const free = insertNode(original, 'merge', 'start', 'out', true, ids);
    assert.deepEqual(free.edges, original.edges);
    assert.equal(validateWorkflow(free).valid, false, 'free placement remains an explicit incomplete draft');
    assert.equal(original.nodes.length, 2);
});

test('predicate edits retain operands through AND, OR, NOT and compatible comparison operators', () => {
    const leaf = { field: 'title', op: 'contains', value: 'sale', ignoreCase: true };
    const all = model.predicateMode(leaf, 'all');
    all.conditions.push({ field: 'discountPercent', op: 'gte', value: 30 });
    const any = model.predicateMode(all, 'any');
    assert.deepEqual(any.conditions, all.conditions);
    const not = model.predicateMode(any, 'not');
    assert.deepEqual(not.conditions, [any]);
    assert.throws(() => model.predicateMode(not, 'compare'), /複数/);
    assert.deepEqual(model.predicateMode(model.predicateMode(leaf, 'not'), 'compare'), leaf);
    assert.deepEqual(model.comparisonMode(leaf, 'in', 'string').value, ['sale']);
    assert.equal(model.comparisonMode(leaf, 'eq', 'string').value, 'sale');
    assert.equal(model.comparisonMode({ field: 'priceAmount', op: 'lte', value: 980 }, 'eq', 'number').value, 980);
    assert.equal(evaluatePredicate(not, { title: 'SALE', discountPercent: 0 }), false);
    assert.equal(evaluatePredicate(not, { title: 'news' }), 'unknown');
    assert.deepEqual(leaf, { field: 'title', op: 'contains', value: 'sale', ignoreCase: true });
});

test('three-valued nested predicates survive text roundtrips without treating unknown as false', () => {
    const predicate = { op: 'all', conditions: [
        { op: 'any', conditions: [{ field: 'title', op: 'contains', value: 'sale' }, { field: 'discountPercent', op: 'gte', value: 30 }] },
        { op: 'not', conditions: [{ field: 'sensitive', op: 'eq', value: true }] },
    ] };
    const data = rule(); data.nodes.find(n => n.id === 'filter').config.predicate = predicate;
    data.nodes.push({ id: 'no', type: 'stop', config: { reason: '不一致' } }, { id: 'unknown', type: 'stop', config: { reason: '情報不足' } });
    data.edges.push({ id: 'n', source: 'filter', target: 'no', port: 'no' }, { id: 'u', source: 'filter', target: 'unknown', port: 'unknown' });
    const samples = [
        [{ title: 'sale', sensitive: false }, 'yes'],
        [{ title: 'news', discountPercent: 50, sensitive: false }, 'yes'],
        [{ title: 'news', discountPercent: 0, sensitive: false }, 'no'],
        [{ title: 'sale', sensitive: true }, 'no'],
        [{ title: 'news', sensitive: false }, 'unknown'],
        [{ title: 'sale' }, 'unknown'],
    ];
    for (const format of ['yaml', 'json']) for (const [event, expected] of samples) {
        const evaluated = evaluateWorkflow(parseWorkflow(stringifyWorkflow(data, format), format), event, { now: 1 });
        assert.equal(evaluated.trace.find(row => row.nodeId === 'filter').outcome, expected);
        assert.equal(evaluated.outputs.length, expected === 'yes' ? 1 : 0);
    }
});

test('repeated fragment imports keep distinct positions, IDs and internal topology', () => {
    const fragment = model.exportGroup(model.addGroup(rule(), '再利用', ['filter', 'send'], 'g'), 'g');
    const once = model.importGroup(rule(), fragment), twice = model.importGroup(once, fragment);
    assert.equal(new Set(twice.nodes.map(n => n.id)).size, twice.nodes.length);
    assert.equal(new Set(twice.edges.map(e => e.id)).size, twice.edges.length);
    const groups = twice.layout.groups.map(g => twice.nodes.filter(n => n.group === g.id));
    assert(Math.min(...groups[1].map(n => n.position.x)) > Math.max(...groups[0].map(n => n.position.x)));
    for (const members of groups) {
        const edge = twice.edges.find(e => e.source === members.find(n => n.type === 'condition').id);
        assert.equal(edge.target, members.find(n => n.type === 'send').id);
        assert.equal(edge.port, 'yes');
    }
});

test('multiple aggregate and limit stages retain their exact GUI order through group, fragment and text operations', () => {
    let data = newWorkflow(), selected = 'start', sequence = 0;
    const order = [];
    for (const type of ['limit', 'aggregate', 'limit', 'aggregate', 'limit']) {
        data = model.insertNode(data, type, selected, 'out', false, prefix => `${prefix}${++sequence}`);
        selected = data.nodes.at(-1).id; order.push(selected);
    }
    data = model.addGroup(data, '順序を保持する部品', order, 'stages');
    data.layout.groups[0].collapsed = true;
    assertWorkflow(data);
    for (const format of ['json', 'yaml']) assert.deepEqual(parseWorkflow(stringifyWorkflow(data, format), format), data);
    const part = model.exportGroup(data, 'stages');
    assert.equal(part.nodes.length, 5); assert.equal(part.edges.length, 4);
    for (let i = 1; i < order.length; i++) assert(part.edges.some(e => e.source === order[i - 1] && e.target === order[i]));
    const imported = model.importGroup(data, part);
    assert.equal(imported.nodes.filter(n => n.type === 'aggregate').length, 4);
    assert.equal(imported.nodes.filter(n => n.type === 'limit').length, 6);
    // Queue execution/order semantics are intentionally not asserted here.
});
