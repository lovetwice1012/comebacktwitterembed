'use strict';
const { SafetyError } = require('./safety');
async function assertPackageSafety(query, job) {
    if (job.workflow_id) {
        const rows = await query(`SELECT 1 FROM automation_package_installs i JOIN automation_packages p ON p.id=i.package_id
            JOIN automation_package_versions v ON v.package_id=i.package_id AND v.version=i.version
            WHERE i.workflow_id=? AND (p.status='revoked' OR v.status='revoked') LIMIT 1`, [job.workflow_id]);
        if (rows.length) throw new SafetyError('SAFETY_PACKAGE_REVOKED');
    }
    let refs = job.plan.dictionaryRefs;
    const validRefs = value => value == null || typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(ref => ref && typeof ref.id === 'string' && Number.isSafeInteger(ref.revision) && ref.revision >= 1);
    if (!validRefs(refs)) throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error');
    if (job.workflow_id) {
        const revisions = await query('SELECT bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [job.workflow_id, job.revision]);
        if (!revisions[0]) throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error');
        try {
            const bindings = typeof revisions[0].bindings_json === 'string' ? JSON.parse(revisions[0].bindings_json) : revisions[0].bindings_json;
            // Persisted flow-v2 jobs before the fix contain {}. An empty
            // caller snapshot never suppresses authoritative frozen bindings.
            const authoritative = bindings.dictionaries || {};
            if (!validRefs(authoritative)) throw new Error('INVALID_DEPENDENCIES');
            refs = { ...(refs || {}), ...authoritative };
        } catch { throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error'); }
    }
    if (refs != null && (typeof refs !== 'object' || Array.isArray(refs) || Object.values(refs).some(ref => !ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1))) throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error');
    const dependencies = [...new Map(Object.values(refs || {}).map(ref => [`${ref.id}:${ref.revision}`, ref])).values()];
    for (const ref of dependencies) {
        const rows = await query(`SELECT 1 FROM automation_dictionary_revisions r JOIN automation_packages p ON p.id=r.source_package_id
            LEFT JOIN automation_package_versions v ON v.package_id=r.source_package_id AND v.version=r.source_package_version
            WHERE r.dictionary_id=? AND r.revision=? AND (p.status='revoked' OR v.status='revoked') LIMIT 1`, [ref.id, ref.revision]);
        if (rows.length) throw new SafetyError('SAFETY_DICTIONARY_REVOKED');
        const source = (await query('SELECT package_dependencies_json FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [ref.id, ref.revision]))[0];
        if (source?.package_dependencies_json != null) {
            let lineage;
            try { lineage = require('./package-dependencies').storedReferences(source.package_dependencies_json); }
            catch { throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error'); }
            for (const dependency of lineage) {
                const status = (await query('SELECT p.status AS package_status,v.status AS edition_status,v.checksum FROM automation_packages p JOIN automation_package_versions v ON v.package_id=p.id WHERE p.id=? AND v.version=?', [dependency.packageId, dependency.version]))[0];
                if (!status || status.checksum !== dependency.checksum) throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error');
                if (status.package_status === 'revoked' || status.edition_status === 'revoked') throw new SafetyError('SAFETY_DICTIONARY_REVOKED');
            }
        }
    }
    // Existing databases may contain pre-provenance revisions. Preserve their
    // current-install revocation check rather than treating missing origin as
    // permission to bypass safety.
    const ids = [...new Set(dependencies.map(ref => ref.id))];
    for (const id of ids) {
        const rows = await query(`SELECT 1 FROM automation_package_dictionary_installs i JOIN automation_packages p ON p.id=i.package_id
            JOIN automation_package_versions v ON v.package_id=i.package_id AND v.version=i.version WHERE (p.status='revoked' OR v.status='revoked')
            AND JSON_SEARCH(i.dictionary_bindings_json,'one',?,NULL,'$.*.id') IS NOT NULL LIMIT 1`, [id]);
        if (rows.length) throw new SafetyError('SAFETY_DICTIONARY_REVOKED');
    }
}
module.exports = { assertPackageSafety };
