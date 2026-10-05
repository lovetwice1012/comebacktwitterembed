'use strict';

const { AutomationError } = require('./service');
const fail = (code, message, status = 400) => { throw new AutomationError(code, message, status); };
function createDictionaryService(db, service, evaluator) {
    async function analyze(input) {
        return evaluator.dictionaryTask(input.dictionary
            ? { operation: 'analyze', dictionary: input.dictionary, deduplicate: input.deduplicate === true }
            : { operation: 'parse', text: input.text, format: input.format, metadata: input.metadata, deduplicate: input.deduplicate === true });
    }
    function summary(result) {
        const { entries, ...metadata } = result.dictionary;
        return { metadata, entryCount: entries.length, sample: entries.slice(0, 100), duplicateCount: result.duplicateCount, conflictCount: result.conflictCount, conflicts: result.conflicts, duplicates: result.duplicates };
    }
    async function preview(input) { return summary(await analyze(input)); }
    async function current(actor, id, expectedRevision, write = true) {
        const row = await service.getRow('dictionary', actor, id, write);
        if (expectedRevision !== undefined && Number(row.revision) !== expectedRevision) fail('REVISION_CONFLICT', '辞書が更新されています。再読み込みしてください。', 409);
        return row;
    }
    async function save(actor, input, id = null) {
        if (id) await current(actor, id, input.expectedRevision);
        const result = await analyze(input);
        if (result.conflictCount) fail('DICTIONARY_CONFLICT', '同じ語に異なる指定があります。プレビューの競合箇所を修正してください。');
        return service.saveDictionary(actor, { ...input, dictionary: result.dictionary }, id);
    }
    async function page(actor, id, input = {}) {
        const row = await current(actor, id, undefined, false), revision = Number(input.revision || row.revision);
        const data = await service.dictionaryData(id, revision);
        const result = await evaluator.dictionaryTask({ operation: 'page', dictionary: data, offset: input.offset, count: input.count, search: input.search });
        return { ...result, id, revision, currentRevision: Number(row.revision), scope: row.scope };
    }
    async function patch(actor, id, input) {
        const row = await current(actor, id, input.expectedRevision);
        const before = await service.dictionaryData(id, Number(row.revision));
        const result = await evaluator.dictionaryTask({ operation: 'patch', dictionary: before, patch: input.patch, deduplicate: input.deduplicate === true });
        if (input.preview) return { ...summary(result), diff: await evaluator.dictionaryTask({ operation: 'diff', before, after: result.dictionary }) };
        if (result.conflictCount) fail('DICTIONARY_CONFLICT', '同じ語に異なる指定があります。プレビューを確認してください。');
        return service.saveDictionary(actor, { expectedRevision: input.expectedRevision, dictionary: result.dictionary }, id);
    }
    async function versions(actor, id, beforeRevision = Number.MAX_SAFE_INTEGER) {
        await current(actor, id, undefined, false);
        const rows = await db.queryDatabase('SELECT revision,checksum,entry_count,source_text,license_text,created_at_ms FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision<? ORDER BY revision DESC LIMIT 51', [id, Number(beforeRevision)]);
        return { items: rows.slice(0, 50).map(row => ({ revision: Number(row.revision), checksum: row.checksum, entryCount: Number(row.entry_count), source: row.source_text, license: row.license_text, createdAtMs: Number(row.created_at_ms) })), nextRevision: rows.length > 50 ? Number(rows[49].revision) : null };
    }
    async function diff(actor, id, from, to) {
        await current(actor, id, undefined, false);
        const [before, after] = await Promise.all([service.dictionaryData(id, Number(from)), service.dictionaryData(id, Number(to))]);
        return evaluator.dictionaryTask({ operation: 'diff', before, after });
    }
    async function restore(actor, id, input) {
        await current(actor, id, input.expectedRevision);
        return save(actor, { expectedRevision: input.expectedRevision, dictionary: await service.dictionaryData(id, Number(input.revision)) }, id);
    }
    async function exportData(actor, id, revision, format) {
        const row = await current(actor, id, undefined, false);
        const data = await service.dictionaryData(id, Number(revision || row.revision));
        const text = await evaluator.dictionaryTask({ operation: 'export', dictionary: data, format });
        return { text, format, revision: Number(revision || row.revision) };
    }
    return { preview, save, page, patch, versions, diff, restore, exportData };
}
module.exports = { createDictionaryService };
