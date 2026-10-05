'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DictionaryMatcher, planDictionary } = require('../../src/automation/dictionary');
// Frozen pre-change implementation; deliberately independent of production
// normalization, duplicate handling and matching. Keep this reference stable.
const Reference = (() => {
    'use strict';

    // Compact adjacency-list Aho-Corasick automaton. Six typed arrays replace a
    // Map/object per character; a million-entry dictionary is compiled once and
    // shared by version, never duplicated for every subscription.
    const MAX_ENTRIES = 1000000;
    const MAX_CHARS = 32000000;
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

    class DictionaryMatcher {
        constructor(input) {
            validateDictionary(input);
            this.options = input.normalization || {};
            this.mode = input.mode || 'contains';
            this.entries = input.entries;
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
            this.stats = { entries: input.entries.length, uniqueEntries: input.entries.length - duplicates, states: this.size,
                allocatedBytes: Object.values(this.arrays).reduce((total, array) => total + array.byteLength, 0) + this.lengths.byteLength };
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
    }
    return DictionaryMatcher;
})();
const seed = 123456789;
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
if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test is required');
const dictionary = (entries, settings = {}) => ({ schemaVersion: 1, name: 'differential fixture', entries, ...settings });
const outcome = work => { try { return { value: work() }; } catch (error) { return { error: error.message }; } };
function compare(input, texts, limits = [0, 1, 20, 1000, -1, 0.5, Infinity, NaN]) {
    const old = outcome(() => new Reference(input));
    for (const backend of ['hash', 'aho', 'auto']) {
        const next = outcome(() => new DictionaryMatcher(input, { backend }));
        assert.equal(next.error, old.error, `constructor ${backend}`);
        if (old.error) continue;
        for (const key of ['entries', 'uniqueEntries', 'states']) assert.equal(next.value.stats[key], old.value.stats[key], `metadata ${backend}/${key}`);
        for (const text of texts) for (const limit of limits) assert.deepEqual(outcome(() => next.value.match(text, limit)), outcome(() => old.value.match(text, limit)), `${backend} / ${JSON.stringify(text).slice(0, 120)} / limit=${limit}`);
    }
    return !old.error;
}

test('match order, overlapping suffixes and later allow spans match the frozen Aho reference', () => {
    compare(dictionary(['he', 'she', 'hers', 'ers', 's', { term: 'helicopter', kind: 'allow' }, { term: 'cat', mode: 'word' }]), ['SHE hers helicopter cat scatter', '', 'hershe']);
    compare(dictionary(['first', 'last', { term: 'first and second', kind: 'allow' }]), ['first and second last', 'first and second first last']);
    compare(dictionary(['a', 'ab', 'b', 'abc', { term: 'abcd', kind: 'allow' }]), ['abc abcd abc', 'xabcdxabc']);
});

test('first normalized duplicate supplies raw term and metadata, and conflicting duplicates fail identically', () => {
    const input = dictionary([{ term: 'ＦＯＯ', category: 'first', severity: 1, replacement: 'note' }, { term: 'foo', category: 'second', severity: 4 }]);
    compare(input, ['foo FOO ｆｏｏ']);
    const actual = new DictionaryMatcher(input, { backend: 'hash' });
    assert.equal(actual.stats.uniqueEntries, 1); assert.equal(actual.match('foo')[0].term, 'ＦＯＯ'); assert.equal(actual.match('foo')[0].category, 'first');
    compare(dictionary(['ＦＯＯ', { term: 'foo', kind: 'allow' }]), ['foo']);
    compare(dictionary([{ term: 'foo', mode: 'prefix' }, 'FOO']), ['foo']);
});

test('prefix/suffix/exact modes, contextual case folding, Unicode word boundaries and normalized offsets are unchanged', () => {
    const entries = ['ﬃ', 'İ', '𐐀', '\ud800', '\udc00', { term: 'cat', mode: 'word' }, { term: '猫', mode: 'word' }, { term: 'Σ', mode: 'word' }, { term: 'a', mode: 'prefix' }, { term: 'z', mode: 'suffix' }, { term: 'abc', mode: 'exact' }];
    for (const form of ['NFC', 'NFKC']) for (const caseFold of [true, false]) for (const spaces of ['preserve', 'collapse', 'remove']) compare(dictionary(entries, { normalization: { form, caseFold, spaces } }), [' a  cat\t猫 z ', 'abc', '𐐀cat𐐨 cat𐐀', '猫a 猫 猫\u0301', 'ΟΣ Σ σ ς', 'İ i\u0307 ﬃ ffi', '\ud800x\udc00', ' Ａ\n Ｚ ']);
});

test('match saturation counts ineligible modes and is not bypassed by zero/small output limits', () => {
    for (const mode of ['contains', 'exact', 'prefix', 'suffix', 'word']) compare(dictionary(['a', 'aa', 'aaa', 'aaaa'], { mode }), ['a'.repeat(26000)], [0, 1, 20]);
    compare(dictionary(['a']), ['a'.repeat(65537), null, 123], [0, 1]);
});

test('polynomial hash collisions require normalized-string equality and concentrated collisions fall back to Aho', () => {
    const settings = { normalization: { caseFold: false } };
    compare(dictionary(['Aa', 'BB', 'AaAa', 'BBBB'], settings), ['Aa BB AaAa BBBB AaBB BBAa']);
    const one = new DictionaryMatcher(dictionary(['Aa'], settings), { backend: 'hash' }); assert.equal(one.backend, 'hash'); assert.deepEqual(one.match('BB'), []);
    const colliding = dictionary(Array.from({ length: 128 }, (_, i) => Array.from({ length: 7 }, (_, bit) => i & 1 << bit ? 'Aa' : 'BB').join('')), settings);
    const bounded = new DictionaryMatcher(colliding, { backend: 'hash' }); assert.equal(bounded.backend, 'aho'); assert.equal(bounded.stats.fallbackReason, 'probe-limit');
    compare(colliding, [colliding.entries[0], colliding.entries[127], colliding.entries[3] + colliding.entries[65]]);
});

test('a joined probe cluster is bounded even if every individual insertion starts in an empty slot', () => {
    const bySlot = new Map();
    for (let i = 0; bySlot.size < 70 && i < 1000000; i++) {
        const term = 'cluster-' + i; let hash = 0;
        for (const char of term) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
        hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d); const slot = ((hash ^ (hash >>> 15)) >>> 0) & 1023;
        if (slot < 70 && !bySlot.has(slot)) bySlot.set(slot, term);
    }
    assert.equal(bySlot.size, 70);
    const input = dictionary([...bySlot.values()]), matcher = new DictionaryMatcher(input, { backend: 'hash' });
    assert.equal(matcher.stats.fallbackReason, 'cluster-limit');
    compare(input, [input.entries[0], input.entries.at(-1), 'no match']);
});

test('deterministic Unicode property differential: 800 dictionaries, normalized duplicates, all modes and allow exceptions', () => {
    let state = 0x2a7c31d9, compared = 0;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const alphabet = ['a', 'B', 'Ａ', 'é', 'e\u0301', '猫', '𐐀', '𐐨', '\ud800', '\udc00', '\u200b', 'ß', 'İ', 'Σ', 'ς', 'ﷺ', '¨', '_', '.', ' '];
    const pick = values => values[next() % values.length];
    const term = () => { let value = ''; for (let i = 0, n = 1 + next() % 6; i < n; i++) value += pick(alphabet); return value.trim() || 'x'; };
    const modes = ['contains', 'word', 'prefix', 'suffix', 'exact'];
    for (let iteration = 0; iteration < 800; iteration++) {
        const entries = [];
        for (let i = 0, count = 1 + next() % 40; i < count; i++) {
            if (i && next() % 7 === 0) { const prior = pick(entries); entries.push(typeof prior === 'string' ? prior : { ...prior, category: 'later duplicate' }); }
            else entries.push(next() % 3 === 0 ? term() : { term: term(), kind: next() % 4 === 0 ? 'allow' : 'deny', mode: pick(modes), category: 'category-' + next() % 3 });
        }
        const input = dictionary(entries, { mode: pick(modes), normalization: { form: pick(['NFC', 'NFKC']), caseFold: !!(next() % 2), spaces: pick(['preserve', 'collapse', 'remove']) } });
        const texts = Array.from({ length: 3 }, () => Array.from({ length: 12 }, () => { const item = pick(entries); return next() % 2 ? typeof item === 'string' ? item : item.term : term(); }).join(pick([' ', '', '\n', '  '])));
        if (compare(input, texts, [0, 1, 20, Infinity])) compared++;
    }
    assert(compared >= 500, `successful constructor comparisons: ${compared}`);
});

test('automatic backend is restricted by dictionary size, length diversity and measured trie storage benefit', () => {
    assert.equal(new DictionaryMatcher(dataset(1000)).backend, 'aho');
    const fixed = dataset(100000), compact = new DictionaryMatcher(fixed);
    assert.equal(compact.backend, 'hash'); assert.equal(compact.stats.entries, 100000);
    for (const i of [0, 1, 999, 99999]) assert.deepEqual(compact.match(fixed.entries[i]), new Reference(dictionary([fixed.entries[i]])).match(fixed.entries[i]));
    assert.equal(planDictionary(dataset(100000, 0, 'lengths-8')).backend, 'aho');
    assert.equal(planDictionary(dataset(100000, 0, 'shared-prefix')).backend, 'aho');
});

test('large diversified fallback trims capacity while preserving matcher behavior', () => {
    const input = dataset(100000, 0, 'lengths-8'), matcher = new DictionaryMatcher(input), reference = new Reference(input);
    assert.equal(matcher.backend, 'aho'); assert.equal(matcher.capacity, matcher.size);
    assert(matcher.stats.allocatedBytes <= reference.stats.allocatedBytes);
    for (const i of [0, 7, 100, 99999]) assert.deepEqual(matcher.match('prefix ' + input.entries[i] + ' suffix'), reference.match('prefix ' + input.entries[i] + ' suffix'));
});

test('worker accounts for normalized text and reserves Aho fallback before replacing a hash candidate', async t => {
    const fixed = dataset(100000), collision = dataset(100000, 0, 'collisions');
    const evaluator = require('../../src/automation/evaluation').createEvaluator(async id => id === 'fixed' ? fixed : collision, { maxCacheBytes: 30 * 1024 * 1024 });
    t.after(() => evaluator.stop());
    await evaluator.match({ id: 'fixed', revision: 1 }, fixed.entries[0]);
    await evaluator.match({ id: 'collision', revision: 1 }, collision.entries[0]);
    const stats = await evaluator.stats(); assert.equal(stats.worker.residents.length, 1);
    assert.equal(stats.worker.residents[0].backend, 'aho'); assert.equal(stats.worker.residents[0].fallbackReason, 'probe-limit');
    assert(stats.worker.residentBytes <= 30 * 1024 * 1024); assert.equal(stats.worker.evictions, 1);
    await evaluator.match({ id: 'fixed', revision: 1 }, fixed.entries[0]);
    assert.equal((await evaluator.stats()).dictionaryLoads, 3);
});
