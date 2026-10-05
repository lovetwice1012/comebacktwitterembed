'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createEvaluator } = require('../src/automation/evaluation');
const { starterDictionary } = require('../src/automation/moderation');
const argument = process.argv[2] || '10000', count = Number(argument);
if (argument !== 'starter' && ![10000, 100000, 1000000].includes(count)) throw new Error('Use starter, 10000, 100000 or 1000000');
let seed = 123456789;
function next() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
const dictionary = argument === 'starter' ? starterDictionary() : { schemaVersion: 1, name: '固定seed・編集試験', source: 'Generated synthetic benchmark data, seed=123456789', license: 'CC0-1.0', entries: Array.from({ length: count }, (_, i) => `${next().toString(36).padStart(7, '0')}_${i.toString(36).padStart(5, '0')}`) };
const evaluator = createEvaluator(async () => dictionary);
const measurements = {}, delays = [];
let peakRss = process.memoryUsage().rss, previous = performance.now();
const monitor = setInterval(() => { const now = performance.now(); delays.push(Math.max(0, now - previous - 10)); previous = now; peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
async function measure(name, work) { const start = performance.now(); const result = await work(); measurements[name] = performance.now() - start; return result; }
async function main() {
    try {
        const analysis = await measure('analyzeMs', () => evaluator.dictionaryTask({ operation: 'analyze', dictionary, summaryOnly: true }));
        assert.equal(analysis.conflictCount, 0); assert.equal(analysis.entryCount, dictionary.entries.length);
        const csv = await measure('exportCsvMs', () => evaluator.dictionaryTask({ operation: 'export', dictionary, format: 'csv' }));
        const imported = await measure('parseCsvMs', () => evaluator.dictionaryTask({ operation: 'parse', text: csv, format: 'csv', summaryOnly: true }));
        assert.equal(imported.entryCount, dictionary.entries.length);
        const modified = await measure('patchMs', () => evaluator.dictionaryTask({ operation: 'patch', dictionary, patch: { operations: [{ op: 'remove', index: 0, expected: dictionary.entries[0] }, { op: 'add', entry: 'unique-benchmark-added-entry-123456789' }] } }));
        const delta = await measure('diffMs', () => evaluator.dictionaryTask({ operation: 'diff', before: dictionary, after: modified.dictionary }));
        assert.equal(delta.added, 1); assert.equal(delta.removed, 1); assert.equal(delta.changed, 0);
        const page = await measure('lastPageMs', () => evaluator.dictionaryTask({ operation: 'page', dictionary, offset: dictionary.entries.length - 100, count: 100 }));
        assert.equal(page.records.length, 100);
        const term = value => typeof value === 'string' ? value : value.term;
        const samples = Array.from({ length: 100 }, (_, i) => `通常の文章 ${term(dictionary.entries[Math.floor(i * dictionary.entries.length / 100)])} some trailing text`);
        await measure('coldCompileAndMatchMs', () => evaluator.match({ id: 'benchmark', revision: 1 }, samples[0]));
        for (let i = 0; i < 30; i++) await evaluator.match({ id: 'benchmark', revision: 1 }, samples[i]);
        const times = [];
        for (const sample of samples) { const start = performance.now(); const matched = await evaluator.match({ id: 'benchmark', revision: 1 }, sample); assert(matched.length > 0); times.push(performance.now() - start); }
        times.sort((a, b) => a - b); delays.sort((a, b) => a - b);
        console.log(JSON.stringify({ dataset: argument === 'starter' ? 'naughty-words-1.2.0, attributed real vocabulary' : 'synthetic', seed: argument === 'starter' ? null : 123456789,
            node: process.version, entries: dictionary.entries.length, csvBytes: Buffer.byteLength(csv), ...measurements, matchMedianMs: times[50], matchP95Ms: times[95],
            sampledPeakRssMiB: peakRss / 1048576, mainLoopDelayP99Ms: delays[Math.floor(delays.length * .99)] || 0, mainLoopDelayMaxMs: delays.at(-1) || 0, verified: true }));
    } finally { clearInterval(monitor); evaluator.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
