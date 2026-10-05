'use strict';

// Compact adjacency-list Aho-Corasick automaton. Six typed arrays replace a
// Map/object per character; a million-entry dictionary is compiled once and
// shared by version, never duplicated for every subscription.
const MAX_ENTRIES = 1000000;
const MAX_CHARS = 32000000;
const HASH_MIN_ENTRIES = 100000;
const HASH_MAX_LENGTHS = 4;
const HASH_MAX_PROBES = 64;
const MODES = new Set(['contains', 'exact', 'word', 'prefix', 'suffix']);
const wordChar = value => !!value && /[\p{L}\p{M}\p{N}_]/u.test(value);
const before = (text, index) => index > 1 && /[\uDC00-\uDFFF]/.test(text[index - 1]) && /[\uD800-\uDBFF]/.test(text[index - 2]) ? text.slice(index - 2, index) : text[index - 1];
const after = (text, index) => index < text.length ? String.fromCodePoint(text.codePointAt(index)) : '';

function normalize(text, options = {}) {
    let value = String(text).normalize(options.form === 'NFC' ? 'NFC' : 'NFKC');
    if (options.caseFold !== false) value = value.toLowerCase();
    if (options.spaces === 'collapse') value = value.replace(/\s+/gu, ' ');
    if (options.spaces === 'remove') value = value.replace(/\s/gu, '');
    return value;
}
function validateDictionary(input) {
    if (!input || input.schemaVersion !== 1 || typeof input.name !== 'string' || input.name.length > 120 || !input.name.trim()) throw new Error('DICTIONARY_INVALID_NAME_OR_VERSION');
    if (Object.keys(input).some(k => !['schemaVersion', 'name', 'mode', 'normalization', 'entries', 'source', 'license'].includes(k))) throw new Error('DICTIONARY_UNKNOWN_FIELD');
    for (const key of ['source', 'license']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 8000)) throw new Error('DICTIONARY_INVALID_ATTRIBUTION');
    if (!Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) throw new Error('DICTIONARY_ENTRY_LIMIT');
    if (input.mode !== undefined && !MODES.has(input.mode)) throw new Error('DICTIONARY_INVALID_MODE');
    if (input.normalization !== undefined && (!input.normalization || typeof input.normalization !== 'object' || Array.isArray(input.normalization) || Object.keys(input.normalization).some(k => !['form', 'caseFold', 'spaces'].includes(k)) || !['NFC', 'NFKC', undefined].includes(input.normalization.form) || ![true, false, undefined].includes(input.normalization.caseFold) || !['preserve', 'collapse', 'remove', undefined].includes(input.normalization.spaces))) throw new Error('DICTIONARY_INVALID_NORMALIZATION');
    let characters = 0;
    for (const item of input.entries) {
        const term = typeof item === 'string' ? item : item?.term;
        if (typeof term !== 'string' || !term.trim() || term.length > 255) throw new Error('DICTIONARY_INVALID_TERM');
        characters += term.length;
        if (characters > MAX_CHARS) throw new Error('DICTIONARY_CHARACTER_LIMIT');
        if (typeof item === 'object') {
            if (Object.keys(item).some(k => !['term', 'kind', 'mode', 'category', 'severity', 'replacement'].includes(k))) throw new Error('DICTIONARY_UNKNOWN_FIELD');
            if (item.kind && !['deny', 'allow'].includes(item.kind) || item.mode && !MODES.has(item.mode)) throw new Error('DICTIONARY_INVALID_ENTRY');
            if (item.category !== undefined && (typeof item.category !== 'string' || item.category.length > 80)) throw new Error('DICTIONARY_INVALID_CATEGORY');
            if (item.replacement !== undefined && (typeof item.replacement !== 'string' || item.replacement.length > 2048)) throw new Error('DICTIONARY_INVALID_REPLACEMENT');
            if (item.severity !== undefined && (!Number.isInteger(item.severity) || item.severity < 0 || item.severity > 5)) throw new Error('DICTIONARY_INVALID_SEVERITY');
        }
    }
    return input;
}

const termOf = entry => typeof entry === 'string' ? entry : entry.term;
const capacityFor = count => Math.max(1024, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
function hashTerm(term) {
    let value = 0;
    for (let i = 0; i < term.length; i++) value = (Math.imul(value, 31) + term.charCodeAt(i)) >>> 0;
    return value;
}
function hashSlot(value) {
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    return (value ^ (value >>> 15)) >>> 0;
}
function checkDuplicate(prior, entry, mode) {
    const a = typeof prior === 'string' ? { term: prior } : prior, b = typeof entry === 'string' ? { term: entry } : entry;
    if ((a.kind || 'deny') !== (b.kind || 'deny') || (a.mode || mode) !== (b.mode || mode)) throw new Error('DICTIONARY_CONFLICTING_DUPLICATE');
}

// Planning also supplies the worker's pre-build reservation. Sorting references
// gives the exact trie-state count, so highly shared prefixes keep compact Aho
// storage instead of being guessed to need a large hash table.
function planDictionary(input, backend = 'auto') {
    validateDictionary(input);
    if (!['auto', 'aho', 'hash'].includes(backend)) throw new Error('DICTIONARY_BACKEND');
    const candidate = backend !== 'aho' && (backend === 'hash' || input.entries.length >= HASH_MIN_ENTRIES);
    const normalized = candidate ? [] : null, lengths = new Set();
    let characters = 0, extraTextBytes = 0;
    for (const entry of input.entries) {
        const raw = termOf(entry), term = normalize(raw, input.normalization);
        characters += term.length;
        if (candidate) { normalized.push(term); lengths.add(term.length); if (term !== raw) extraTextBytes += 64 + term.length * 2; }
    }
    const aho = { backend: 'aho', upperAllocatedBytes: 24 * capacityFor(characters + 1) + input.entries.length * 2, auxiliaryBytes: 0 };
    if (!candidate || characters > MAX_CHARS || backend === 'auto' && lengths.size > HASH_MAX_LENGTHS) return aho;
    const ordered = normalized.slice().sort();
    let states = 1, previous = '';
    for (const term of ordered) {
        let shared = 0;
        while (shared < term.length && shared < previous.length && term.charCodeAt(shared) === previous.charCodeAt(shared)) shared++;
        states += term.length - shared; previous = term;
    }
    const tableCapacity = capacityFor(input.entries.length * 2);
    const auxiliaryBytes = 192 + input.entries.length * 8 + extraTextBytes + lengths.size * 32;
    const upperAllocatedBytes = tableCapacity * 8 + input.entries.length * 2 + (1 + lengths.size * 2) * 8192;
    if (backend === 'auto' && upperAllocatedBytes + auxiliaryBytes >= 24 * states + input.entries.length * 2) return aho;
    return { backend: 'hash', normalized, lengths: [...lengths].sort((a, b) => b - a), states, tableCapacity, auxiliaryBytes, upperAllocatedBytes, fallback: aho };
}

class DictionaryMatcher {
    constructor(input, options = {}) {
        validateDictionary(input);
        this.options = input.normalization || {};
        this.mode = input.mode || 'contains';
        this.entries = input.entries;
        const plan = options.plan || planDictionary(input, options.backend);
        if (plan.backend === 'hash') {
            if (this.buildHash(plan)) return;
            options.onFallback?.(plan.fallback);
        }
        this.backend = 'aho';
        this.size = 1;
        this.capacity = 1024;
        this.arrays = Object.fromEntries(['head', 'next', 'code', 'fail', 'terminal', 'output'].map(k => [k, new Uint32Array(this.capacity)]));
        this.roots = new Map();
        this.lengths = new Uint16Array(input.entries.length);
        let duplicates = 0;
        for (let i = 0; i < input.entries.length; i++) {
            const entry = input.entries[i];
            const term = normalize(typeof entry === 'string' ? entry : entry.term, this.options);
            if (!term) throw new Error('DICTIONARY_EMPTY_NORMALIZED_TERM');
            this.lengths[i] = term.length;
            let state = 0;
            for (let c = 0; c < term.length; c++) {
                const code = term.charCodeAt(c);
                let child = this.child(state, code);
                if (!child) {
                    child = this.add();
                    this.arrays.code[child] = code;
                    this.arrays.next[child] = this.arrays.head[state];
                    this.arrays.head[state] = child;
                    if (state === 0) this.roots.set(code, child);
                }
                state = child;
            }
            if (this.arrays.terminal[state]) {
                const prior = this.entries[this.arrays.terminal[state] - 1];
                // A normalized duplicate with different behavior is ambiguous:
                // require the importer to resolve it, never silently overwrite.
                const a = typeof prior === 'string' ? { term: prior } : prior;
                const b = typeof entry === 'string' ? { term: entry } : entry;
                if ((a.kind || 'deny') !== (b.kind || 'deny') || (a.mode || this.mode) !== (b.mode || this.mode)) throw new Error('DICTIONARY_CONFLICTING_DUPLICATE');
                duplicates++;
            } else this.arrays.terminal[state] = i + 1;
        }
        const queue = new Uint32Array(this.size);
        let read = 0, write = 0;
        for (const value of this.roots.values()) queue[write++] = value;
        while (read < write) {
            const state = queue[read++];
            for (let edge = this.arrays.head[state]; edge; edge = this.arrays.next[edge]) {
                queue[write++] = edge;
                let fallback = this.arrays.fail[state];
                while (fallback && !this.child(fallback, this.arrays.code[edge])) fallback = this.arrays.fail[fallback];
                this.arrays.fail[edge] = this.child(fallback, this.arrays.code[edge]);
                const parent = this.arrays.fail[edge];
                this.arrays.output[edge] = this.arrays.terminal[parent] ? parent : this.arrays.output[parent];
            }
        }
        if (input.entries.length >= HASH_MIN_ENTRIES) {
            for (const name of Object.keys(this.arrays)) this.arrays[name] = this.arrays[name].slice(0, this.size);
            this.capacity = this.size;
        }
        this.stats = { backend: 'aho', fallbackReason: this.hashFallback || null, auxiliaryBytes: 0, entries: input.entries.length, uniqueEntries: input.entries.length - duplicates, states: this.size,
            allocatedBytes: Object.values(this.arrays).reduce((total, array) => total + array.byteLength, 0) + this.lengths.byteLength };
    }
    buildHash(plan) {
        const slots = new Uint32Array(plan.tableCapacity), hashes = new Uint32Array(plan.tableCapacity), mask = plan.tableCapacity - 1;
        const lengths = new Uint16Array(this.entries.length);
        const boundaries = new Uint8Array((1 + plan.lengths.length * 2) * 8192);
        let duplicates = 0;
        for (let i = 0; i < this.entries.length; i++) {
            const term = plan.normalized[i];
            if (!term) throw new Error('DICTIONARY_EMPTY_NORMALIZED_TERM');
            lengths[i] = term.length;
            const group = plan.lengths.indexOf(term.length), first = term.charCodeAt(0), last = term.charCodeAt(term.length - 1);
            boundaries[last >>> 3] |= 1 << (last & 7);
            boundaries[(group + 1) * 8192 + (last >>> 3)] |= 1 << (last & 7);
            boundaries[(group + 1 + plan.lengths.length) * 8192 + (first >>> 3)] |= 1 << (first & 7);
            const hash = hashTerm(term);
            let slot = hashSlot(hash) & mask, probes = 0;
            while (slots[slot]) {
                const prior = slots[slot] - 1;
                // Hash equality is only a candidate; original normalized text
                // is always compared, including for duplicate resolution.
                if (hashes[slot] === hash && plan.normalized[prior] === term) { checkDuplicate(this.entries[prior], this.entries[i], this.mode); duplicates++; break; }
                if (++probes >= HASH_MAX_PROBES) { this.hashFallback = 'probe-limit'; return false; }
                slot = (slot + 1) & mask;
            }
            if (!slots[slot]) { slots[slot] = i + 1; hashes[slot] = hash; }
        }
        // An unsuccessful query can traverse a cluster longer than any single
        // insertion did (separate clusters can become joined). Bound that path
        // too, including a cluster wrapping around the end of the table.
        let run = 0, firstRun = 0;
        while (firstRun < slots.length && slots[firstRun]) firstRun++;
        for (const value of slots) {
            run = value ? run + 1 : 0;
            if (run > HASH_MAX_PROBES) { this.hashFallback = 'cluster-limit'; return false; }
        }
        if (run + firstRun > HASH_MAX_PROBES) { this.hashFallback = 'cluster-limit'; return false; }
        this.backend = 'hash'; this.hashSlots = slots; this.hashValues = hashes; this.hashMask = mask;
        this.hashTexts = plan.normalized; this.lengths = lengths; this.hashLengths = plan.lengths; this.hashBoundaries = boundaries;
        this.hashPowers = plan.lengths.map(length => { let power = 1; for (let i = 0; i < length; i++) power = Math.imul(power, 31) >>> 0; return power; });
        this.stats = { backend: 'hash', fallbackReason: null, entries: this.entries.length, uniqueEntries: this.entries.length - duplicates, states: plan.states, lengthPartitions: plan.lengths.length,
            auxiliaryBytes: plan.auxiliaryBytes, allocatedBytes: slots.byteLength + hashes.byteLength + lengths.byteLength + boundaries.byteLength };
        return true;
    }
    add() {
        if (this.size === this.capacity) {
            if (this.capacity >= MAX_CHARS * 2) throw new Error('DICTIONARY_COMPILE_LIMIT');
            this.capacity *= 2;
            for (const name of Object.keys(this.arrays)) {
                const grown = new Uint32Array(this.capacity);
                grown.set(this.arrays[name]); this.arrays[name] = grown;
            }
        }
        return this.size++;
    }
    child(state, code) {
        if (!state) return this.roots.get(code) || 0;
        for (let edge = this.arrays.head[state]; edge; edge = this.arrays.next[edge]) if (this.arrays.code[edge] === code) return edge;
        return 0;
    }
    match(input, limit = 20) {
        if (typeof input !== 'string' || input.length > 65536) throw new Error('DICTIONARY_INPUT_LIMIT');
        const text = normalize(input, this.options), deny = [], allow = [];
        if (this.backend === 'hash') return this.matchHash(text, limit);
        let state = 0, total = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            while (state && !this.child(state, code)) state = this.arrays.fail[state];
            state = this.child(state, code);
            let terminal = this.arrays.terminal[state] ? state : this.arrays.output[state];
            while (terminal) {
                if (++total > 100000) throw new Error('DICTIONARY_MATCH_LIMIT');
                const index = this.arrays.terminal[terminal] - 1, raw = this.entries[index];
                const item = typeof raw === 'string' ? { term: raw } : raw;
                const start = i + 1 - this.lengths[index], end = i + 1;
                const mode = item.mode || this.mode;
                const eligible = mode === 'contains' || mode === 'exact' && start === 0 && end === text.length
                    || mode === 'prefix' && start === 0 || mode === 'suffix' && end === text.length
                    || mode === 'word' && !wordChar(before(text, start)) && !wordChar(after(text, end));
                if (eligible) (item.kind === 'allow' ? allow : deny).push({ term: item.term, start, end, category: item.category || null });
                terminal = this.arrays.output[terminal];
            }
        }
        // Exceptions suppress only contained spans, not unrelated prohibited
        // words elsewhere in the same post. Offsets refer to normalized text.
        return deny.filter(d => !allow.some(a => a.start <= d.start && a.end >= d.end)).slice(0, Math.min(1000, Math.max(0, limit)));
    }
    matchHash(text, limit) {
        const prefix = new Uint32Array(text.length + 1), deny = [], allow = [];
        for (let i = 0; i < text.length; i++) prefix[i + 1] = (Math.imul(prefix[i], 31) + text.charCodeAt(i)) >>> 0;
        let total = 0;
        // Aho emits by increasing end offset and then decreasing term length.
        // Count every exact normalized occurrence before mode/allow filtering,
        // even when the requested result limit is zero or was already reached.
        for (let end = 1; end <= text.length; end++) {
            const last = text.charCodeAt(end - 1);
            if (!(this.hashBoundaries[last >>> 3] & (1 << (last & 7)))) continue;
            for (let group = 0; group < this.hashLengths.length; group++) {
                const length = this.hashLengths[group], start = end - length;
                if (start < 0) continue;
                const first = text.charCodeAt(start);
                if (!(this.hashBoundaries[(group + 1) * 8192 + (last >>> 3)] & (1 << (last & 7)))
                    || !(this.hashBoundaries[(group + 1 + this.hashLengths.length) * 8192 + (first >>> 3)] & (1 << (first & 7)))) continue;
                const hash = (prefix[end] - Math.imul(prefix[start], this.hashPowers[group])) >>> 0;
                let slot = hashSlot(hash) & this.hashMask;
                while (this.hashSlots[slot]) {
                    const index = this.hashSlots[slot] - 1;
                    if (this.hashValues[slot] === hash && this.lengths[index] === length && text.startsWith(this.hashTexts[index], start)) {
                        if (++total > 100000) throw new Error('DICTIONARY_MATCH_LIMIT');
                        const raw = this.entries[index], item = typeof raw === 'string' ? { term: raw } : raw, mode = item.mode || this.mode;
                        const eligible = mode === 'contains' || mode === 'exact' && start === 0 && end === text.length
                            || mode === 'prefix' && start === 0 || mode === 'suffix' && end === text.length
                            || mode === 'word' && !wordChar(before(text, start)) && !wordChar(after(text, end));
                        if (eligible) (item.kind === 'allow' ? allow : deny).push({ term: item.term, start, end, category: item.category || null });
                        break;
                    }
                    slot = (slot + 1) & this.hashMask;
                }
            }
        }
        return deny.filter(d => !allow.some(a => a.start <= d.start && a.end >= d.end)).slice(0, Math.min(1000, Math.max(0, limit)));
    }
}
module.exports = { DictionaryMatcher, validateDictionary, normalize, planDictionary, MAX_ENTRIES, MAX_CHARS };
