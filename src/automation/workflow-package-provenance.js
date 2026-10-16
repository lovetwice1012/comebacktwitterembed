'use strict';

// Only verified installation code writes these fields. Editable bundles and
// request bodies never supply an origin. Missing historical editions stay
// unknown instead of borrowing the license of a later package update.
async function revisionOrigin(query, workflowId, revision, currentRevision = undefined) {
    const row = (await query('SELECT source_package_id,source_package_version FROM automation_revisions WHERE workflow_id=? AND revision=?', [workflowId, revision]))[0];
    if (!row && revision !== currentRevision) throw Object.assign(new Error('保存済みの版を確認できません。ルールを再読み込みしてください。'), { name: 'AutomationError', code: 'REVISION_CONFLICT', status: 409 });
    if (row?.source_package_id) return { id: row.source_package_id, version: row.source_package_version == null ? null : Number(row.source_package_version) };
    const installed = await query('SELECT package_id,version FROM automation_package_installs WHERE workflow_id=?', [workflowId]);
    if (installed.length > 1) throw Object.assign(new Error('ルールの配布元を確認できません。'), { name: 'AutomationError', code: 'BUNDLE_CHECK_FAILED', status: 503 });
    // Early installations did not snapshot every draft's source. A current
    // install can coexist with an older restored draft, so it proves package
    // identity only. Do not relabel that content with the latest license.
    return installed.length ? { id: installed[0].package_id, version: null } : null;
}

async function rememberOrigin(query, workflowId, revision, origin) {
    if (!origin) return;
    await query('UPDATE automation_revisions SET source_package_id=?,source_package_version=? WHERE workflow_id=? AND revision=?', [origin.id, origin.version, workflowId, revision]);
}

function requireKnownEdition(origin) {
    if (origin && (!Number.isSafeInteger(origin.version) || origin.version < 1)) throw Object.assign(new Error('この保存版の配布元を確認できません。内容は保持されています。運営に確認を依頼してください。'),
        { name: 'AutomationError', code: 'WORKFLOW_ORIGIN_REVIEW_REQUIRED', status: 409 });
    return origin;
}

module.exports = { revisionOrigin, rememberOrigin, requireKnownEdition };
