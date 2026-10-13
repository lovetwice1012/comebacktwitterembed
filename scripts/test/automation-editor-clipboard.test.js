'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { newWorkflow, NODE_TYPES, LIMITS, validateWorkflow } = require('../../src/automation/schema');
const { connect } = require('../../src/automation/editor-model');
const { copySelection, cutSelection, pasteSelection, validateSelection } = require('../../src/automation/editor-clipboard');

const ids = {
    first: '00000000-0000-0000-0000-000000000001', second: '00000000-0000-0000-0000-000000000002',
    third: '00000000-0000-0000-0000-000000000003', fourth: '00000000-0000-0000-0000-000000000004',
};
const node = (id, type, position, config = structuredClone(NODE_TYPES[type].defaults)) => ({ id, type, config, ...(position ? { position } : {}) });
const payload = (nodes, edges = []) => ({ schemaVersion: 1, kind: 'automation-selection', nodes, edges });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; };

function detailedRule() {
    const rule = newWorkflow('細かい分岐');
    const blocks = [
        node('choice_88', 'condition', { x: -60, y: 120 }, { predicate: { op: 'all', conditions: [
            { op: 'any', conditions: [{ field: 'title', op: 'contains', value: '限定', ignoreCase: true }, { field: 'discountPercent', op: 'gte', value: 30 }] },
            { op: 'not', conditions: [{ field: 'sensitive', op: 'eq', value: true }] },
        ] } }),
        node('later_19', 'delay', { x: 220, y: 240 }),
        node('join_09', 'merge', { x: 500, y: 120 }, { mode: 'all', displayConflict: 'reset' }),
        node('count_03', 'limit', { x: 720, y: 120 }),
        node('collect_42', 'aggregate', { x: 940, y: 120 }),
    ];
    rule.nodes = [rule.nodes[0], ...blocks, rule.nodes[1]];
    rule.edges = [
        { id: 'enter_8', source: 'start', target: 'choice_88', port: 'out' },
        { id: 'yes_91', source: 'choice_88', target: 'later_19', port: 'yes' },
        { id: 'no_03', source: 'choice_88', target: 'join_09', port: 'no' },
        { id: 'delayed_8', source: 'later_19', target: 'join_09', port: 'out' },
        { id: 'limited_6', source: 'join_09', target: 'count_03', port: 'out' },
        { id: 'batched_2', source: 'count_03', target: 'collect_42', port: 'out' },
        { id: 'outside_9', source: 'collect_42', target: 'send', port: 'out' },
    ];
    rule.layout = { groups: [{ id: 'chosen_7', label: '分岐からまとめまで', collapsed: true }, { id: 'untouched_2', label: '通知', collapsed: false }], viewport: { x: 70, y: 90, zoom: 0.8 } };
    for (const block of blocks) block.group = 'chosen_7';
    rule.nodes.at(-1).group = 'untouched_2';
    return rule;
}

test('copy and paste preserve nested predicates, branch ports, ordered stages and relative positions with fresh IDs', () => {
    const original = freeze(detailedRule()), before = JSON.stringify(original);
    const selection = copySelection(original, ['start', 'choice_88', 'later_19', 'join_09', 'count_03', 'collect_42']);
    assert.equal(selection.nodes.length, 5); assert.equal(selection.edges.length, 5);
    assert(selection.nodes.every(block => block.type !== 'start'));
    assert(selection.edges.every(edge => edge.source !== 'start' && edge.target !== 'send'));
    const { rule, nodeIds, edgeIds } = pasteSelection(original, selection, { x: 1400, y: 560 });
    const pasted = rule.nodes.filter(block => nodeIds.includes(block.id)), mapping = new Map(selection.nodes.map((block, index) => [block.id, pasted[index].id]));
    assert.deepEqual(pasted.map(block => block.type), ['condition', 'delay', 'merge', 'limit', 'aggregate']);
    assert.deepEqual(pasted.map(block => block.config), selection.nodes.map(block => block.config));
    for (let index = 0; index < pasted.length; index++) {
        assert.equal(pasted[index].position.x, selection.nodes[index].position.x + 1460);
        assert.equal(pasted[index].position.y, selection.nodes[index].position.y + 440);
    }
    for (const edge of selection.edges) assert(rule.edges.some(candidate => edgeIds.includes(candidate.id) && candidate.source === mapping.get(edge.source) && candidate.target === mapping.get(edge.target) && candidate.port === edge.port));
    const allIds = [...rule.nodes.map(block => block.id), ...rule.edges.map(edge => edge.id), ...rule.layout.groups.map(group => group.id)];
    assert.equal(new Set(allIds).size, allIds.length);
    assert.deepEqual(rule.layout.viewport, original.layout.viewport);
    assert.deepEqual(rule.nodes.slice(0, original.nodes.length), original.nodes);
    assert.deepEqual(rule.edges.slice(0, original.edges.length), original.edges);
    assert.equal(JSON.stringify(original), before);
    assert.equal(validateWorkflow(rule).valid, false, 'paste stays detached until the user connects its input');
    const linked = connect(connect(rule, 'start', pasted[0].id, 'out'), pasted.at(-1).id, 'send', 'out');
    assert.equal(validateWorkflow(linked).valid, true);
});

test('partial and disconnected selections keep only internal edges and retain the chosen group metadata', () => {
    const original = detailedRule();
    const selection = copySelection(original, ['later_19', 'collect_42', 'send']);
    assert.deepEqual(selection.nodes.map(block => block.id), ['later_19', 'collect_42', 'send']);
    assert.deepEqual(selection.edges, [{ id: 'outside_9', source: 'collect_42', target: 'send', port: 'out' }]);
    assert.deepEqual(selection.groups, original.layout.groups);
    const pasted = pasteSelection(original, selection);
    const addedGroups = pasted.rule.layout.groups.slice(2);
    assert.deepEqual(addedGroups.map(({ id: _id, ...rest }) => rest), selection.groups.map(({ id: _id, ...rest }) => rest));
    assert.equal(pasted.rule.nodes.at(-3).group, addedGroups[0].id);
    assert.equal(pasted.rule.nodes.at(-2).group, addedGroups[0].id);
    assert.equal(pasted.rule.nodes.at(-1).group, addedGroups[1].id);
    assert.notEqual(addedGroups[0].id, selection.groups[0].id);
});

test('single terminal blocks and incomplete output blocks can be copied, and start is protected from copy and cut', () => {
    const original = newWorkflow();
    assert.equal(copySelection(original, ['send']).nodes[0].type, 'send');
    assert.throws(() => copySelection(original, ['start']), /開始以外/);
    assert.throws(() => copySelection(original, []), /選んで/);
    assert.equal(cutSelection(original, ['start']), original);
    const cut = cutSelection(original, ['start', 'send']);
    assert.deepEqual(cut.nodes, [original.nodes[0]]); assert.deepEqual(cut.edges, []);
    const lone = payload([node('unfinished', 'condition')]);
    assert.deepEqual(validateSelection(lone), lone);
    assert.equal(pasteSelection(original, lone).rule.nodes.at(-1).type, 'condition');
    assert.throws(() => pasteSelection(original, payload([node('duplicate_start', 'start')])), /開始/);
});

test('cut removes selected nodes and incident edges, drops emptied groups and preserves untouched content for undo', () => {
    const original = freeze(detailedRule()), saved = JSON.stringify(original);
    const cut = cutSelection(original, ['start', 'choice_88', 'later_19', 'join_09', 'count_03', 'collect_42']);
    assert.deepEqual(cut.nodes.map(block => block.id), ['start', 'send']);
    assert.deepEqual(cut.edges, []);
    assert.deepEqual(cut.layout.groups, [original.layout.groups[1]]);
    assert.deepEqual(cut.layout.viewport, original.layout.viewport);
    const partial = cutSelection(original, ['later_19']);
    assert.deepEqual(partial.layout.groups, original.layout.groups);
    assert(partial.edges.every(edge => edge.source !== 'later_19' && edge.target !== 'later_19'));
    assert.equal(JSON.stringify(original), saved, 'an undo snapshot remains untouched');
});

test('copy includes only referenced resource IDs and revisions, and collision remapping never changes existing bindings', () => {
    const original = newWorkflow();
    original.nodes.push(node('words_8', 'dictionary', { x: 500, y: 90 }, { dictionary: 'sale', fields: ['title', 'body'] }), node('send_9', 'send', { x: 780, y: 90 }, { destination: 'alerts' }));
    original.edges.push({ id: 'nested_9', source: 'words_8', target: 'send_9', port: 'yes' });
    const sourceBindings = freeze({ destinations: { alerts: ids.first, unused: ids.third }, dictionaries: { sale: { id: ids.second, revision: 2 }, unused: { id: ids.fourth, revision: 10 } } });
    const selection = copySelection(original, ['words_8', 'send_9'], sourceBindings);
    assert.deepEqual(selection.bindings, { destinations: { alerts: ids.first }, dictionaries: { sale: { id: ids.second, revision: 2 } } });
    const existing = freeze({ destinations: { alerts: ids.third, alerts_copy: ids.fourth }, dictionaries: { sale: { id: ids.second, revision: 1 } } }), before = JSON.stringify(existing);
    const once = pasteSelection(newWorkflow(), selection, undefined, existing);
    assert.equal(once.rule.nodes.at(-1).config.destination, 'alerts_copy2');
    assert.equal(once.rule.nodes.at(-2).config.dictionary, 'sale_copy');
    assert.equal(once.bindings.destinations.alerts, ids.third);
    assert.equal(once.bindings.destinations.alerts_copy2, ids.first);
    assert.deepEqual(once.bindings.dictionaries.sale_copy, { id: ids.second, revision: 2 });
    const twice = pasteSelection(once.rule, selection, undefined, once.bindings);
    assert.equal(twice.rule.nodes.at(-1).config.destination, 'alerts_copy2');
    assert.equal(twice.rule.nodes.at(-2).config.dictionary, 'sale_copy');
    assert.deepEqual(twice.bindings, once.bindings, 'repeated pastes reuse the same resource alias rather than proliferating bindings');
    assert.equal(JSON.stringify(existing), before);
    assert.deepEqual(sourceBindings.dictionaries.sale, { id: ids.second, revision: 2 });
});

test('same references compare by fields, missing assignments stay unassigned, default destination stays default and long aliases remain valid', () => {
    const long = 'a'.repeat(64), selection = payload([
        node('lookup', 'dictionary', undefined, { dictionary: 'sale', fields: ['body'] }),
        node('unassigned', 'send', undefined, { destination: 'pending' }),
        node('monitor_default', 'send'),
        node('long_alias', 'send', undefined, { destination: long }),
    ]);
    selection.bindings = { destinations: { [long]: ids.first }, dictionaries: { sale: { revision: 2, id: ids.second } } };
    const targetBindings = { destinations: { pending: ids.third, [long]: ids.fourth }, dictionaries: { sale: { id: ids.second, revision: 2 } } };
    const result = pasteSelection(newWorkflow(), selection, undefined, targetBindings), blocks = result.rule.nodes.slice(2);
    assert.equal(blocks[0].config.dictionary, 'sale');
    assert.equal(blocks[1].config.destination, 'pending_copy');
    assert.equal(Object.hasOwn(result.bindings.destinations, 'pending_copy'), false);
    assert.equal(blocks[2].config.destination, 'default');
    assert.equal(blocks[3].config.destination.length, 64);
    assert.equal(result.bindings.destinations[blocks[3].config.destination], ids.first);
    assert.equal(copySelection(newWorkflow(), ['send'], { destinations: { default: ids.first }, dictionaries: {} }).bindings.destinations.default, undefined);
});

test('binding import cannot assign previously unassigned target blocks, including aliases reserved only by nodes', () => {
    const original = newWorkflow();
    original.nodes.push(node('pending', 'send', undefined, { destination: 'alerts' }), node('also_pending', 'send', undefined, { destination: 'alerts_copy' }));
    const selection = payload([node('ready', 'send', undefined, { destination: 'alerts' })]);
    selection.bindings = { destinations: { alerts: ids.first }, dictionaries: {} };
    const result = pasteSelection(original, selection, undefined, { destinations: {}, dictionaries: {} });
    assert.equal(result.rule.nodes.at(-1).config.destination, 'alerts_copy2');
    assert.equal(Object.hasOwn(result.bindings.destinations, 'alerts'), false);
    assert.equal(Object.hasOwn(result.bindings.destinations, 'alerts_copy'), false);
    assert.equal(result.bindings.destinations.alerts_copy2, ids.first);
    const conflict = pasteSelection(original, selection, undefined, { destinations: { alerts: ids.second }, dictionaries: {} });
    assert.equal(conflict.rule.nodes.at(-1).config.destination, 'alerts_copy2');
    assert.equal(conflict.bindings.destinations.alerts, ids.second);
    assert.equal(Object.hasOwn(conflict.bindings.destinations, 'alerts_copy'), false);
});

test('repeated paste gives distinct node, edge and group IDs and preserves input payload', () => {
    const selection = freeze(copySelection(detailedRule(), ['choice_88', 'later_19'])), before = JSON.stringify(selection);
    const once = pasteSelection(newWorkflow(), selection), twice = pasteSelection(once.rule, selection);
    assert(twice.nodeIds.every(id => !once.nodeIds.includes(id)));
    assert(twice.edgeIds.every(id => !once.edgeIds.includes(id)));
    assert.notEqual(twice.rule.layout.groups[0].id, twice.rule.layout.groups[1].id);
    assert.equal(twice.rule.nodes.at(-2).position.x, once.rule.nodes.at(-2).position.x);
    assert.equal(JSON.stringify(selection), before);
});

test('malformed, unsafe and cyclic fragments are rejected before changing the destination', () => {
    const original = freeze(newWorkflow()), before = JSON.stringify(original), valid = payload([node('one', 'delay'), node('two', 'delay')], [{ id: 'link', source: 'one', target: 'two', port: 'out' }]);
    const malformed = [
        { ...valid, unexpected: 'field' }, { ...valid, schemaVersion: 2 }, { ...valid, kind: 'workflow' },
        { ...valid, nodes: [...valid.nodes, valid.nodes[0]] }, { ...valid, edges: [...valid.edges, valid.edges[0]] },
        payload([{ ...node('bad_id', 'stop'), id: true }]), { ...valid, edges: [{ ...valid.edges[0], id: true }] },
        payload([node('bad_alias', 'send', undefined, { destination: true })]),
        payload([node('bad_dictionary_alias', 'dictionary', undefined, { dictionary: true, fields: ['title'] })]),
        { ...valid, edges: [{ ...valid.edges[0], target: 'outside' }] }, { ...valid, edges: [{ ...valid.edges[0], port: 'yes' }] },
        { ...valid, edges: [...valid.edges, { id: 'back', source: 'two', target: 'one', port: 'out' }] },
        payload([node('unsupported', 'delay', undefined, { minutes: 1, anchor: 'observed', secret: 'hidden' })]),
        payload([node('terminal', 'send')], [{ id: 'out', source: 'terminal', target: 'terminal', port: 'out' }]),
        payload([{ ...node('placed', 'delay'), position: { x: 10, y: 10, token: 'secret' } }]),
        payload([{ ...node('foreign', 'delay'), group: 'missing' }]),
        { ...valid, groups: [{ id: 'empty', label: 'unused' }] },
        { ...valid, bindings: { destinations: { unrelated: ids.first }, dictionaries: {} } },
        { ...valid, bindings: { destinations: {}, dictionaries: {}, ownerId: 'someone' } },
        JSON.parse('{"schemaVersion":1,"kind":"automation-selection","nodes":[],"edges":[],"__proto__":{"polluted":true}}'),
    ];
    for (const invalid of malformed) assert.throws(() => pasteSelection(original, invalid));
    const cyclic = structuredClone(valid); cyclic.extra = cyclic;
    assert.throws(() => pasteSelection(original, cyclic));
    const withSecrets = payload([node('destination', 'send', undefined, { destination: 'alerts' })]);
    withSecrets.bindings = { destinations: { alerts: 'https://discord.com/api/webhooks/1/secret' }, dictionaries: {} };
    assert.throws(() => pasteSelection(original, withSecrets), /参照/);
    const dictionarySecrets = payload([node('lookup', 'dictionary')]);
    dictionarySecrets.bindings = { destinations: {}, dictionaries: { words: { id: ids.first, revision: 1, entries: ['private words'] } } };
    assert.throws(() => pasteSelection(original, dictionarySecrets));
    assert.equal(JSON.stringify(original), before);
    assert.equal({}.polluted, undefined);
});

test('selection validation handles the actual schema capacity and rejects every exceeded budget and invalid anchor', () => {
    const maximum = payload(Array.from({ length: LIMITS.nodes - 1 }, (_, index) => node(`terminal${index}`, 'stop')));
    assert.equal(validateSelection(maximum).nodes.length, 127, 'there is no old 100-node fragment limit');
    const tinyTarget = { ...newWorkflow(), nodes: [newWorkflow().nodes[0]], edges: [] };
    assert.equal(pasteSelection(tinyTarget, maximum).rule.nodes.length, LIMITS.nodes);
    assert.throws(() => pasteSelection(newWorkflow(), maximum), /上限/);
    assert.throws(() => validateSelection(payload([...maximum.nodes, node('overflow', 'stop')])));
    const edges = Array.from({ length: LIMITS.edges + 1 }, (_, index) => ({ id: `edge${index}`, source: 'delay', target: 'end', port: 'out' }));
    assert.throws(() => validateSelection(payload([node('delay', 'delay'), node('end', 'stop')], edges)));
    const groups = Array.from({ length: 33 }, (_, index) => ({ id: `group${index}`, label: `${index}` }));
    assert.throws(() => validateSelection({ ...payload(groups.map(group => ({ ...node(`n${group.id}`, 'stop'), group: group.id }))), groups }), /32/);
    const grouped = copySelection(detailedRule(), ['later_19']), fullGroups = { ...newWorkflow(), layout: { groups: groups.slice(0, 32), viewport: { x: 2, y: 3, zoom: 1 } } };
    assert.throws(() => pasteSelection(fullGroups, grouped), /上限/);
    for (const position of [{ x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0 }, { x: 1000001, y: 0 }, { x: 1, y: 0, extra: true }]) assert.throws(() => pasteSelection(newWorkflow(), payload([node('end', 'stop')]), position));
    const overlarge = payload([node('end', 'stop', undefined, { reason: 'あ'.repeat(LIMITS.bytes) })]);
    assert.throws(() => validateSelection(overlarge), /大きすぎ/);
    const largeCondition = node('long_choice', 'condition', undefined, { predicate: { field: 'title', op: 'in', value: ['あ'.repeat(180000)] } });
    const largeTarget = { ...newWorkflow(), nodes: [...newWorkflow().nodes, largeCondition] };
    assert.equal(validateSelection(payload([largeCondition])).nodes.length, 1);
    assert.throws(() => pasteSelection(largeTarget, payload([largeCondition])), /サイズ上限/);
});
