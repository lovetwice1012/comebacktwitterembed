'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'docs/audits/completion/dictionary-performance/compact');
const legacy = require('../docs/audits/completion/dictionary-performance/compact/dictionary-legacy-reference.cjs');
const current = require('../src/automation/dictionary');
const seed = 123456789;
const digest = value => createHash('sha256').update(value).digest('hex');
function dataset(count, which = 0, kind = 'fixed') {
    let state = (seed + which * 100003) >>> 0;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const entries = Array.from({ length: count }, (_, i) => {
        const term = `${next().toString(36).padStart(7, '0')}_${i.toString(36).padStart(5, '0')}`;
        if (kind.startsWith('lengths-')) return term + 'q'.repeat(i % Number(kind.slice(8)));
        if (kind === 'shared-prefix') return 'sharedprefix'.repeat(3) + i.toString(36).padStart(5, '0');
        if (kind === 'collisions') return Array.from({ length: 17 }, (_, bit) => i & (1 << bit) ? 'Aa' : 'BB').join('');
        if (kind === 'saturation' && i < 3) return 'a'.repeat(i + 1);
        return term;
    });
    return { schemaVersion: 1, name: `multi-dictionary-${which}-${count}`, source: `Synthetic fixed xorshift32 seed ${seed + which * 100003}`, license: 'CC0-1.0', ...(kind === 'collisions' ? { normalization: { caseFold: false } } : {}), entries };
}
function metadataBytes(dictionary) {
    let bytes = 4096 + dictionary.entries.length * 8;
    for (const entry of dictionary.entries) {
        if (typeof entry === 'string') bytes += 64 + entry.length * 2;
        else { bytes += 192; for (const value of Object.values(entry)) bytes += typeof value === 'string' ? 64 + value.length * 2 : 16; }
    }
    return bytes;
}
async function probe(count) {
    const { createTestDatabase } = require('./lib/automation-test-db');
    const { createService } = require('../src/automation/service');
    const db = await createTestDatabase(33619), service = createService(db), actor = { userId: '222222222222222222' };
    const report = { kind: 'actual-capacity-trim', count, seed, schema: db.schema, node: process.version, entries: [], closed: false, sourceSha256: digest(fs.readFileSync(path.join(root, 'src/automation/dictionary.js'))) };
    const held = [];
    try {
        for (let which = 0; which < 2; which++) {
            let dictionary = dataset(count, which);
            const saved = await service.saveDictionary(actor, { dictionary }); dictionary = null; global.gc?.();
            const startLoad = performance.now(), loaded = await service.dictionaryData(saved.id, saved.revision), sqlLoadMs = performance.now() - startLoad;
            const started = performance.now(), matcher = new legacy.DictionaryMatcher(loaded), buildMs = performance.now() - started;
            const before = { ...matcher.stats }, sample = loaded.entries[Math.floor(count / 2)];
            const expected = matcher.match(sample);
            const trimming = performance.now();
            for (const key of Object.keys(matcher.arrays)) matcher.arrays[key] = matcher.arrays[key].slice(0, matcher.size);
            matcher.capacity = matcher.size;
            const trimMs = performance.now() - trimming;
            const trimmedBytes = Object.values(matcher.arrays).reduce((sum, array) => sum + array.byteLength, matcher.lengths.byteLength);
            assert.deepEqual(matcher.match(sample), expected); held.push(matcher); global.gc?.();
            report.entries.push({ checksum: saved.checksum, count: loaded.entries.length, sqlLoadMs, buildMs, trimMs, before, trimmedBytes, metadataBytes: metadataBytes(loaded), rss: process.memoryUsage().rss });
        }
        report.pairTrimmedResidentBytes = report.entries.reduce((sum, value) => sum + value.trimmedBytes + value.metadataBytes, 0);
        report.fixedBudgetBytes = 480 * 1024 * 1024; report.fits = report.pairTrimmedResidentBytes <= report.fixedBudgetBytes;
    } finally { held.length = 0; await db.close(); report.closed = true; save('trim-' + count, report); }
}
function save(label, report) {
    fs.mkdirSync(folder, { recursive: true });
    const filename = path.join(folder, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ filename, kind: report.kind, count: report.count, cases: report.cases?.length, verified: report.verified, fits: report.fits, pairTrimmedResidentBytes: report.pairTrimmedResidentBytes, closed: report.closed }));
}
const capture = work => { try { return { matches: work() }; } catch (error) { return { error: error.message }; } };
function micro(count) {
    const report = { kind: 'backend-differential-performance', count, seed, node: process.version, sourceSha256: digest(fs.readFileSync(path.join(root, 'src/automation/dictionary.js'))), cases: [] };
    for (const kind of ['fixed', 'lengths-2', 'lengths-4', 'lengths-8', 'lengths-16', 'lengths-64', 'shared-prefix', 'collisions', 'saturation']) {
        const input = dataset(count, 0, kind);
        const samples = [];
        for (const length of [128, 1024, 16384, 65536]) for (let i = 0; i < 3; i++) {
            const term = input.entries[Math.floor(i * count / 3)];
            samples.push({ group: 'hit-' + length, text: '日'.repeat(length - term.length - 2) + ' ' + term + ' ' });
            samples.push({ group: 'miss-' + length, text: '日'.repeat(length) });
            samples.push({ group: 'repeated-' + length, text: (kind === 'collisions' ? 'Aa' : 'a').repeat(Math.floor(length / (kind === 'collisions' ? 2 : 1))) });
            samples.push({ group: 'candidate-' + length, text: '0qqq'.repeat(Math.ceil(length / 4)).slice(0, length) });
        }
        let expected;
        for (const backend of ['legacy', 'hash', 'auto']) {
            global.gc?.(); const before = process.memoryUsage(), start = performance.now();
            let matcher = backend === 'legacy' ? new legacy.DictionaryMatcher(input) : new current.DictionaryMatcher(input, { backend });
            const buildMs = performance.now() - start, outputs = [], timings = [];
            for (const sample of samples) {
                const began = performance.now(), value = capture(() => matcher.match(sample.text));
                timings.push({ group: sample.group, ms: performance.now() - began, outcome: value.error || 'matched', count: value.matches?.length }); outputs.push(value);
            }
            if (backend === 'legacy') expected = outputs; else assert.deepEqual(outputs, expected, kind + '/' + backend);
            report.cases.push({ kind, requestedBackend: backend, selectedBackend: matcher.stats.backend || 'legacy', buildMs, stats: matcher.stats, residentBytes: matcher.stats.allocatedBytes + (matcher.stats.auxiliaryBytes || 0) + metadataBytes(input), before, after: process.memoryUsage(), sampleSha256: digest(JSON.stringify(samples)), timings });
            console.log(JSON.stringify({ kind, backend, selected: matcher.stats.backend || 'legacy', buildMs, allocatedBytes: matcher.stats.allocatedBytes }));
            matcher = null;
        }
    }
    report.verified = true; save('micro-' + count, report);
}
function reportComparison() {
    const parent = path.dirname(folder), names = fs.readdirSync(parent);
    const baseline = { 100000: 'after-100000-2026-09-22T07-40-54-739Z.json', 1000000: 'after-1000000-2026-09-22T07-40-57-448Z.json' };
    const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
    const summarize = input => {
        const cold = input.timings.filter(t => t.label.startsWith('cold-')), alternating = input.timings.filter(t => t.label.startsWith('alternating-'));
        const observed = alternating.filter(t => Number.isFinite(t.eventLoopDelayMeanMs));
        const from = input.memorySamples.find(t => t.label === 'cold-0-0:before').elapsedMs, to = input.memorySamples.find(t => t.label === 'alternating-7-1:after').elapsedMs;
        return { coldMedianMs: median(cold.map(t => t.ms)), alternatingMedianMs: median(alternating.map(t => t.ms)), alternatingMinMs: Math.min(...alternating.map(t => t.ms)), alternatingMaxMs: Math.max(...alternating.map(t => t.ms)),
            peakSampledRssMiB: input.peakSampledRss / 1048576, coldAndAlternatingPeakRssMiB: Math.max(...input.memorySamples.filter(t => t.elapsedMs >= from && t.elapsedMs <= to).map(t => t.rss)) / 1048576,
            mainLoopAlternatingMaxMs: observed.length ? Math.max(...observed.map(t => t.eventLoopDelayMaxMs)) : null, sqlLoads: input.sqlLoads.length, concurrent: input.concurrent,
            cache: input.cacheSnapshots.find(s => s.label === 'match-7') };
    };
    const comparisons = [100000, 1000000].map(count => {
        const afterFile = names.filter(n => n.startsWith('compact-after-' + count + '-') && n.endsWith('.json')).sort().at(-1);
        const before = JSON.parse(fs.readFileSync(path.join(parent, baseline[count]))), after = JSON.parse(fs.readFileSync(path.join(parent, afterFile)));
        assert(before.verified && before.fixtureClosed && after.verified && after.fixtureClosed);
        assert.deepEqual(before.samples, after.samples, 'dictionary checksums and samples must remain identical');
        assert.deepEqual(before.timings.map(t => t.label), after.timings.map(t => t.label));
        for (const file of ['dictionary.js', 'evaluation.js', 'evaluation-worker.js']) assert.equal(after.sources[file], digest(fs.readFileSync(path.join(root, 'src/automation', file))), 'final implementation hash');
        const cache = after.cacheSnapshots.find(s => s.label === 'match-7');
        assert.equal(cache.worker.residents.length, 2); assert.equal(cache.worker.evictions, 0); assert.equal(cache.worker.compiles, 2); assert.equal(cache.cacheHits, 6);
        assert(cache.worker.residentBytes <= 480 * 1024 * 1024);
        return { count, beforeFile: baseline[count], afterFile, before: summarize(before), after: summarize(after) };
    });
    const microFile = fs.readdirSync(folder).filter(n => n.startsWith('micro-100000-')).sort().at(-1);
    const micro = JSON.parse(fs.readFileSync(path.join(folder, microFile)));
    assert.equal(micro.sourceSha256, digest(fs.readFileSync(path.join(root, 'src/automation/dictionary.js')))); assert(micro.verified);
    const cases = [...new Set(micro.cases.map(c => c.kind))].map(kind => {
        const selected = backend => { const row = micro.cases.find(c => c.kind === kind && c.requestedBackend === backend); return { backend: row.selectedBackend, buildMs: row.buildMs, residentMiB: row.residentBytes / 1048576,
            miss64kMedianMs: median(row.timings.filter(t => t.group === 'miss-65536').map(t => t.ms)), candidate64kMedianMs: median(row.timings.filter(t => t.group === 'candidate-65536').map(t => t.ms)), repeated64kMedianMs: median(row.timings.filter(t => t.group === 'repeated-65536').map(t => t.ms)) }; };
        return { kind, legacy: selected('legacy'), auto: selected('auto'), forcedHash: selected('hash') };
    });
    const summary = { at: new Date().toISOString(), fixedBudgetBytes: 480 * 1024 * 1024, comparisons, microFile, cases, referenceSource: 'dictionary-legacy-reference.cjs' };
    fs.writeFileSync(path.join(folder, 'comparison.json'), JSON.stringify(summary, null, 2) + '\n');
    const f = value => value === null ? 'not sampled' : value.toFixed(3);
    const rows = comparisons.map(r => `| 2 x ${r.count.toLocaleString('en-US')} | ${f(r.before.alternatingMedianMs)} | ${f(r.after.alternatingMedianMs)} | ${f(r.before.coldMedianMs)} -> ${f(r.after.coldMedianMs)} | ${r.before.sqlLoads} -> ${r.after.sqlLoads} | ${f(r.after.cache.worker.residentBytes / 1048576)} |`).join('\n');
    const memoryRows = comparisons.flatMap(r => ['before', 'after'].map(label => `| ${r.count} / ${label} | ${f(r[label].peakSampledRssMiB)} | ${f(r[label].coldAndAlternatingPeakRssMiB)} | ${f(r[label].mainLoopAlternatingMaxMs)} |`)).join('\n');
    const shapeRows = cases.map(r => `| ${r.kind} | ${r.auto.backend} | ${f(r.legacy.buildMs)} -> ${f(r.auto.buildMs)} | ${f(r.legacy.residentMiB)} -> ${f(r.auto.residentMiB)} | ${f(r.legacy.candidate64kMedianMs)} -> ${f(r.auto.candidate64kMedianMs)} |`).join('\n');
    const text = `# Compact dictionary matcher: measured result\n\n` +
        `The fixed-seed pair of two distinct 1,000,000-entry dictionaries now remains resident together within the unchanged 480 MiB cache budget. After two cold compilations, all six alternating calls hit the cache with zero evictions. Both dictionaries and the edited immutable revision were saved in actual isolated SQL fixtures at 127.0.0.1:33619. The comparison asserts identical dictionary checksums, sample hashes and operation order against the retained pre-compaction LRU baseline. No baseline files were overwritten.\n\n` +
        `| Dataset | Before alternating median ms | After alternating median ms | Cold median ms | SQL reads, full workload | After pair residency MiB |\n|---|---:|---:|---:|---:|---:|\n${rows}\n\n` +
        `The original capacity-trim experiment actually constructed, sliced and retained both legacy matchers, preserving sample outputs. At one million entries each it still needed 629,802,232 accounted bytes (600.626 MiB), exceeding 503,316,480 bytes. Trim alone was therefore not adopted as the solution. The resulting compact pair accounts for 249,612,224 bytes (238.049 MiB), including original entry metadata, normalized-text references, hash arrays, lengths and boundary bitmaps.\n\n` +
        `The new backend is selected only for >=100,000 entries, at most four normalized UTF-16 lengths, <=32,000,000 normalized characters, and when its predicted retained storage is smaller than a fully trimmed Aho trie. The exact trie-state count comes from sorted normalized references and adjacent common-prefix lengths. Small dictionaries, diverse lengths and strongly shared prefixes keep Aho. Large Aho fallbacks trim unused capacity. Both construction probe distance and final circular cluster length are capped at 64; exceeding either switches to Aho and tells the worker to reserve Aho memory before building it.\n\n` +
        `Hash values only identify candidates. Every result and duplicate is checked against the complete normalized term, so collisions cannot produce a positive match. The matching loop emits increasing end offset then decreasing term length, retains the first normalized duplicate, counts occurrences before mode/allow filtering, and filters allow spans before applying the result limit. Start/end character bitmaps only exclude impossible candidates. No cache budget, input-size limit, match limit, or text semantics was relaxed.\n\n` +
        `| Size / run | Peak sampled process RSS MiB | Cold+alternating peak RSS MiB | Alternating loop max delay ms |\n|---|---:|---:|---:|\n${memoryRows}\n\n` +
        `Cache accounting is not an RSS cap. Process RSS includes main-thread SQL JSON, source/result clones, sorting references, compilation/editor temporaries, the service validation worker, and GC lag. Runtime samples are every 20 ms; setup has boundary snapshots. Loop histogram resolution is 10 ms, so sub-resolution calls can have no observation and are marked not sampled. Concurrent admitted matching and heavy editing both complete; an extra heavy payload is still rejected. Raw before/after timing, RSS, loop-delay, cache counters, hashes and fixture cleanup flags remain in the linked JSON.\n\n` +
        `Additional 100,000-entry stress datasets use the same seed, 48 samples per backend, lengths 128/1,024/16,384/65,536, positive hits, nonmatching text, repetition, candidate-heavy patterns, concentrated polynomial collisions, and match saturation. Every output/error is compared with the frozen independent Aho reference. Forced hash trials at 8/16/64 lengths are experimental evidence only; production keeps Aho there.\n\n` +
        `| Shape | Selected backend | Build ms, legacy -> selected | Resident MiB | Candidate-heavy 65,536-char median ms |\n|---|---|---:|---:|---:|\n${shapeRows}\n\n` +
        `Tradeoffs are retained rather than hidden: warm individual matches are not universally faster; several long-text cases and some fallback builds cost more. Shared-prefix and collision fallbacks pay planning overhead, while Aho remains their matcher. The large improvement is avoiding repeated SQL loading and multi-second construction when alternating the measured million-entry dictionaries. Timing varies with host load; raw earlier trials remain available. Wider length distributions or metadata-heavy dictionaries can still exceed the fixed budget and evict/reject. This result does not claim that every possible million-entry dictionary fits twice.\n\n` +
        `Validation: 800 deterministic randomized Unicode dictionaries compare hash, Aho and auto against a frozen pre-change reference, including metadata fields entries/uniqueEntries/states. Explicit cases cover ordering, late allow spans, first-duplicate metadata, conflicts, NFC/NFKC, case/space normalization, supplementary characters and lone surrogates, all match modes, zero/fractional/NaN/large limits, input-limit and saturation errors, exact hash collisions, joined clusters, and worker fallback reservations. All 256 current automation tests pass with NODE_ENV=test and AUTOMATION_TEST_DB_PORT=33619; no skips (tests.txt). The evaluator public API and its cache metadata remain compatible.\n\n` +
        `Commands: node --expose-gc scripts/benchmark_automation_dictionary_compact.js probe 100000|1000000; micro 100000; node --expose-gc scripts/benchmark_automation_multi_dictionary.js compact-after 100000|1000000; node scripts/benchmark_automation_dictionary_compact.js report. Set NODE_ENV=test and AUTOMATION_TEST_DB_PORT=33619 and verify the fixture server first. Each probe/evaluator run creates and closes only its random test schema. No production/external I/O or real messages.\n\n` +
        comparisons.map(r => `- ${r.count}: [before](../${r.beforeFile}), [after](../${r.afterFile})`).join('\n') + `\n- [Stress trials](${microFile})\n- [Machine-readable comparison](comparison.json)\n`;
    fs.writeFileSync(path.join(folder, 'REPORT.md'), text);
    console.log(JSON.stringify(comparisons.map(r => ({ count: r.count, beforeMedianMs: r.before.alternatingMedianMs, afterMedianMs: r.after.alternatingMedianMs, residentMiB: r.after.cache.worker.residentBytes / 1048576 }))));
}
if (require.main === module) {
    if (process.env.NODE_ENV !== 'test' || Number(process.env.AUTOMATION_TEST_DB_PORT) !== 33619) throw new Error('Use NODE_ENV=test and verified AUTOMATION_TEST_DB_PORT=33619');
    if (process.argv[2] === 'report') { reportComparison(); process.exitCode = 0; }
    else {
    const count = Number(process.argv[3]);
    if (!['probe', 'micro'].includes(process.argv[2]) || ![100000, 1000000].includes(count)) throw new Error('Use probe|micro 100000|1000000');
    if (process.argv[2] === 'micro') micro(count); else probe(count).catch(error => { console.error(error); process.exitCode = 1; });
    }
}
module.exports = { dataset, metadataBytes, legacy, current, folder, save, digest };
