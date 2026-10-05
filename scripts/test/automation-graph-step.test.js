'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileWorkflow, KERNEL_LIMITS } = require('../../src/automation/graph-plan');
const { stepNode } = require('../../src/automation/graph-step');
const { NODE_TYPES, newWorkflow } = require('../../src/automation/schema');
const { DictionaryMatcher } = require('../../src/automation/dictionary');
const { MINUTE, DAY } = require('../../src/automation/schedule');

function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
function node(type, config = {}, id = type) { return { id, type, config: { ...structuredClone(NODE_TYPES[type].defaults), ...config } }; }
function member(id, event = {}, changes = {}) {
    return { id, runId: `run-${id}`, event, display: structuredClone(NODE_TYPES.transform.defaults), schedules: [],
        dueAtMs: 0, deadlineMs: null, defaultPriceText: null, ...changes };
}
function unit(members, changes = {}) {
    return { id: 'input', kind: members.length === 1 ? 'event' : 'batch', members, ancestry: [{ batchId: 'earlier', parents: ['root'] }], ...changes };
}
function step(type, input, config = {}, now = 0, options = {}) { return stepNode(freeze(node(type, config)), freeze(input), { now, ...options }); }
const ids = output => output.members.map(item => item.id);
const byPort = result => Object.fromEntries(result.emissions.map(emission => [emission.port, ids(emission.unit)]));
function hours(start = '09:00', end = '10:00', maxWaitDays = 1) {
    return { zone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], windows: [{ start, end }], quiet: [], datesExcluded: [], maxWaitDays };
}
const at = time => Date.parse(`2026-09-22T${time}:00Z`);

test('compile preserves all DAG nodes, stages, ports, layout and nested predicates without input aliases', () => {
    const rule = newWorkflow('Full DAG');
    rule.nodes.push(node('limit', {}, 'before'), node('aggregate', {}, 'first'), node('condition', {
        predicate: { op: 'not', conditions: [{ op: 'all', conditions: [{ field: 'title', op: 'exists' }] }] },
    }), node('aggregate', { mode: 'latest' }, 'second'), node('limit', {}, 'after'), node('merge', { mode: 'all' }), node('stop'));
    rule.edges = [['start', 'before', 'out'], ['before', 'first', 'out'], ['first', 'condition', 'out'],
        ['condition', 'second', 'yes'], ['condition', 'stop', 'no'], ['condition', 'merge', 'unknown'],
        ['second', 'after', 'out'], ['after', 'merge', 'out'], ['merge', 'send', 'out']]
        .map(([source, target, port], i) => ({ id: `e${i}`, source, target, port }));
    rule.layout = { groups: [{ id: 'visual', label: 'both stages', collapsed: true }] };
    rule.nodes.find(item => item.id === 'first').group = 'visual';
    const before = structuredClone(rule), plan = compileWorkflow(freeze(rule));
    assert.deepEqual(plan.nodes, rule.nodes); assert.deepEqual(plan.edges, rule.edges); assert.deepEqual(plan.layout, rule.layout);
    assert.equal(plan.startId, 'start'); assert.equal(plan.byId.get('second').config.mode, 'latest');
    assert.deepEqual(plan.incoming.get('merge').map(edge => edge.port), ['unknown', 'out']);
    assert.equal(plan.ranks.get('merge'), 6); assert.equal(plan.topologicalOrder.length, rule.nodes.length);
    plan.byId.get('second').config.mode = 'all'; plan.outgoing.get('start')[0].target = 'changed';
    assert.deepEqual(rule, before);
});

test('compile retains exponentially many implicit paths without imposing evaluator path/output caps', () => {
    const rule = newWorkflow('Diamonds'); let previous = 'start'; rule.edges = [];
    for (let i = 0; i < 30; i++) {
        for (const suffix of ['L', 'R', 'C']) rule.nodes.push(node('transform', {}, `${suffix}${i}`));
        for (const [source, target] of [[previous, `L${i}`], [previous, `R${i}`], [`L${i}`, `C${i}`], [`R${i}`, `C${i}`]]) {
            rule.edges.push({ id: `e${rule.edges.length}`, source, target, port: 'out' });
        }
        previous = `C${i}`;
    }
    rule.edges.push({ id: 'last', source: previous, target: 'send', port: 'out' });
    const plan = compileWorkflow(freeze(rule));
    assert.equal(plan.nodes.length, 92); assert.equal(plan.edges.length, 121); assert.equal(plan.ranks.get('send'), 61);
});

test('compile delegates schema, unreachable-node and cycle rejection to assertWorkflow', () => {
    for (const change of [rule => { rule.schemaVersion = 2; }, rule => { rule.nodes.push(node('stop')); }, rule => {
        rule.nodes.push(node('transform')); rule.edges[0].target = 'transform';
        rule.edges.push({ id: 'loop', source: 'transform', target: 'transform', port: 'out' });
    }]) {
        const rule = newWorkflow(); change(rule);
        assert.throws(() => compileWorkflow(rule), { code: 'AUTOMATION_RULE_INVALID' });
    }
});

test('nested whole predicates evaluate per member, never combining fields across members', () => {
    const predicate = { op: 'all', conditions: [{ field: 'priceAmount', op: 'lt', value: 150 },
        { op: 'any', conditions: [{ field: 'title', op: 'contains', value: 'sale' }, { op: 'not', conditions: [{ field: 'available', op: 'eq', value: false }] }] }] };
    const input = unit([member('yes', { priceAmount: 0, title: 'sale' }), member('high', { priceAmount: 200, title: 'sale' }),
        member('noTitle', { priceAmount: 100, title: 'normal', available: false }), member('missing', { priceAmount: 100 })]);
    const result = step('condition', input, { predicate });
    assert.deepEqual(byPort(result), { yes: ['yes'], no: ['high', 'noTitle'], unknown: ['missing'] });
    assert(result.emissions.every(item => item.unit.kind === 'fragment'));
    assert.deepEqual(result.trace.map(item => item.memberId), ['yes', 'high', 'noTitle', 'missing']);
});

test('missing, null and wrongly typed metadata are unknown; known zero is not missing', () => {
    const input = unit([member('zero', { priceAmount: 0 }), member('absent'), member('null', { priceAmount: null }), member('wrong', { priceAmount: '0' })]);
    assert.deepEqual(byPort(step('condition', input, { predicate: { field: 'priceAmount', op: 'lte', value: 0 } })), { yes: ['zero'], unknown: ['absent', 'null', 'wrong'] });
    assert.deepEqual(byPort(step('condition', input, { predicate: { field: 'priceAmount', op: 'exists' } })), { yes: ['zero'], no: ['absent', 'null', 'wrong'] });
});

test('condition ageMinutes is evaluated at supplied execution time without rewriting observations', () => {
    const input = unit([member('old', { publishedAtMs: 0, ageMinutes: 999 }), member('future', { publishedAtMs: 10 * MINUTE }), member('absent')]);
    const predicate = { field: 'ageMinutes', op: 'gte', value: 5 };
    const result = step('condition', input, { predicate }, 6 * MINUTE);
    assert.deepEqual(byPort(result), { yes: ['old'], no: ['future'], unknown: ['absent'] });
    assert.equal(result.emissions[0].unit.members[0].event.ageMinutes, 999);
    assert.deepEqual(byPort(step('condition', input, { predicate }, MINUTE)), { no: ['old', 'future'], unknown: ['absent'] });
});

test('dictionary matches are synchronous, member-specific and retain missing-field uncertainty', () => {
    const words = new DictionaryMatcher({ schemaVersion: 1, name: 'sale', entries: ['sale'] });
    const input = unit([member('yes', { title: 'SALE' }), member('no', { title: 'normal', body: '' }), member('unknown', { title: 'normal' }), member('absent')]);
    const result = step('dictionary', input, { fields: ['title', 'body'] }, 0, { dictionaries: { words } });
    assert.deepEqual(byPort(result), { yes: ['yes'], no: ['no'], unknown: ['unknown', 'absent'] });
    assert.equal(result.trace[0].detail[0].term, 'sale');
    assert.deepEqual(byPort(step('dictionary', input)), { unknown: ['yes', 'no', 'unknown', 'absent'] });
});

test('dictionary matches array fields and rejects async/malformed matcher contracts', () => {
    const words = new DictionaryMatcher({ schemaVersion: 1, name: 'sale', entries: ['sale'] });
    const input = unit([member('tags', { tags: ['a', 'sale'] }), member('empty', { tags: [] })]);
    assert.deepEqual(byPort(step('dictionary', input, { fields: ['tags'] }, 0, { dictionaries: { words } })), { yes: ['tags'], no: ['empty'] });
    for (const match of [() => Promise.resolve([]), () => [null], () => Array(9).fill({ term: 'x', start: 0, end: 1 })]) {
        assert.throws(() => step('dictionary', input, { fields: ['tags'] }, 0, { dictionaries: { words: { match } } }), { code: 'GRAPH_MATCHER_INVALID' });
    }
});

test('transform replaces each display, clears price fallback and preserves raw fields and provenance', () => {
    const input = unit([member('a', { title: 'original' }, { defaultPriceText: 'stored price', context: { locale: 'ja' }, targetKind: 'price' }), member('b')]);
    input.members[0].display.prefix = 'old';
    const before = structuredClone(input), result = step('transform', input, { template: '{title}', suffix: 'new' });
    const emitted = result.emissions[0].unit;
    assert.equal(emitted.members[0].display.prefix, undefined); assert.equal(emitted.members[0].display.suffix, 'new');
    assert(emitted.members.every(item => item.defaultPriceText === null));
    assert.equal(emitted.members[0].event.title, 'original'); assert.equal(emitted.members[0].targetKind, 'price');
    emitted.members[0].context.locale = 'en'; emitted.ancestry[0].parents.push('changed');
    assert.deepEqual(input, before);
});

test('delay waits for the entire retained batch and excludes only missing published dates', () => {
    const input = unit([member('early', { publishedAtMs: 0 }), member('late', { publishedAtMs: 30000 }), member('missing')]);
    const delayed = step('delay', input, { minutes: 1, anchor: 'published' });
    assert.equal(delayed.state, 'wait'); assert.equal(delayed.wakeAtMs, 90000); assert.deepEqual(delayed.emissions, []);
    assert.deepEqual(ids(delayed.continuation), ['early', 'late']); assert.equal(delayed.continuation.kind, 'fragment');
    assert(delayed.trace.some(item => item.memberId === 'missing' && item.outcome === 'unknown'));
    assert.equal(step('delay', delayed.continuation, { minutes: 1, anchor: 'published' }, 60000).state, 'wait');
    assert.deepEqual(byPort(step('delay', delayed.continuation, { minutes: 1, anchor: 'published' }, 90000)), { out: ['early', 'late'] });
});

test('missing observed timestamp uses a frozen fallback and absolute delays do not accumulate', () => {
    const delayed = step('delay', unit([member('a')]), { minutes: 1 }, 1000);
    assert.equal(delayed.wakeAtMs, 61000); assert.equal(delayed.continuation.members[0].baseTimeMs, 1000);
    const resumed = step('delay', delayed.continuation, { minutes: 1 }, 31000);
    assert.equal(resumed.wakeAtMs, 61000);
    const done = step('delay', resumed.continuation, { minutes: 1 }, 61000);
    assert.equal(step('delay', done.emissions[0].unit, { minutes: 1 }, 61000).state, 'complete');
});

test('member expiry wakes a waiting batch early without expiring healthy members', () => {
    const input = unit([member('short', { observedAtMs: 0 }, { deadlineMs: 50000 }), member('long', { observedAtMs: 0 }, { dueAtMs: 90000 })]);
    const delayed = step('delay', input, { minutes: 0 });
    assert.equal(delayed.wakeAtMs, 50001);
    const resumed = step('delay', delayed.continuation, { minutes: 0 }, 50001);
    assert.equal(resumed.wakeAtMs, 90000); assert.deepEqual(ids(resumed.continuation), ['long']);
    assert(resumed.trace.some(item => item.memberId === 'short' && item.outcome === 'expired'));
    assert.equal(step('delay', resumed.continuation, { minutes: 0 }, 90000).state, 'complete');
});

test('delay beyond an individual deadline excludes that member immediately', () => {
    const result = step('delay', unit([member('short', { observedAtMs: 0 }, { deadlineMs: 59000 }), member('long', { observedAtMs: 0 })]), { minutes: 1 });
    assert.deepEqual(ids(result.continuation), ['long']); assert.equal(result.wakeAtMs, MINUTE);
    assert(result.trace.some(item => item.memberId === 'short' && item.reason === 'DELAY_EXCEEDS_DEADLINE'));
});

test('schedule preserves workflow deadline and freezes its own horizon across resumes', () => {
    const input = unit([member('a', {}, { dueAtMs: at('08:00'), deadlineMs: at('23:00') })]);
    const waiting = step('schedule', input, hours(), at('08:00'));
    assert.equal(waiting.wakeAtMs, at('09:00'));
    const saved = waiting.continuation.members[0];
    assert.equal(saved.deadlineMs, at('23:00')); assert.equal(saved.scheduleDeadlineMs, at('08:00') + DAY);
    const again = step('schedule', waiting.continuation, hours(), at('08:30'));
    assert.equal(again.continuation.members[0].scheduleDeadlineMs, saved.scheduleDeadlineMs);
    assert.equal(again.continuation.members[0].schedules.length, 1);
    const ready = step('schedule', again.continuation, hours(), at('09:00'));
    assert.equal(ready.state, 'complete'); assert.equal(ready.emissions[0].unit.members[0].deadlineMs, at('23:00'));
});

test('schedule intersection waits for member expiry, then reconsiders the remaining restrictions', () => {
    const input = unit([member('morning', {}, { schedules: [hours('09:00', '10:00')], deadlineMs: at('09:30') }),
        member('later', {}, { schedules: [hours('10:00', '11:00')], deadlineMs: at('12:00') })]);
    const config = hours('00:00', '24:00');
    const waiting = step('schedule', input, config, at('08:00'));
    assert.equal(waiting.wakeAtMs, at('09:30') + 1); assert.deepEqual(ids(waiting.continuation), ['morning', 'later']);
    const later = step('schedule', waiting.continuation, config, waiting.wakeAtMs);
    assert.equal(later.wakeAtMs, at('10:00')); assert.deepEqual(ids(later.continuation), ['later']);
    assert.equal(step('schedule', later.continuation, config, at('10:00')).state, 'complete');
});

test('a delay after a schedule cannot bypass inherited windows or extend its horizon', () => {
    const first = step('schedule', unit([member('a', { observedAtMs: at('09:00') }, { deadlineMs: at('12:00') })]), hours(), at('09:00'));
    const delayed = step('delay', first.emissions[0].unit, { minutes: 120 }, at('09:00'));
    assert.equal(delayed.state, 'wait'); assert.equal(delayed.wakeAtMs, at('12:00') + 1);
    const expired = step('delay', delayed.continuation, { minutes: 120 }, delayed.wakeAtMs);
    assert.equal(expired.state, 'complete'); assert.equal(expired.emissions.length, 0); assert.equal(expired.trace[0].outcome, 'expired');
});

test('fresh carried schedules acquire a finite horizon which survives every resume', () => {
    const input = unit([member('a', {}, { schedules: [hours('09:00', '10:00'), hours('11:00', '12:00')] })]);
    const delayed = step('delay', input, { minutes: 0 }, at('08:00'));
    assert.equal(delayed.wakeAtMs, at('08:00') + DAY + 1);
    assert.equal(delayed.continuation.members[0].scheduleDeadlineMs, at('08:00') + DAY);
    const retry = step('delay', delayed.continuation, { minutes: 0 }, at('09:00'));
    assert.equal(retry.wakeAtMs, delayed.wakeAtMs);
    const expired = step('delay', retry.continuation, { minutes: 0 }, retry.wakeAtMs);
    assert.deepEqual(expired.emissions, []); assert.equal(expired.trace[0].outcome, 'expired');
});

test('limit groups distinguish missing, literal unknown and literal all while preserving same-run occurrences', () => {
    const input = unit([member('a', { author: 'unknown' }), member('b'), member('c', { author: null }),
        member('d', { author: 'all' }), member('e', { author: 1 }), member('f', { author: 'unknown' }, { runId: 'run-a' })]);
    const result = step('limit', input, { key: 'author' });
    assert.equal(result.state, 'limit'); assert.deepEqual(result.emissions, []); assert.equal(result.groups.length, 3);
    assert.deepEqual(result.groups.map(group => [group.key.type, group.key.value, ids(group.unit)]), [
        ['string', 'unknown', ['a', 'f']], ['missing', undefined, ['b', 'c', 'e']], ['string', 'all', ['d']],
    ]);
    assert.equal(new Set(result.groups.map(group => group.keyId)).size, 3);
    assert(result.groups.every(group => group.unit.kind === 'fragment'));
    const all = step('limit', input, { key: 'all' });
    assert.deepEqual(all.groups[0].key, { field: 'all', type: 'all' }); assert.equal(all.groups[0].unit.members.length, 6);
});

test('all supported field keys partition deterministically by their own typed values', () => {
    for (const key of ['sourceKey', 'providerId', 'author', 'currency']) {
        const input = unit([member('a', { [key]: 'first' }), member('b', { [key]: 'second' }), member('c', { [key]: 'first' })]);
        const result = step('aggregate', input, { key });
        assert.deepEqual(result.groups.map(group => ids(group.unit)), [['a', 'c'], ['b']]);
        assert.deepEqual(result, step('aggregate', input, { key }));
    }
});

test('aggregate latest and maxItems are intents only; no member selection or ancestry collapse occurs', () => {
    const input = unit([member('a', { title: 'sale' }), member('b', { title: 'normal' }), member('c', { title: 'sale' })], { ancestry: [{ batchId: 'one' }, { batchId: 'two', parents: ['one'] }] });
    for (const mode of ['all', 'latest']) {
        const aggregate = step('aggregate', input, { key: 'all', mode, maxItems: 1 });
        assert.equal(aggregate.state, 'aggregate'); assert.equal(aggregate.intent.config.mode, mode);
        assert.deepEqual(ids(aggregate.groups[0].unit), ['a', 'b', 'c']); assert.deepEqual(aggregate.groups[0].unit.ancestry, input.ancestry);
    }
    // Selection belongs to the parent executor: this is its already sealed
    // latest membership, which must not fall back to older matching input.
    const selected = unit([input.members[1]], { kind: 'batch', ancestry: input.ancestry });
    assert.deepEqual(byPort(step('condition', selected, { predicate: { field: 'title', op: 'contains', value: 'sale' } })), { no: ['b'] });
});

test('merge always requests durable closure and never passes an arrival through', () => {
    for (const mode of ['any', 'all']) {
        const result = step('merge', unit([member('a'), member('b')]), { mode, displayConflict: 'reset' });
        assert.equal(result.state, 'merge'); assert.deepEqual(result.emissions, []);
        assert.deepEqual(ids(result.continuation), ['a', 'b']); assert.equal(result.intent.config.mode, mode);
    }
});

test('send exposes destination and eligible members without rendering or walking edges', () => {
    const input = unit([member('expired', {}, { deadlineMs: 0 }), member('kept', { title: 'title' }, { defaultPriceText: 'frozen price' })]);
    const sent = step('send', input, { destination: 'other' }, 1);
    assert.equal(sent.state, 'send'); assert.equal(sent.destination, 'other'); assert.deepEqual(sent.emissions, []);
    assert.deepEqual(ids(sent.continuation), ['kept']); assert.equal(sent.continuation.members[0].defaultPriceText, 'frozen price');
});

test('start filters provider and kind per member; stop produces explicit terminal outcomes', () => {
    const input = unit([member('yes', { providerId: 'github', kind: 'new' }), member('no', { providerId: 'github', kind: 'old' }), member('missing')]);
    const start = step('start', input, { providers: ['github'], kinds: ['new'] });
    assert.deepEqual(byPort(start), { out: ['yes'] }); assert.equal(start.trace.filter(item => item.outcome === 'excluded').length, 2);
    const stop = step('stop', input, { reason: 'chosen exclusion' });
    assert.deepEqual(stop.emissions, []); assert(stop.trace.every(item => item.reason === 'chosen exclusion'));
});

test('output fragments do not alias inputs, other fragments, node config, or lineage objects', () => {
    const input = unit([member('yes', { available: true }), member('no', { available: false })]);
    const before = structuredClone(input);
    const result = step('condition', input, { predicate: { field: 'available', op: 'eq', value: true } });
    result.emissions[0].unit.ancestry[0].parents.push('new');
    result.emissions[0].unit.members[0].display.template = 'changed';
    assert.deepEqual(input, before); assert.deepEqual(result.emissions[1].unit.ancestry, before.ancestry);
});

test('sealed store occurrence IDs, lineage IDs, nested batch inputs and received counts survive transitions', () => {
    const input = unit([member('occurrence-1', { title: 'sale' }, { lineageId: 'original-1', context: { locale: 'ja' }, targetKind: 'auto' }),
        member('occurrence-2', { title: 'normal' }, { lineageId: 'original-2' })],
    { batchInputs: [{ unitId: 'first-batch', ordinal: 0 }, { unitId: 'second-batch', ordinal: 1 }], receivedCount: 2 });
    const before = structuredClone(input);
    const result = step('condition', input, { predicate: { field: 'title', op: 'contains', value: 'sale' } });
    const yes = result.emissions[0].unit, no = result.emissions[1].unit;
    assert.equal(yes.members[0].id, 'occurrence-1'); assert.equal(yes.members[0].lineageId, 'original-1');
    assert.deepEqual(yes.batchInputs, input.batchInputs); assert.equal(yes.receivedCount, 2);
    yes.batchInputs[0].ordinal = 100;
    assert.deepEqual(no.batchInputs, before.batchInputs); assert.deepEqual(input, before);
});

test('empty units terminate; deadline is inclusive and schedule deadline applies at every node', () => {
    assert.deepEqual(step('aggregate', unit([])), { state: 'complete', emissions: [], trace: [] });
    const input = unit([member('a', {}, { deadlineMs: 10, scheduleDeadlineMs: 5 })]);
    assert.equal(step('send', input, {}, 5).state, 'send');
    const expired = step('send', input, {}, 6);
    assert.equal(expired.state, 'complete'); assert.equal(expired.trace[0].outcome, 'expired');
});

test('invalid clocks, units, node configs and oversized materializations fail explicitly', () => {
    const input = unit([member('a')]);
    for (const now of [undefined, NaN, Infinity, 0.5]) assert.throws(() => stepNode(node('send'), input, { now }), { code: 'GRAPH_TIME_INVALID' });
    assert.throws(() => stepNode(node('send'), input), { code: 'GRAPH_TIME_INVALID' });
    assert.throws(() => step('limit', input, { count: 0 }), { code: 'AUTOMATION_RULE_INVALID' });
    assert.throws(() => stepNode({ id: 'bad', type: 'invented', config: {} }, input, { now: 0 }), { code: 'GRAPH_NODE_INVALID' });
    assert.throws(() => step('send', unit([member('a'), member('a')])), { code: 'GRAPH_UNIT_INVALID' });
    assert.throws(() => step('send', unit([member('a')], { ancestry: Array(KERNEL_LIMITS.ancestry + 1).fill('x') })), { code: 'GRAPH_INPUT_LIMIT' });
    assert.throws(() => step('send', unit([member('a', { body: 'x'.repeat(KERNEL_LIMITS.bytes) })])), { code: 'GRAPH_INPUT_LIMIT' });
});

test('input copying rejects getters, cycles and non-data objects without invoking accessors', () => {
    let invoked = false;
    const input = unit([member('a')]); Object.defineProperty(input, 'extra', { enumerable: true, get() { invoked = true; return 'bad'; } });
    assert.throws(() => stepNode(node('send'), input, { now: 0 }), { code: 'GRAPH_INPUT_INVALID' }); assert.equal(invoked, false);
    const cycle = unit([member('a')]); cycle.ancestry.push(cycle);
    assert.throws(() => stepNode(node('send'), cycle, { now: 0 }), { code: 'GRAPH_INPUT_INVALID' });
    assert.throws(() => stepNode(node('send'), unit([member('a')], { extra: new Date(0) }), { now: 0 }), { code: 'GRAPH_INPUT_INVALID' });
    const sparse = []; sparse[1] = 'hole';
    assert.throws(() => stepNode(node('send'), unit([member('a')], { ancestry: sparse }), { now: 0 }), { code: 'GRAPH_INPUT_INVALID' });
});
