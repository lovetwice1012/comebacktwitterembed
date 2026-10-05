'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newWorkflow, validateWorkflow } = require('../../src/automation/schema');
const { parseWorkflow, stringifyWorkflow, semanticWorkflow } = require('../../src/automation/format');
const { evaluateWorkflow, evaluatePredicate, UNKNOWN } = require('../../src/automation/engine');
const { nextWindow, scheduleDelivery } = require('../../src/automation/schedule');
const { DictionaryMatcher } = require('../../src/automation/dictionary');

function branchRule() {
    const rule = newWorkflow('昼にセール通知');
    rule.nodes.push({ id: 'condition', type: 'condition', config: { predicate: { op: 'any', conditions: [{ field: 'title', op: 'contains', value: 'セール' }, { field: 'discountPercent', op: 'gte', value: 50 }] } } });
    rule.edges = [{ id: 'a', source: 'start', target: 'condition', port: 'out' }, { id: 'b', source: 'condition', target: 'send', port: 'yes' }];
    return rule;
}
function hours(changes = {}) { return { zone: 'Asia/Tokyo', days: [1, 2, 3, 4, 5, 6, 7], windows: [{ start: '09:00', end: '22:00' }], quiet: [], datesExcluded: [], maxWaitDays: 14, ...changes }; }

test('GUI canonical graph round trips JSON/YAML preserving layout and semantics', () => {
    const rule = branchRule();
    rule.layout = { groups: [{ id: 'g', label: '選別', collapsed: false }], viewport: { x: 23, y: 42, zoom: 1.4 } };
    rule.nodes[0].group = 'g';
    for (const format of ['json', 'yaml']) {
        const restored = parseWorkflow(stringifyWorkflow(rule, format), format);
        assert.deepEqual(restored, rule);
        assert.deepEqual(evaluateWorkflow(restored, { title: 'セール', observedAtMs: 1000 }, { now: 1000 }), evaluateWorkflow(rule, { title: 'セール', observedAtMs: 1000 }, { now: 1000 }));
    }
    const moved = structuredClone(rule); moved.nodes[0].position.x = 800;
    assert.deepEqual(semanticWorkflow(moved), semanticWorkflow(rule));
});
test('invalid graphs, cycles, unreachable nodes, unknown types and malicious YAML fail closed', () => {
    const cycle = branchRule(); cycle.edges.push({ id: 'c', source: 'condition', target: 'condition', port: 'no' });
    assert.equal(validateWorkflow(cycle).valid, false);
    const unknown = newWorkflow(); unknown.nodes[1].type = 'exec';
    assert.equal(validateWorkflow(unknown).valid, false);
    assert.throws(() => parseWorkflow('a: &a [1]\nb: *a'));
    assert.throws(() => parseWorkflow('name: first\nname: second'));
    assert.throws(() => parseWorkflow('{"__proto__":{"polluted":true}}', 'json'));
    assert.equal({}.polluted, undefined);
});
test('missing metadata remains unknown with three-valued AND/OR/NOT; zero is a known price', () => {
    assert.equal(evaluatePredicate({ field: 'priceAmount', op: 'lte', value: 0 }, {}), UNKNOWN);
    assert.equal(evaluatePredicate({ field: 'priceAmount', op: 'lte', value: 0 }, { priceAmount: 0 }), true);
    assert.equal(evaluateWorkflow(branchRule(), { title: '通常', observedAtMs: 1000 }, { now: 1000 }).outputs.length, 0);
    assert.equal(evaluateWorkflow(branchRule(), { title: 'セール', observedAtMs: 1000 }, { now: 1000 }).outputs.length, 1);
    const not = { op: 'not', conditions: [{ field: 'body', op: 'contains', value: '広告' }] };
    assert.equal(evaluatePredicate(not, {}), UNKNOWN);
});
test('quiet hours cross midnight, exclusion dates skip a whole local day, boundary is half-open', () => {
    const config = hours({ windows: [{ start: '00:00', end: '24:00' }], quiet: [{ start: '22:00', end: '09:00' }], datesExcluded: ['2026-09-22'] });
    assert.equal(new Date(nextWindow(Date.parse('2026-09-21T23:00:00+09:00'), config)).toISOString(), '2026-09-23T00:00:00.000Z');
    assert.equal(nextWindow(Date.parse('2026-09-21T09:00:00+09:00'), config), Date.parse('2026-09-21T09:00:00+09:00'));
    assert.equal(nextWindow(Date.parse('2026-09-21T22:00:00+09:00'), config, Date.parse('2026-09-21T23:00:00+09:00')), null);
});
test('DST gap skips nonexistent appointment; fold includes both occurrences', () => {
    const config = hours({ zone: 'America/New_York', windows: [{ start: '02:30', end: '02:31' }] });
    assert.equal(new Date(nextWindow(Date.parse('2026-03-08T06:00:00Z'), config)).toISOString(), '2026-03-09T06:30:00.000Z');
    const fold = hours({ zone: 'America/New_York', windows: [{ start: '01:00', end: '02:00' }] });
    assert.equal(nextWindow(Date.parse('2026-11-01T06:30:00Z'), fold), Date.parse('2026-11-01T06:30:00Z'));
});
test('conflicting schedules do not deliver and late evaluation never schedules into the past', () => {
    const at = Date.parse('2026-09-21T00:00:00Z');
    assert.equal(scheduleDelivery(at, [hours({ windows: [{ start: '09:00', end: '10:00' }] }), hours({ windows: [{ start: '12:00', end: '13:00' }] })], at + 86400000), null);
    const rule = newWorkflow(); rule.expiresAfterMinutes = 1;
    assert.equal(evaluateWorkflow(rule, { observedAtMs: 1000 }, { now: 62000 }).outputs.length, 0);
});

test('schedule maximum wait is frozen in the plan and cannot be extended by later retries', () => {
    const rule = newWorkflow('待機上限');
    rule.nodes.splice(1, 0, { id: 'time', type: 'schedule', config: hours({ maxWaitDays: 2 }) });
    rule.edges = [{ id: 'a', source: 'start', target: 'time', port: 'out' }, { id: 'b', source: 'time', target: 'send', port: 'out' }];
    const now = Date.parse('2026-09-22T00:00:00Z');
    const plan = evaluateWorkflow(rule, { observedAtMs: now }, { now }).outputs[0];
    assert.equal(plan.deadlineMs, now + 2 * 86400000);
    assert.equal(scheduleDelivery(now + 3 * 86400000, plan.schedules, plan.deadlineMs), null);
    assert.equal(evaluateWorkflow(newWorkflow(), {}, { now }).outputs[0].deadlineMs, null);
});
test('dictionary handles normalization, overlaps, allow spans, word boundaries and suffix links', () => {
    const matcher = new DictionaryMatcher({ schemaVersion: 1, name: 'テスト', entries: ['he', 'she', 'hers', { term: 'helicopter', kind: 'allow' }, { term: 'cat', mode: 'word' }, '広告'] });
    assert.deepEqual(matcher.match('SHE').map(m => m.term), ['she', 'he']);
    assert.deepEqual(matcher.match('HELICOPTER cat scatter 広告').map(m => m.term), ['cat', '広告']);
    assert.equal(matcher.match('ｃａｔ')[0].term, 'cat');
    assert.throws(() => new DictionaryMatcher({ schemaVersion: 1, name: 'x', entries: ['cat', { term: 'CAT', kind: 'allow' }] }));
});
test('large dictionary is reused for different events without per-subscription duplication', () => {
    const entries = Array.from({ length: 10000 }, (_, i) => `term${String(i).padStart(8, '0')}`);
    const matcher = new DictionaryMatcher({ schemaVersion: 1, name: 'large', entries });
    assert.equal(matcher.match('start term00009999 end')[0].term, 'term00009999');
    assert.equal(matcher.match('nothing here').length, 0);
    assert.ok(matcher.stats.allocatedBytes < 2000000);
});
