'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { DictionaryMatcher, normalize, validateDictionary, planDictionary } = require('./dictionary');
const { evaluateWorkflow } = require('./engine');
const cache = new Map();
const maxCacheBytes = workerData?.maxCacheBytes || 480 * 1024 * 1024;
const maxCacheEntries = workerData?.maxCacheEntries || 8;
let residentBytes = 0, peakResidentBytes = 0;
const counters = { loads: 0, compiles: 0, compileMs: 0, matches: 0, evictions: 0, editingEvictions: 0, dictionaryTasks: 0, errors: 0 };

// Typed arrays are exact; strings/objects retained by the matcher are charged
// conservatively. This bounds cache residency, not process RSS, transient
// compiler/editor allocations, or memory waiting for garbage collection.
function metadataBytes(dictionary) {
    let bytes = 4096 + dictionary.entries.length * 8;
    for (const entry of dictionary.entries) {
        if (typeof entry === 'string') bytes += 64 + entry.length * 2;
        else {
            bytes += 192;
            for (const value of Object.values(entry)) bytes += typeof value === 'string' ? 64 + value.length * 2 : 16;
        }
    }
    return bytes;
}
function evictUntil(bytes, count = 0, editing = false) {
    while (cache.size && (residentBytes + bytes > maxCacheBytes || cache.size + count > maxCacheEntries)) {
        const key = cache.keys().next().value, entry = cache.get(key);
        cache.delete(key); residentBytes -= entry.residentBytes; counters.evictions++;
        if (editing) counters.editingEvictions++;
    }
}
function touch(key) {
    const entry = cache.get(key);
    if (entry) { cache.delete(key); cache.set(key, entry); }
    return entry;
}
function compile(key, dictionary) {
    const existing = touch(key);
    if (existing) return existing.matcher.stats;
    validateDictionary(dictionary);
    const metadata = metadataBytes(dictionary);
    const plan = planDictionary(dictionary);
    // Reserve before building. Prefix sharing may make the actual automaton
    // smaller, so an upper estimate above the budget evicts rather than rejects.
    evictUntil(plan.upperAllocatedBytes + plan.auxiliaryBytes + metadata, 1);
    const started = performance.now();
    let matcher;
    try { counters.compiles++; matcher = new DictionaryMatcher(dictionary, { plan, onFallback: fallback => evictUntil(fallback.upperAllocatedBytes + metadata, 1) }); }
    finally { counters.compileMs += performance.now() - started; }
    const bytes = matcher.stats.allocatedBytes + (matcher.stats.auxiliaryBytes || 0) + metadata;
    if (bytes > maxCacheBytes) throw new Error('DICTIONARY_WORKER_MEMORY_LIMIT');
    evictUntil(bytes, 1);
    cache.set(key, { matcher, metadataBytes: metadata, residentBytes: bytes }); residentBytes += bytes;
    peakResidentBytes = Math.max(peakResidentBytes, residentBytes);
    return matcher.stats;
}
function reserveEditing(payload) {
    let bytes = 4096 + (payload.text?.length || 0) * 2;
    for (const name of ['dictionary', 'before', 'after']) if (payload[name]?.entries) bytes += metadataBytes(payload[name]);
    // Analysis/diff/patch materialize maps and/or a result dictionary. Existing
    // immutable revisions stay valid; only memory pressure needs eviction.
    if (!['page', 'export'].includes(payload.operation)) bytes *= 3;
    evictUntil(bytes, 0, true);
}
parentPort.on('message', ({ id, operation, payload }) => {
    try {
        let result;
        if (operation === 'load') { counters.loads++; result = compile(payload.key, payload.dictionary); }
        else if (operation === 'load-moderation') {
            counters.loads++;
            const existing = touch(payload.key);
            if (existing) result = existing.matcher.stats;
            else {
                const base = payload.dictionary || { schemaVersion: 1, name: '公開審査', mode: 'word', entries: [] };
                validateDictionary(base); evictUntil(metadataBytes(base) * 3);
                const entries = new Map();
                if (payload.useStarter) for (const entry of require('./moderation').starterDictionary().entries) entries.set(normalize(entry.term, base.normalization), entry);
                for (const entry of base.entries) entries.set(normalize(typeof entry === 'string' ? entry : entry.term, base.normalization), entry);
                result = compile(payload.key, { ...base, entries: [...entries.values()] });
            }
        } else if (operation === 'match') {
            const entry = touch(payload.key);
            if (!entry) throw new Error('DICTIONARY_NOT_LOADED');
            counters.matches++; result = entry.matcher.match(payload.text, payload.limit || 20);
        } else if (operation === 'evaluate') {
            const dictionaries = Object.fromEntries(Object.entries(payload.matches || {}).map(([alias, texts]) => [alias, { match: text => texts[text] || [] }]));
            result = evaluateWorkflow(payload.workflow, payload.event, { now: payload.now, dictionaries });
        } else if (operation === 'dictionary') {
            counters.dictionaryTasks++; reserveEditing(payload);
            const formats = require('./dictionary-format');
            if (payload.operation === 'parse') result = formats.analyzeDictionary(formats.parseDictionary(payload.text, payload.format, payload.metadata), payload.deduplicate);
            else if (payload.operation === 'analyze') result = formats.analyzeDictionary(payload.dictionary, payload.deduplicate);
            else if (payload.operation === 'patch') result = formats.analyzeDictionary(formats.patchDictionary(payload.dictionary, payload.patch), payload.deduplicate);
            else if (payload.operation === 'diff') result = formats.diffDictionaries(payload.before, payload.after);
            else if (payload.operation === 'export') result = formats.exportDictionary(payload.dictionary, payload.format);
            else if (payload.operation === 'page') result = formats.dictionaryPage(payload.dictionary, payload);
            else throw new Error('DICTIONARY_OPERATION');
            if (payload.summaryOnly) result = { entryCount: result.dictionary?.entries.length, duplicateCount: result.duplicateCount, conflictCount: result.conflictCount };
        } else if (operation === 'stats') {
            result = { ...counters, residentBytes, peakResidentBytes, maxCacheBytes, maxCacheEntries, memory: process.memoryUsage(),
                residents: [...cache].map(([key, entry]) => ({ key, residentBytes: entry.residentBytes, metadataBytes: entry.metadataBytes, ...entry.matcher.stats })) };
        } else throw new Error('AUTOMATION_WORKER_OPERATION');
        parentPort.postMessage({ id, result, residentKeys: [...cache.keys()] });
    } catch (error) { counters.errors++; parentPort.postMessage({ id, error: { code: error.code || error.message, message: error.message, issues: error.issues }, residentKeys: [...cache.keys()] }); }
});
