'use strict';

// Fixed seed/inputs; print JSON so benchmark evidence can be retained without
// reading production messages or private word lists.
const { performance } = require('node:perf_hooks');
const { DictionaryMatcher } = require('../src/automation/dictionary');
const size = Number(process.argv[2] || 10000);
if (![10000, 100000, 1000000].includes(size)) throw new Error('Use 10000, 100000 or 1000000');
let seed = 123456789;
function next() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
const entries = Array.from({ length: size }, (_, i) => `${next().toString(36).padStart(7, '0')}_${i.toString(36).padStart(5, '0')}`);
const samples = Array.from({ length: 100 }, (_, i) => '通常の文章 '.repeat(100) + entries[Math.floor(i * size / 100)] + ' some trailing text '.repeat(20));
global.gc?.();
const before = process.memoryUsage(), start = performance.now();
const matcher = new DictionaryMatcher({ schemaVersion: 1, name: 'fixed-seed', entries });
const buildMs = performance.now() - start;
global.gc?.();
const after = process.memoryUsage();
for (let i = 0; i < 30; i++) matcher.match(samples[i]);
const timings = [], counts = [];
for (const sample of samples) { const t = performance.now(); counts.push(matcher.match(sample).length); timings.push(performance.now() - t); }
if (counts.some(n => n !== 1)) throw new Error('Incorrect match count');
timings.sort((a, b) => a - b);
console.log(JSON.stringify({ seed: 123456789, size, node: process.version, sampleCount: samples.length, textLength: samples[0].length,
    buildMs, matchMedianMs: timings[50], matchP95Ms: timings[95], rssMiB: after.rss / 1048576,
    heapMiB: after.heapUsed / 1048576, rssDeltaMiB: (after.rss - before.rss) / 1048576, ...matcher.stats }));
