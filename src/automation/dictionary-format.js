'use strict';

const { validateDictionary, normalize } = require('./dictionary');
const COLUMNS = ['term', 'kind', 'mode', 'category', 'severity', 'replacement', 'representation'];
const MAX_BYTES = 128 * 1024 * 1024;
function fail(code) { throw new Error(`DICTIONARY_${code}`); }
function csvRows(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail('SIZE_LIMIT');
    text = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], cell = '', quoted = false, closed = false;
    const push = () => { if (cell.length > 20000 || row.length > 12) fail('CSV_CELL_LIMIT'); row.push(cell); cell = ''; closed = false; };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
            else cell += ch;
        } else if (ch === '"') { if (cell || closed) fail('CSV_QUOTE'); quoted = true; }
        else if (ch === ',') push();
        else if (ch === '\n' || ch === '\r') {
            push(); if (row.some(v => v !== '')) rows.push(row); row = [];
            if (ch === '\r' && text[i + 1] === '\n') i++;
            if (rows.length > 1000003) fail('ENTRY_LIMIT');
        } else { if (closed) fail('CSV_TRAILING_TEXT'); cell += ch; }
        if (cell.length > 20000) fail('CSV_CELL_LIMIT');
    }
    if (quoted) fail('CSV_UNTERMINATED');
    if (cell || row.length || closed) { push(); rows.push(row); }
    return rows;
}
const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const dangerous = text => /^[=+\-@\s'\p{Default_Ignorable_Code_Point}]/u.test(text.normalize('NFKC'));
const safeCell = value => { const text = String(value ?? ''); return dangerous(text) ? `'${text}` : text; };
const restoreCell = text => text.startsWith("'") && dangerous(text.slice(1)) ? text.slice(1) : text;

function parseDictionary(text, format = 'json', metadata = {}) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail('SIZE_LIMIT');
    let result;
    if (format === 'json') {
        try { result = JSON.parse(text); } catch { fail('JSON_SYNTAX'); }
    } else if (format === 'txt') result = { schemaVersion: 1, name: metadata.name || '取り込んだ辞書', mode: metadata.mode || 'contains', source: metadata.source || '', license: metadata.license || '', entries: text.replace(/^\uFEFF/, '').split(/\r?\n/).map(t => t.trim()).filter(Boolean) };
    else if (format === 'csv') {
        const rows = csvRows(text);
        let meta = { schemaVersion: 1, name: metadata.name || '取り込んだ辞書', mode: metadata.mode || 'contains', source: metadata.source || '', license: metadata.license || '' }, encoded = false;
        if (rows[0]?.[0] === '#cbte-dictionary-v1') {
            try { meta = JSON.parse(rows.shift()[1]); } catch { fail('CSV_METADATA'); }
            encoded = true;
        }
        const header = rows.shift();
        if (!header?.includes('term') || header.some(k => !COLUMNS.includes(k)) || new Set(header).size !== header.length) fail('CSV_HEADER');
        const entries = rows.map(row => {
            if (row.length !== header.length) fail('CSV_COLUMNS');
            const cells = Object.fromEntries(header.map((key, i) => [key, encoded ? restoreCell(row[i]) : row[i]]));
            if (cells.representation === 'string') return cells.term;
            let present = [];
            if (encoded && cells.representation?.startsWith('[')) {
                try { present = JSON.parse(cells.representation); } catch { fail('CSV_REPRESENTATION'); }
                if (!Array.isArray(present) || present.some(k => !COLUMNS.includes(k) || k === 'representation')) fail('CSV_REPRESENTATION');
            }
            const entry = { term: cells.term };
            for (const key of COLUMNS.filter(k => !['term', 'representation'].includes(k))) if (cells[key] !== undefined && (cells[key] !== '' || present.includes(key))) entry[key] = key === 'severity' ? Number(cells[key]) : cells[key];
            return entry;
        });
        result = { ...meta, entries };
    } else fail('FORMAT');
    return validateDictionary(result);
}
function exportDictionary(dictionary, format) {
    validateDictionary(dictionary);
    if (format === 'json') return JSON.stringify(dictionary, null, 2);
    if (format === 'txt') return dictionary.entries.map(e => typeof e === 'string' ? e : e.term).join('\n');
    if (format !== 'csv') fail('FORMAT');
    const { entries, ...meta } = dictionary;
    const rows = [[csvCell('#cbte-dictionary-v1'), csvCell(JSON.stringify(meta))].join(','), COLUMNS.join(',')];
    for (const e of entries) {
        const entry = typeof e === 'string' ? { term: e, representation: 'string' } : { ...e, representation: JSON.stringify(Object.keys(e)) };
        rows.push(COLUMNS.map(k => csvCell(safeCell(entry[k]))).join(','));
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
}
function entryKey(entry, dictionary) { return normalize(typeof entry === 'string' ? entry : entry.term, dictionary.normalization); }
function canonical(entry, dictionary) {
    const object = typeof entry === 'string' ? { term: entry } : entry;
    return { term: entryKey(entry, dictionary), kind: object.kind || 'deny', mode: object.mode || dictionary.mode || 'contains', category: object.category || '', severity: object.severity ?? 0, replacement: object.replacement ?? null };
}
function analyzeDictionary(dictionary, deduplicate = false) {
    validateDictionary(dictionary);
    const seen = new Map(), entries = [], conflicts = [], duplicates = [];
    let duplicateCount = 0, conflictCount = 0;
    for (let index = 0; index < dictionary.entries.length; index++) {
        const entry = dictionary.entries[index], key = entryKey(entry, dictionary);
        if (!key) fail('EMPTY_NORMALIZED_TERM');
        const previous = seen.get(key);
        if (previous !== undefined) {
            duplicateCount++;
            if (duplicates.length < 50) duplicates.push({ index, firstIndex: previous, term: typeof entry === 'string' ? entry : entry.term });
            if (JSON.stringify(canonical(dictionary.entries[previous], dictionary)) !== JSON.stringify(canonical(entry, dictionary))) {
                conflictCount++; if (conflicts.length < 50) conflicts.push({ index, firstIndex: previous, term: key });
            }
            if (!deduplicate) entries.push(entry);
        } else { seen.set(key, index); entries.push(entry); }
    }
    return { dictionary: { ...dictionary, entries }, duplicateCount, conflictCount, duplicates, conflicts };
}
function diffDictionaries(before, after, limit = 100) {
    validateDictionary(before); validateDictionary(after);
    // Retain integer indices, not a canonical object/signature for every term.
    // Large mostly-unchanged revisions avoid millions of long-lived objects.
    const old = new Map();
    for (let i = 0; i < before.entries.length; i++) old.set(entryKey(before.entries[i], before), i);
    let added = 0, removed = 0, changed = 0;
    const samples = [];
    const seen = new Set();
    for (const entry of after.entries) {
        const key = entryKey(entry, after), priorIndex = old.get(key);
        if (seen.has(key)) continue;
        seen.add(key);
        if (priorIndex === undefined) { added++; if (samples.length < limit) samples.push({ change: 'added', after: entry }); }
        else {
            const prior = before.entries[priorIndex];
            const sameSimpleTerm = typeof entry === 'string' && prior === entry && (before.mode || 'contains') === (after.mode || 'contains');
            if (!sameSimpleTerm && JSON.stringify(canonical(prior, before)) !== JSON.stringify(canonical(entry, after))) { changed++; if (samples.length < limit) samples.push({ change: 'changed', before: canonical(prior, before), after: entry }); }
        }
        old.delete(key);
    }
    removed = old.size;
    for (const index of old.values()) { if (samples.length >= limit) break; samples.push({ change: 'removed', before: canonical(before.entries[index], before) }); }
    return { added, removed, changed, samples, metadataChanged: ['name', 'mode', 'normalization', 'source', 'license'].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])) };
}
function patchDictionary(dictionary, patch) {
    validateDictionary(dictionary);
    if (!patch || !Array.isArray(patch.operations) || patch.operations.length > 10000) fail('PATCH_LIMIT');
    const entries = dictionary.entries.slice(), indices = new Set(), removals = new Set(), additions = [];
    for (const op of patch.operations) {
        if (!['add', 'replace', 'remove'].includes(op.op)) fail('PATCH_OPERATION');
        if (op.op === 'add') { additions.push(op.entry); continue; }
        if (!Number.isInteger(op.index) || op.index < 0 || op.index >= entries.length || indices.has(op.index)) fail('PATCH_INDEX');
        indices.add(op.index);
        if (JSON.stringify(entries[op.index]) !== JSON.stringify(op.expected)) fail('PATCH_CONFLICT');
        if (op.op === 'remove') removals.add(op.index); else entries[op.index] = op.entry;
    }
    const result = { ...dictionary, entries: entries.filter((_, i) => !removals.has(i)).concat(additions) };
    if (patch.metadata) for (const [key, value] of Object.entries(patch.metadata)) {
        if (!['name', 'mode', 'normalization', 'source', 'license'].includes(key)) fail('PATCH_METADATA');
        result[key] = value;
    }
    return validateDictionary(result);
}
function dictionaryPage(dictionary, options = {}) {
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0)), count = Math.max(1, Math.min(1000, Math.floor(Number(options.count) || 100)));
    const needle = String(options.search || '').normalize('NFKC').toLowerCase(), records = [];
    let total = 0;
    for (let index = 0; index < dictionary.entries.length; index++) {
        const entry = dictionary.entries[index], term = typeof entry === 'string' ? entry : entry.term;
        if (needle && !term.normalize('NFKC').toLowerCase().includes(needle)) continue;
        if (total >= offset && records.length < count) records.push({ index, entry });
        total++;
    }
    const { entries: _entries, ...metadata } = dictionary;
    return { ...metadata, records, entries: records.map(r => r.entry), total, offset, nextOffset: offset + count < total ? offset + count : null };
}
module.exports = { csvRows, parseDictionary, exportDictionary, analyzeDictionary, diffDictionaries, patchDictionary, entryKey, dictionaryPage };
