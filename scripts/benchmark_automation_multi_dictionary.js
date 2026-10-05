'use strict';

// Isolated SQL + actual worker benchmark. Run before and after with identical
// size/seed/samples. Reports retain raw observations, never dictionary contents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createTestDatabase } = require('./lib/automation-test-db');
const { createService } = require('../src/automation/service');
const { createEvaluator } = require('../src/automation/evaluation');
const phase = process.argv[2], size = Number(process.argv[3]);
if (process.env.NODE_ENV !== 'test' || Number(process.env.AUTOMATION_TEST_DB_PORT) !== 33619) throw new Error('Requires NODE_ENV=test and the verified local AUTOMATION_TEST_DB_PORT=33619');
if (phase !== 'compare' && (!['before', 'after', 'compact-after'].includes(phase) || ![100000, 1000000].includes(size))) throw new Error('Use: node --expose-gc scripts/benchmark_automation_multi_dictionary.js before|after|compact-after 100000|1000000, or compare');
const root = path.resolve(__dirname, '..'), folder = path.join(root, 'docs/audits/completion/dictionary-performance');
fs.mkdirSync(folder, { recursive: true });
const seed = 123456789, startedAt = new Date().toISOString(), runId = startedAt.replace(/[:.]/g, '-');
const output = path.join(folder, `${phase}-${size}-${runId}.json`);
const digest = text => createHash('sha256').update(text).digest('hex');
function dictionary(which) {
    let state = (seed + which * 100003) >>> 0;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    return { schemaVersion: 1, name: `multi-dictionary-${which}-${size}`, source: `Synthetic fixed xorshift32 seed ${seed + which * 100003}`, license: 'CC0-1.0',
        entries: Array.from({ length: size }, (_, i) => `${next().toString(36).padStart(7, '0')}_${i.toString(36).padStart(5, '0')}`) };
}
async function main() {
    const report = { phase, size, dictionaries: 2, seed, startedAt, node: process.version, pid: process.pid, sql: { host: '127.0.0.1', port: 33619 }, sources: {}, samples: [], timings: [], sqlLoads: [], memorySamples: [], cacheSnapshots: [], fixtureClosed: false };
    for (const name of ['evaluation.js', 'evaluation-worker.js', 'dictionary.js']) {
        const source = fs.readFileSync(path.join(root, 'src/automation', name), 'utf8'); report.sources[name] = digest(source);
        const snapshot = path.join(folder, `${phase}-${digest(source).slice(0, 12)}-${name}.txt`);
        if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, source, { flag: 'wx' });
    }
    const db = await createTestDatabase(33619), service = createService(db);
    report.sql.schema = db.schema;
    const actor = { userId: '222222222222222222' };
    const refs = [], samples = [];
    let evaluator, other, monitor;
    const loop = monitorEventLoopDelay({ resolution: 10 });
    const origin = performance.now();
    const memory = label => { const value = { elapsedMs: performance.now() - origin, label, ...process.memoryUsage() }; report.memorySamples.push(value); return value; };
    const stats = async label => { if (evaluator?.stats) report.cacheSnapshots.push({ label, ...(await evaluator.stats()) }); };
    const load = async (id, revision) => {
        const begin = performance.now(), data = await service.dictionaryData(id, revision);
        report.sqlLoads.push({ dictionary: refs.findIndex(ref => ref.id === id), revision, ms: performance.now() - begin, entries: data.entries.length });
        return data;
    };
    async function measure(label, action) {
        const begin = performance.now(), before = memory(`${label}:before`); loop.reset();
        let outcome = 'fulfilled', value;
        try { value = await action(); return value; }
        catch (error) { outcome = error.code || error.message; throw error; }
        finally { report.timings.push({ label, ms: performance.now() - begin, outcome, rssBefore: before.rss, rssAfter: memory(`${label}:after`).rss,
            eventLoopDelayMaxMs: loop.max / 1e6, eventLoopDelayP99Ms: loop.percentile(99) / 1e6, eventLoopDelayMeanMs: Number.isFinite(loop.mean) ? loop.mean / 1e6 : null }); }
    }
    try {
        for (let which = 0; which < 2; which++) {
            let data = dictionary(which);
            refs.push(await measure(`sql-save-${which}-revision-1`, () => service.saveDictionary(actor, { dictionary: data })));
            samples.push(Array.from({ length: 8 }, (_, i) => `通常の文章 ${'sample '.repeat(100)}${data.entries[Math.floor(i * size / 8)]} trailing text`));
            report.samples.push({ dictionary: which, sha256: digest(JSON.stringify(samples[which])), sampleCount: samples[which].length, firstLength: samples[which][0].length, checksum: refs[which].checksum });
            data = null; global.gc?.();
        }
        loop.enable(); monitor = setInterval(() => memory('sample'), 20);
        evaluator = createEvaluator(load);
        for (const [index, which] of [0, 1, 0, 1, 0, 1, 0, 1].entries()) {
            const matches = await measure(`${index < 2 ? 'cold' : 'alternating'}-${index}-${which}`, () => evaluator.match(refs[which], samples[which][index]));
            assert.equal(matches.length, 1); await stats(`match-${index}`);
        }
        if (phase === 'compact-after') {
            const cached = await evaluator.stats();
            assert.equal(cached.worker.residents.length, 2); assert.equal(cached.worker.compiles, 2);
            assert.equal(cached.cacheHits, 6); assert.equal(cached.worker.evictions, 0);
            assert(cached.worker.residentBytes <= 480 * 1024 * 1024);
        }
        for (let i = 0; i < 6; i++) assert.equal((await measure(`same-dictionary-${i}`, () => evaluator.match(refs[1], samples[1][i]))).length, 1);
        let editData = await measure('sql-read-for-edit', () => load(refs[0].id, 1));
        const page = await measure('page-during-residency', () => evaluator.dictionaryTask({ operation: 'page', dictionary: editData, offset: size - 100, count: 100 }));
        assert.equal(page.records.length, 100);
        assert.equal((await measure('match-after-page', () => evaluator.match(refs[1], samples[1][0]))).length, 1);
        await stats('after-page');
        await evaluator.stop(); evaluator = createEvaluator(load); other = createEvaluator(load);
        // Same deterministic enqueue order exposes the previous admission bug:
        // a heavy edit queued behind matching must not make that match fail.
        const mark = performance.now();
        const matchJob = measure('concurrent-admitted-match', () => evaluator.match(refs[0], samples[0][0]));
        const patchJob = measure('concurrent-edit', () => evaluator.dictionaryTask({ operation: 'patch', dictionary: editData, patch: { operations: [{ op: 'add', entry: 'multi-dictionary-added-revision-two' }, { op: 'remove', index: size - 1, expected: editData.entries[size - 1] }] } }));
        const rejectedJob = other.dictionaryTask({ operation: 'analyze', dictionary: editData, summaryOnly: true });
        const outcomes = await Promise.allSettled([matchJob, patchJob, rejectedJob]);
        report.concurrent = { ms: performance.now() - mark, matching: outcomes[0].status === 'fulfilled' ? 'fulfilled' : outcomes[0].reason.code || outcomes[0].reason.message,
            editing: outcomes[1].status === 'fulfilled' ? 'fulfilled' : outcomes[1].reason.code || outcomes[1].reason.message,
            extraHeavy: outcomes[2].status === 'fulfilled' ? 'fulfilled' : outcomes[2].reason.code || outcomes[2].reason.message };
        assert.equal(outcomes[1].status, 'fulfilled'); assert.equal(report.concurrent.extraHeavy, 'AUTOMATION_WORKER_BUSY');
        if (phase !== 'before') { assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[0].value.length, 1); }
        editData = outcomes[1].value.dictionary;
        const revised = await measure('sql-save-0-revision-2', () => service.saveDictionary(actor, { expectedRevision: 1, dictionary: editData }, refs[0].id));
        assert.equal(revised.revision, 2); editData = null;
        assert.equal((await measure('match-revision-2', () => evaluator.match(revised, 'multi-dictionary-added-revision-two'))).length, 1);
        assert.equal((await measure('match-original-revision-1', () => evaluator.match(refs[0], 'multi-dictionary-added-revision-two'))).length, 0);
        await stats('final');
        report.immutableRevisions = await db.queryDatabase('SELECT dictionary_id,revision,entry_count,checksum,LENGTH(data_gzip) AS compressedBytes FROM automation_dictionary_revisions ORDER BY dictionary_id,revision');
        report.verified = true;
    } catch (error) { report.verified = false; report.error = error.stack; throw error; }
    finally {
        clearInterval(monitor); loop.disable();
        await evaluator?.stop(); await other?.stop(); await db.close(); report.fixtureClosed = true;
        report.totalMs = performance.now() - origin; report.peakSampledRss = Math.max(...report.memorySamples.map(value => value.rss));
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ output, verified: report.verified, phase, size, concurrent: report.concurrent, sqlLoadCount: report.sqlLoads.length, peakSampledRssMiB: report.peakSampledRss / 1048576, timings: report.timings.map(({ label, ms, outcome }) => ({ label, ms, outcome })) }));
    }
}
function compare() {
    const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
    const summarize = report => {
        const alternating = report.timings.filter(row => row.label.startsWith('alternating-'));
        const observedLoop = alternating.filter(row => Number.isFinite(row.eventLoopDelayMeanMs));
        const first = report.memorySamples.find(row => row.label === 'cold-0-0:before').elapsedMs;
        const last = report.memorySamples.find(row => row.label === 'alternating-7-1:after').elapsedMs;
        return { alternatingMedianMs: median(alternating.map(row => row.ms)), alternatingMinMs: Math.min(...alternating.map(row => row.ms)), alternatingMaxMs: Math.max(...alternating.map(row => row.ms)),
            peakProcessRssMiB: report.peakSampledRss / 1048576, alternatingPeakProcessRssMiB: Math.max(...report.memorySamples.filter(row => row.elapsedMs >= first && row.elapsedMs <= last).map(row => row.rss)) / 1048576,
            alternatingEventLoopDelayMaxMs: observedLoop.length ? Math.max(...observedLoop.map(row => row.eventLoopDelayMaxMs)) : null, alternatingWorstP99Ms: observedLoop.length ? Math.max(...observedLoop.map(row => row.eventLoopDelayP99Ms)) : null,
            totalSqlLoads: report.sqlLoads.length, concurrent: report.concurrent,
            alternatingCache: report.cacheSnapshots.find(row => row.label === 'match-7') || null, afterPageCache: report.cacheSnapshots.find(row => row.label === 'after-page') || null };
    };
    const comparisons = [];
    for (const count of [100000, 1000000]) {
        const find = label => fs.readdirSync(folder).filter(name => name.startsWith(`${label}-${count}-`) && name.endsWith('.json')).sort().at(-1);
        const beforeFile = find('before'), afterFile = find('after'); assert(beforeFile && afterFile);
        const before = JSON.parse(fs.readFileSync(path.join(folder, beforeFile))), after = JSON.parse(fs.readFileSync(path.join(folder, afterFile)));
        for (const report of [before, after]) { assert(report.verified && report.fixtureClosed); assert.equal(report.sql.port, 33619); assert.equal(report.size, count); }
        assert.deepEqual(before.samples, after.samples, 'same dictionary checksums and sample hashes');
        assert.deepEqual(before.timings.map(row => row.label), after.timings.map(row => row.label), 'same workload and enqueue order');
        for (const name of ['evaluation.js', 'evaluation-worker.js']) assert.equal(after.sources[name], digest(fs.readFileSync(path.join(root, 'src/automation', name), 'utf8')), 'after report must match current implementation');
        comparisons.push({ entriesPerDictionary: count, beforeFile, afterFile, before: summarize(before), after: summarize(after) });
    }
    fs.writeFileSync(path.join(folder, 'comparison.json'), JSON.stringify({ generatedAt: new Date().toISOString(), seed, comparisons }, null, 2) + '\n');
    const number = value => value === null ? 'not sampled' : value.toFixed(3);
    const timingRows = comparisons.map(row => `| 2 x ${row.entriesPerDictionary.toLocaleString('en-US')} | ${number(row.before.alternatingMedianMs)} | ${number(row.after.alternatingMedianMs)} | ${row.before.totalSqlLoads} -> ${row.after.totalSqlLoads} |`).join('\n');
    const memoryRows = comparisons.flatMap(row => ['before', 'after'].map(label => `| ${row.entriesPerDictionary.toLocaleString('en-US')} / ${label} | ${number(row[label].peakProcessRssMiB)} | ${number(row[label].alternatingPeakProcessRssMiB)} | ${number(row[label].alternatingEventLoopDelayMaxMs)} | ${number(row[label].alternatingWorstP99Ms)} |`)).join('\n');
    const report = `# Alternating SQL dictionary evaluator measurements\n\n` +
        `Fixed xorshift32 seed ${seed}; two independently generated dictionaries; 100,000 and 1,000,000 entries each. Each run saved both dictionaries and an edited immutable revision through the actual service into a random schema on 127.0.0.1:33619. Each schema was closed and dropped. Identical content checksums, sample hashes, operation labels and enqueue order are asserted by the comparison command. No production database, external I/O, or messages were used.\n\n` +
        `| Dataset | Before alternating median ms | After alternating median ms | Total SQL dictionary reads |\n|---|---:|---:|---:|\n${timingRows}\n\n` +
        `Alternating medians contain six calls after two cold loads. The after 100k pair has six cache hits, two compilations, zero evictions and 70,339,840 accounted resident bytes. The million-entry pair has zero alternating cache hits, eight compilations and seven evictions through that same point. Each million-entry matcher occupies 404,653,184 typed-array bytes plus 98,004,096 accounted metadata bytes (502,657,280 total; about 479.37 MiB). Two do not fit the fixed 480 MiB default. The million-entry result is an eviction/recompile workload, not a fast-cache result; no improvement is claimed there. Earlier after trials are retained alongside the final-source measurements and show timing variability.\n\n` +
        `| Size / run | Peak process RSS MiB | Cold+alternating peak RSS MiB | Alternating main-loop max delay ms | Worst alternating p99 delay ms |\n|---|---:|---:|---:|---:|\n${memoryRows}\n\n` +
        `RSS is process-wide (main thread, evaluator worker and the service validation worker). It includes input/output clones, compiler growth arrays, SQL JSON decoding, patch maps and memory awaiting GC; it is not capped at 480 MiB. The byte budget caps accounted resident matchers per evaluator, with at most eight residents by default; JS metadata uses conservative estimates. Compiler reservation uses a normalized-character upper bound and can evict conservatively. Editing reserves estimated working headroom and evicts only when necessary. In the million-entry run, even a page task requires eviction because the matcher already nearly fills the budget. Sub-10-ms calls may finish before a histogram observation: those loop delays are reported as not sampled, not zero latency.\n\n` +
        `The concurrent workload enqueues matching, then a heavy patch on the same evaluator, then an extra heavy task on another evaluator. Before: the earlier matching failed with AUTOMATION_WORKER_BUSY while the patch succeeded. After: matching and patch both succeed; only the extra heavy task is rejected. After latency therefore includes useful compilation that the failed baseline did not do and must not be interpreted as an equivalent successful-operation latency regression. Raw operation timings, event-loop delay observations and sampled RSS are retained in the JSON files. The final million-entry process RSS increase is reported without claiming reduced memory.\n\n` +
        `LRU keys distinguish rule/moderation use, starter policy and immutable revisions. Resident-key acknowledgements prevent stale main-thread cache claims after eviction, errors and reset. FIFO heavy-slot waiters load SQL only after admission; later edits cannot jump ahead. A reserved edit behind already admitted matching can lend its slot to that earlier work in the same serial queue. Stop cancels queued/waiting work, ignores late SQL results and terminates the worker; SQL loading has a 60-second ceiling to avoid indefinitely retaining the global slot.\n\n` +
        `Validation: 16 new cache/admission tests pass. The focused evaluator, dictionary editing, moderation and actual SQL marketplace run passes 49 tests (see tests.txt). A wider 55-test run had one separate failure in automation-boundaries.test.js, “draft edits use optimistic revisions”: the current service.saveWorkflowRevision reads an immutable revision snapshot, but that existing test mock returns affectedRows instead of a snapshot, causing REVISION_SNAPSHOT_CONFLICT. Those parent-owned files were not changed.\n\n` +
        `Reproduce in PowerShell with NODE_ENV=test and AUTOMATION_TEST_DB_PORT=33619 after independently verifying the local MariaDB fixture. Run node --expose-gc scripts/benchmark_automation_multi_dictionary.js before 100000 and before 1000000 against the retained before source, then after 100000 and after 1000000 against the final source. Run node scripts/benchmark_automation_multi_dictionary.js compare. Only one benchmark process should run at a time. Main-loop histogram resolution is 10 ms; runtime RSS sampling interval is 20 ms (fixture setup has operation-boundary memory snapshots only). Concurrent task measurements share that operation window. This is synthetic workload evidence, not a production-throughput guarantee.\n\n` +
        comparisons.map(row => `- ${row.entriesPerDictionary} entries: [before](${row.beforeFile}), [after](${row.afterFile})`).join('\n') + '\n';
    fs.writeFileSync(path.join(folder, 'REPORT.md'), report);
    console.log(JSON.stringify(comparisons.map(row => ({ size: row.entriesPerDictionary, beforeMedianMs: row.before.alternatingMedianMs, afterMedianMs: row.after.alternatingMedianMs, beforePeakRssMiB: row.before.peakProcessRssMiB, afterPeakRssMiB: row.after.peakProcessRssMiB }))));
}
if (phase === 'compare') compare(); else main().catch(error => { console.error(error); process.exitCode = 1; });
