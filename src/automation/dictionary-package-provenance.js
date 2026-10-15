'use strict';

// A legacy installation may have discarded dictionary IDs. Refuse to guess
// whether the remaining unlinked dictionaries were local or package-derived.
// This is a migration prerequisite, never a delivery-time blanket restriction.
async function inspectLegacyDictionaryOrigins(query) {
    const installs = await query(`SELECT owner_user_id,dictionary_bindings_json FROM automation_package_dictionary_installs`);
    const workflows = await query(`SELECT w.owner_user_id,r.bindings_json FROM automation_package_installs i
        JOIN automation_workflows w ON w.id=i.workflow_id
        LEFT JOIN automation_revisions r ON r.workflow_id=w.id AND r.revision=1`);
    const owners = new Set(), knownIds = new Set();
    function remember(value) {
        const refs = typeof value === 'string' ? JSON.parse(value) : value;
        if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('LEGACY_DICTIONARY_ORIGIN_INVALID');
        for (const ref of Object.values(refs)) {
            if (!ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('LEGACY_DICTIONARY_ORIGIN_INVALID');
            knownIds.add(ref.id);
        }
    }
    for (const row of installs) { owners.add(row.owner_user_id); remember(row.dictionary_bindings_json); }
    for (const row of workflows) {
        owners.add(row.owner_user_id);
        if (row.bindings_json == null) continue;
        const bindings = typeof row.bindings_json === 'string' ? JSON.parse(row.bindings_json) : row.bindings_json;
        remember(bindings?.dictionaries || {});
    }
    if (!owners.size) return { ready: true, dictionaryIds: [], ownerCount: 0 };
    const columns = await query("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='automation_dictionary_revisions' AND COLUMN_NAME IN ('source_package_id','origin_reviewed')");
    const names = new Set(columns.map(row => row.name));
    const origin = names.has('source_package_id') ? 'r.source_package_id IS NOT NULL' : '0';
    const reviewed = names.has('origin_reviewed') ? 'COALESCE(r.origin_reviewed,0)=1' : '0';
    const rows = await query(`SELECT DISTINCT d.id FROM automation_dictionaries d JOIN automation_dictionary_revisions r ON r.dictionary_id=d.id
        WHERE d.owner_user_id IN (?) AND NOT (${origin} OR ${reviewed})`, [[...owners]]);
    const dictionaryIds = rows.map(row => row.id).filter(id => !knownIds.has(id)).sort();
    return { ready: dictionaryIds.length === 0, dictionaryIds, ownerCount: owners.size };
}

async function assertLegacyDictionaryOrigins(query) {
    const result = await inspectLegacyDictionaryOrigins(query);
    if (!result.ready) throw Object.assign(new Error('Shared dictionary origins need explicit operator review before migration; retain all existing data.'),
        { code: 'DB_MIGRATION_DICTIONARY_ORIGIN_REVIEW_REQUIRED', dictionaryIds: result.dictionaryIds });
    return result;
}

module.exports = { inspectLegacyDictionaryOrigins, assertLegacyDictionaryOrigins };
