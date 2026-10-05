'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvaluator } = require('../../src/automation/evaluation');
const { newWorkflow } = require('../../src/automation/schema');
if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test is required');
const data = (name, entries = [name]) => ({ schemaVersion: 1, name, entries, source: 'synthetic test fixture', license: 'CC0-1.0' });
const ref = (id, revision = 1) => ({ id, revision });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, options, dictionaries) {
    const loads = [];
    const evaluator = createEvaluator(async (id, revision) => { loads.push([id, revision]); return dictionaries?.[id + ':' + revision] || data(id); }, options);
    t.after(() => evaluator.stop()); return { evaluator, loads };
}

test('alternating references skip SQL and compilation while both matchers are resident', async t => {
    const { evaluator, loads } = fixture(t);
    for (const name of ['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta']) assert.equal((await evaluator.match(ref(name), name)).length, 1);
    assert.deepEqual(loads, [['alpha', 1], ['beta', 1]]);
    const stats = await evaluator.stats(); assert.equal(stats.cacheHits, 4); assert.equal(stats.cacheMisses, 2); assert.equal(stats.worker.compiles, 2);
    assert.equal(stats.worker.residents.length, 2); assert.equal(stats.worker.evictions, 0);
    assert(stats.worker.residents.every(r => r.residentBytes > r.allocatedBytes && r.metadataBytes > 0));
});

test('LRU entry limit evicts the least recently matched dictionary and main-thread metadata follows eviction', async t => {
    const { evaluator, loads } = fixture(t, { maxCacheEntries: 2 });
    for (const name of ['alpha', 'beta', 'alpha', 'gamma', 'alpha', 'beta']) await evaluator.match(ref(name), name);
    assert.deepEqual(loads.map(([id]) => id), ['alpha', 'beta', 'gamma', 'beta']);
    const stats = await evaluator.stats(); assert.equal(stats.worker.compiles, 4); assert.equal(stats.worker.evictions, 2);
    assert.deepEqual(stats.worker.residents.map(r => JSON.parse(r.key.slice(5))[0]), ['alpha', 'beta']);
});

test('byte budget includes entry metadata, limits residency, and reloads evicted versions honestly', async t => {
    const { evaluator, loads } = fixture(t, { maxCacheBytes: 50000 });
    for (const name of ['alpha', 'beta', 'alpha']) {
        assert.equal((await evaluator.match(ref(name), name)).length, 1);
        const stats = await evaluator.stats(); assert(stats.worker.residentBytes <= 50000); assert.equal(stats.worker.residents.length, 1);
    }
    assert.equal(loads.length, 3); assert.equal((await evaluator.stats()).worker.evictions, 2);
    const rich = data('rich', Array.from({ length: 8 }, (_, i) => ({ term: 'term-' + i, replacement: 'x'.repeat(2048), category: 'c'.repeat(80) })));
    const richEvaluator = createEvaluator(async () => rich, { maxCacheBytes: 50000 }); t.after(() => richEvaluator.stop());
    await assert.rejects(richEvaluator.match(ref('rich'), 'term-0'), /DICTIONARY_WORKER_MEMORY_LIMIT/);
    const rejected = await richEvaluator.stats(); assert.equal(rejected.worker.residentBytes, 0); assert.equal(rejected.worker.residents.length, 0);
    await assert.rejects(richEvaluator.match(ref('rich'), 'term-0'), /DICTIONARY_WORKER_MEMORY_LIMIT/);
    assert.equal((await richEvaluator.stats()).dictionaryLoads, 2);
});

test('rule and moderation caches distinguish revisions and starter policy keys', async t => {
    const { evaluator } = fixture(t, undefined, { 'same:1': data('one', ['revision-one']), 'same:2': data('two', ['revision-two']) });
    assert.equal((await evaluator.match(ref('same', 1), 'revision-one')).length, 1);
    assert.equal((await evaluator.match(ref('same', 2), 'revision-one')).length, 0);
    assert.equal((await evaluator.matchModeration({ id: 'same', revision: 1, useStarter: false }, 'xxx')).length, 0);
    assert((await evaluator.matchModeration({ id: 'same', revision: 1, useStarter: true }, 'xxx')).length > 0);
    assert.equal((await evaluator.match(ref('same', 1), 'xxx')).length, 0);
    assert.equal((await evaluator.matchModeration({ id: 'same', revision: 1, useStarter: false }, 'xxx')).length, 0);
    const stats = await evaluator.stats(); assert.equal(stats.worker.compiles, 4); assert.equal(stats.cacheHits, 2);
    assert.equal(stats.worker.residents.filter(r => r.key.startsWith('rule:')).length, 2);
    assert.equal(stats.worker.residents.filter(r => r.key.startsWith('moderation:')).length, 2);
});

test('page/export/patch/diff preserve immutable cached revisions when memory permits', async t => {
    const dictionaries = { 'words:1': data('words', ['old']), 'other:1': data('other') };
    const { evaluator, loads } = fixture(t, undefined, dictionaries);
    await evaluator.match(ref('words'), 'old'); await evaluator.match(ref('other'), 'other');
    await evaluator.dictionaryTask({ operation: 'page', dictionary: dictionaries['words:1'] });
    await evaluator.dictionaryTask({ operation: 'export', dictionary: dictionaries['words:1'], format: 'json' });
    const changed = await evaluator.dictionaryTask({ operation: 'patch', dictionary: dictionaries['words:1'], patch: { operations: [{ op: 'replace', index: 0, expected: 'old', entry: 'new' }] } });
    dictionaries['words:2'] = changed.dictionary;
    const delta = await evaluator.dictionaryTask({ operation: 'diff', before: dictionaries['words:1'], after: changed.dictionary }); assert.equal(delta.added, 1);
    await assert.rejects(evaluator.dictionaryTask({ operation: 'invalid' }), /DICTIONARY_OPERATION/);
    assert.equal((await evaluator.match(ref('words'), 'old')).length, 1);
    assert.equal((await evaluator.match(ref('other'), 'other')).length, 1); assert.equal(loads.length, 2);
    assert.equal((await evaluator.match(ref('words', 2), 'new')).length, 1);
    assert.equal((await evaluator.match(ref('words'), 'new')).length, 0);
    assert.equal((await evaluator.stats()).worker.compiles, 3);
});

test('large editing reserves headroom and reports eviction without pretending the old matcher is resident', async t => {
    const { evaluator, loads } = fixture(t, { maxCacheBytes: 150000 });
    await evaluator.match(ref('alpha'), 'alpha'); await evaluator.match(ref('beta'), 'beta');
    const large = data('large', Array.from({ length: 50000 }, (_, i) => 'entry-' + i));
    const page = await evaluator.dictionaryTask({ operation: 'page', dictionary: large, count: 10 }); assert.equal(page.records.length, 10);
    let stats = await evaluator.stats(); assert.equal(stats.worker.residents.length, 0); assert.equal(stats.worker.editingEvictions, 2);
    await evaluator.match(ref('alpha'), 'alpha'); assert.equal(loads.length, 3);
    stats = await evaluator.stats(); assert.equal(stats.worker.compiles, 3);
});

test('stop resets resident metadata and reloads immutable revisions into a new worker', async t => {
    const { evaluator, loads } = fixture(t);
    await evaluator.match(ref('alpha'), 'alpha'); await evaluator.stop();
    assert.equal((await evaluator.stats()).worker, null);
    await evaluator.match(ref('alpha'), 'alpha');
    const stats = await evaluator.stats(); assert.equal(loads.length, 2); assert.equal(stats.workerStarts, 2); assert.equal(stats.workerResets, 1); assert.equal(stats.worker.compiles, 1);
});

test('already admitted matching completes before its reserved heavy edit; excess heavy payloads are rejected', { timeout: 10000 }, async t => {
    const { evaluator } = fixture(t), second = fixture(t).evaluator;
    const large = data('large', Array.from({ length: 50000 }, (_, i) => 'entry-' + i));
    const matched = evaluator.match(ref('alpha'), 'alpha');
    const edited = evaluator.dictionaryTask({ operation: 'analyze', dictionary: large, summaryOnly: true });
    const rejected = assert.rejects(second.dictionaryTask({ operation: 'analyze', dictionary: large, summaryOnly: true }), { code: 'AUTOMATION_WORKER_BUSY' });
    const next = second.match(ref('beta'), 'beta');
    const [matches, edit, , later] = await Promise.all([matched, edited, rejected, next]);
    assert.equal(matches.length, 1); assert.equal(edit.entryCount, 50000); assert.equal(later.length, 1);
    assert((await second.stats()).heavyWaits >= 1);
});

test('waiting matching receives the next heavy slot before newly arriving edits, without preloading SQL', { timeout: 10000 }, async t => {
    const gate = deferred(), loaded = deferred(); let sqlCalls = 0;
    const editor = fixture(t).evaluator;
    const matching = createEvaluator(async () => { sqlCalls++; loaded.resolve(); await gate.promise; return data('alpha'); }); t.after(() => matching.stop());
    const large = data('large', Array.from({ length: 50000 }, (_, i) => 'entry-' + i));
    const edit = editor.dictionaryTask({ operation: 'analyze', dictionary: large, summaryOnly: true });
    const match = matching.match(ref('alpha'), 'alpha');
    assert.equal(sqlCalls, 0);
    await edit; await loaded.promise;
    await assert.rejects(editor.dictionaryTask({ operation: 'analyze', dictionary: large, summaryOnly: true }), { code: 'AUTOMATION_WORKER_BUSY' });
    gate.resolve(); assert.equal((await match).length, 1);
    assert.equal((await editor.dictionaryTask({ operation: 'analyze', dictionary: large, summaryOnly: true })).entryCount, 50000);
});

test('stop aborts a delayed SQL load and queued work, releases admission, and late SQL completion cannot resurrect the worker', { timeout: 10000 }, async t => {
    const gate = deferred(), started = deferred();
    const evaluator = createEvaluator(async () => { started.resolve(); return gate.promise; }); t.after(() => evaluator.stop());
    const first = evaluator.match(ref('alpha'), 'alpha');
    const queued = evaluator.match(ref('beta'), 'beta');
    const settled = Promise.allSettled([first, queued]); await started.promise;
    const other = fixture(t).evaluator, waiting = other.match(ref('gamma'), 'gamma');
    await evaluator.stop();
    assert((await settled).every(r => r.status === 'rejected' && r.reason.message === 'AUTOMATION_WORKER_STOPPED'));
    assert.equal((await waiting).length, 1);
    gate.resolve(data('alpha')); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await evaluator.stats()).worker, null); assert.equal((await evaluator.stats()).workerStarts, 0);
});

test('cancelled waiters leave the process admission queue and a failed loader releases its permit', { timeout: 10000 }, async t => {
    const gate = deferred(), started = deferred();
    const holder = createEvaluator(async () => { started.resolve(); await gate.promise; throw new Error('fixture SQL failure'); }); t.after(() => holder.stop());
    const holding = assert.rejects(holder.match(ref('holder'), ''), /fixture SQL failure/); await started.promise;
    const waiter = fixture(t).evaluator;
    const waiting = assert.rejects(waiter.match(ref('waiter'), ''), /AUTOMATION_WORKER_STOPPED/);
    await waiter.stop(); await waiting; gate.resolve(); await holding;
    const next = fixture(t).evaluator; assert.equal((await next.match(ref('next'), 'next')).length, 1);
});

test('a stalled SQL load times out and cannot starve matching already waiting on another evaluator', { timeout: 10000 }, async t => {
    const started = deferred(), gate = deferred();
    const stalled = createEvaluator(async () => { started.resolve(); return gate.promise; }, { dictionaryLoadTimeoutMs: 20 }); t.after(() => stalled.stop());
    const timedOut = assert.rejects(stalled.match(ref('stalled'), ''), /AUTOMATION_DICTIONARY_LOAD_TIMEOUT/);
    await started.promise;
    const next = fixture(t).evaluator, queued = next.match(ref('next'), 'next');
    await timedOut; assert.equal((await queued).length, 1);
    gate.resolve(data('stalled')); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await stalled.stats()).workerStarts, 0);
});

test('queue admission stays bounded and stop rejects every queued match without resurrection', { timeout: 10000 }, async t => {
    const gate = deferred(), started = deferred();
    const evaluator = createEvaluator(async () => { started.resolve(); return gate.promise; }); t.after(() => evaluator.stop());
    const jobs = Array.from({ length: 32 }, () => evaluator.match(ref('alpha'), 'alpha'));
    const settled = Promise.allSettled(jobs); await started.promise;
    await assert.rejects(evaluator.match(ref('alpha'), ''), /AUTOMATION_WORKER_QUEUE_FULL/);
    await evaluator.stop(); assert((await settled).every(r => r.status === 'rejected'));
    gate.resolve(data('alpha')); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await evaluator.stats()).worker, null);
});

test('workflow evaluation reuses both cached dictionaries without changing branch results', async t => {
    const { evaluator, loads } = fixture(t);
    const workflow = newWorkflow('cache branches');
    workflow.nodes.push({ id: 'alpha', type: 'dictionary', config: { dictionary: 'a', fields: ['title'] } }, { id: 'beta', type: 'dictionary', config: { dictionary: 'b', fields: ['title'] } });
    workflow.edges = [{ id: 'a', source: 'start', target: 'alpha', port: 'out' }, { id: 'b', source: 'alpha', target: 'beta', port: 'no' }, { id: 'c', source: 'beta', target: 'send', port: 'yes' }];
    for (let i = 0; i < 3; i++) assert.equal((await evaluator.evaluate(workflow, { title: 'beta', observedAtMs: 1000 }, { dictionaries: { a: ref('alpha'), b: ref('beta') } }, 1000)).outputs.length, 1);
    assert.equal(loads.length, 2); assert.equal((await evaluator.stats()).worker.compiles, 2);
});

test('cache configuration cannot silently exceed the hard default byte budget', () => {
    for (const options of [{ maxCacheBytes: Infinity }, { maxCacheBytes: 481 * 1024 * 1024 }, { maxCacheBytes: 0 }, { maxCacheEntries: 1000 }]) assert.throws(() => createEvaluator(null, options), /DICTIONARY_CACHE_BUDGET/);
});

test('real isolated SQL loads immutable revisions only on a cache miss', { skip: !process.env.AUTOMATION_TEST_DB_PORT, timeout: 30000 }, async t => {
    assert.equal(Number(process.env.AUTOMATION_TEST_DB_PORT), 33619);
    const db = await require('../lib/automation-test-db').createTestDatabase(33619);
    const service = require('../../src/automation/service').createService(db), actor = { userId: '222222222222222222' };
    let evaluator;
    try {
        const first = await service.saveDictionary(actor, { dictionary: data('sql-one', ['old']) });
        const second = await service.saveDictionary(actor, { dictionary: data('sql-two', ['other']) });
        evaluator = createEvaluator(service.dictionaryData);
        for (let i = 0; i < 3; i++) { assert.equal((await evaluator.match(first, 'old')).length, 1); assert.equal((await evaluator.match(second, 'other')).length, 1); }
        assert.equal((await evaluator.stats()).dictionaryLoads, 2);
        const revised = await service.saveDictionary(actor, { expectedRevision: 1, dictionary: data('sql-one', ['new']) }, first.id);
        assert.equal((await evaluator.match(revised, 'new')).length, 1); assert.equal((await evaluator.match(first, 'new')).length, 0);
        assert.equal((await evaluator.stats()).dictionaryLoads, 3);
    } finally { await evaluator?.stop(); await db.close(); }
});
