'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDictionary, exportDictionary, analyzeDictionary, diffDictionaries, patchDictionary, dictionaryPage, csvRows } = require('../../src/automation/dictionary-format');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createDictionaryService } = require('../../src/automation/dictionary-service');
const { validateDictionary } = require('../../src/automation/dictionary');
const dictionary = { schemaVersion: 1, name: 'テスト辞書', mode: 'contains', normalization: { form: 'NFKC', caseFold: true, spaces: 'preserve' }, source: '自作', license: 'CC0-1.0', entries: ['広告', { term: '広告制作', kind: 'allow', category: '例外', severity: 0, replacement: '' }, { term: '改行\nと,"引用"', kind: 'deny', mode: 'exact' }, '=HYPERLINK("https://example.test")', "'literal", '-word', '@user'] };

test('dictionary JSON/CSV roundtrip is lossless including quoted newlines, literal apostrophes and empty fields', () => {
    assert.deepEqual(parseDictionary(exportDictionary(dictionary, 'json'), 'json'), dictionary);
    const csv = exportDictionary(dictionary, 'csv');
    assert.deepEqual(parseDictionary(csv, 'csv'), dictionary);
    assert(csv.includes("'=HYPERLINK"));
    assert(csv.includes("''literal"));
    assert(!csv.includes('\n"=HYPERLINK'));
    assert.deepEqual(parseDictionary('term,kind,mode\r\n広告,deny,contains\r\n広告制作,allow,word\r\n', 'csv', { name: 'plain' }).entries, [{ term: '広告', kind: 'deny', mode: 'contains' }, { term: '広告制作', kind: 'allow', mode: 'word' }]);
    assert.deepEqual(parseDictionary('\uFEFF広告\r\n\r\n新着\n', 'txt', { name: 'words' }).entries, ['広告', '新着']);
});
test('CSV parser and dictionary schema reject malformed input, illegal fields and oversized values', () => {
    for (const csv of ['term\n"unterminated', 'term\n"closed"extra', 'term,term\nx,y', 'term,code\nx,y', 'term,kind\none', 'term\n' + 'x'.repeat(20001)]) assert.throws(() => parseDictionary(csv, 'csv'));
    assert.deepEqual(csvRows('a,b\n"x,y","z"\n'), [['a', 'b'], ['x,y', 'z']]);
    assert.throws(() => validateDictionary({ ...dictionary, source: {} }), /ATTRIBUTION/);
    assert.throws(() => validateDictionary({ ...dictionary, entries: [{ term: 'x', severity: 6 }] }), /SEVERITY/);
    assert.throws(() => validateDictionary({ ...dictionary, entries: [{ term: 'x', replacement: {} }] }), /REPLACEMENT/);
    assert.throws(() => validateDictionary({ ...dictionary, secret: 'not supported' }), /UNKNOWN_FIELD/);
});

test('CSV formula hardening includes whitespace, invisible prefixes and full-width forms without changing imported terms', () => {
    const input = { ...dictionary, entries: [' =1+1', '\u200b=1+1', '\uFEFF+1', '＝1+1', '＠example', '\tplain', "' literal"] };
    const csv = exportDictionary(input, 'csv');
    const records = csvRows(csv).slice(2);
    assert(records.every(row => row[0].startsWith("'")));
    assert.deepEqual(parseDictionary(csv, 'csv'), input);
});
test('normalized duplicates deduplicate only with explicit option and conflicting allow/deny remains a hard conflict', () => {
    const same = { ...dictionary, entries: ['ＡＢＣ', 'abc'] };
    assert.equal(analyzeDictionary(same).dictionary.entries.length, 2);
    const collapsed = analyzeDictionary(same, true);
    assert.equal(collapsed.duplicateCount, 1); assert.equal(collapsed.conflictCount, 0); assert.deepEqual(collapsed.dictionary.entries, ['ＡＢＣ']);
    assert.equal(analyzeDictionary({ ...same, entries: ['ＡＢＣ', { term: 'abc', kind: 'allow' }] }, true).conflictCount, 1);
});
test('partial patch uses stable original indices, protects expected entries and does not mutate the prior version', () => {
    const result = patchDictionary(dictionary, { operations: [{ op: 'remove', index: 0, expected: '広告' }, { op: 'replace', index: 1, expected: dictionary.entries[1], entry: { term: '広告制作', kind: 'deny' } }, { op: 'add', entry: '宣伝' }] });
    assert.equal(dictionary.entries[0], '広告'); assert.equal(result.entries[0].kind, 'deny'); assert.equal(result.entries.at(-1), '宣伝');
    const diff = diffDictionaries(dictionary, result);
    assert.equal(diff.added, 1); assert.equal(diff.removed, 1); assert.equal(diff.changed, 1);
    assert.equal(diffDictionaries({ ...dictionary, entries: ['x'] }, { ...dictionary, entries: ['x', 'x'] }).added, 0);
    assert.throws(() => patchDictionary(dictionary, { operations: [{ op: 'remove', index: 1, expected: 'wrong' }] }), /CONFLICT/);
    assert.throws(() => patchDictionary(dictionary, { operations: [{ op: 'remove', index: 0, expected: '広告' }, { op: 'remove', index: 0, expected: '広告' }] }), /INDEX/);
    assert.throws(() => patchDictionary(dictionary, { operations: [], metadata: { entries: [] } }), /METADATA/);
});
test('paged search returns actual revision indices rather than page-relative indices', () => {
    const data = { ...dictionary, entries: Array.from({ length: 1000 }, (_, i) => `word-${i}`) };
    const page = dictionaryPage(data, { search: 'word-1', offset: 1, count: 3 });
    assert.equal(page.total, 111); assert.deepEqual(page.records.map(r => r.index), [10, 11, 12]);
    assert.equal(page.nextOffset, 4); assert.equal(data.entries.length, 1000);
});
test('worker handles import/diff/export then reloads an earlier compiled dictionary correctly', async t => {
    const evaluator = createEvaluator(async () => dictionary); t.after(() => evaluator.stop());
    assert.equal((await evaluator.match({ id: 'd', revision: 1 }, '広告')).length, 1);
    const parsed = await evaluator.dictionaryTask({ operation: 'parse', text: exportDictionary(dictionary, 'csv'), format: 'csv' });
    assert.deepEqual(parsed.dictionary, dictionary);
    const diff = await evaluator.dictionaryTask({ operation: 'diff', before: dictionary, after: { ...dictionary, entries: [] } });
    assert.equal(diff.removed, dictionary.entries.length);
    assert.equal((await evaluator.match({ id: 'd', revision: 1 }, '広告')).length, 1);
});
test('dictionary manager rejects stale edits before expensive work and prevents save of conflicting imports', async t => {
    const evaluator = createEvaluator(async () => dictionary); t.after(() => evaluator.stop());
    let saved = 0;
    const service = { getRow: async () => ({ id: 'id', revision: 3 }), dictionaryData: async () => dictionary, saveDictionary: async () => { saved++; } };
    const manager = createDictionaryService({}, service, evaluator);
    await assert.rejects(manager.patch({ userId: '1' }, 'id', { expectedRevision: 2, patch: { operations: [] } }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(manager.save({ userId: '1' }, { dictionary: { ...dictionary, entries: ['x', { term: 'X', kind: 'allow' }] } }), { code: 'DICTIONARY_CONFLICT' });
    assert.equal(saved, 0);
});
test('large edits have one process-wide admission slot instead of retaining many huge queued inputs', async t => {
    const first = createEvaluator(null), second = createEvaluator(null); t.after(() => { first.stop(); second.stop(); });
    const data = { schemaVersion: 1, name: 'large', entries: Array.from({ length: 100000 }, (_, i) => `word-${i}`) };
    const task = first.dictionaryTask({ operation: 'analyze', dictionary: data, summaryOnly: true });
    await assert.rejects(second.dictionaryTask({ operation: 'analyze', dictionary: data, summaryOnly: true }), { code: 'AUTOMATION_WORKER_BUSY' });
    assert.equal((await task).entryCount, 100000);
    assert.equal((await second.dictionaryTask({ operation: 'analyze', dictionary: data, summaryOnly: true })).entryCount, 100000);
});
