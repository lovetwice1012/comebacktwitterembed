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
    if (!refs && job.workflow_id) {
        const revisions = await query('SELECT bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [job.workflow_id, job.revision]);
        if (!revisions[0]) throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error');
        try {
            const bindings = typeof revisions[0].bindings_json === 'string' ? JSON.parse(revisions[0].bindings_json) : revisions[0].bindings_json;
            refs = bindings.dictionaries;
        } catch { throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error'); }
    }
    if (refs != null && (typeof refs !== 'object' || Array.isArray(refs) || Object.values(refs).some(ref => !ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1))) throw new SafetyError('SAFETY_DEPENDENCIES_UNAVAILABLE', 'error');
    const ids = [...new Set(Object.values(refs || {}).map(ref => ref.id))];
    for (const id of ids) {
        const rows = await query(`SELECT 1 FROM automation_package_dictionary_installs i JOIN automation_packages p ON p.id=i.package_id
            JOIN automation_package_versions v ON v.package_id=i.package_id AND v.version=i.version WHERE (p.status='revoked' OR v.status='revoked')
            AND JSON_SEARCH(i.dictionary_bindings_json,'one',?,NULL,'$.*.id') IS NOT NULL LIMIT 1`, [id]);
        if (rows.length) throw new SafetyError('SAFETY_DICTIONARY_REVOKED');
    }
}
module.exports = { assertPackageSafety };
