'use strict';

/**
 * Delivery identity stays protected by the caller's target/source/destination
 * checks. This helper bridges editor CAS revisions only when every intervening
 * change has a complete, owner-scoped server audit for harmless metadata or a
 * pure X pool move. Missing, duplicate or damaged history fails closed.
 */
async function monitorRevisionCompatible(query, { kind, targetId, ownerUserId, expectedRevision, currentRevision }) {
    if (!['auto', 'price', 'x'].includes(kind) || !/^\d{1,20}$/.test(String(targetId || ''))
        || typeof ownerUserId !== 'string' || !/^\d{1,32}$/.test(ownerUserId)
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
        || !Number.isSafeInteger(currentRevision) || currentRevision < expectedRevision) return false;
    if (currentRevision === expectedRevision) return true;
    const actions = kind === 'x' ? "'x.monitor.rename','x.quota.move'" : "'monitor.rename'";
    const rows = await query(`SELECT detail_json,action FROM automation_audit WHERE entity_id=? AND action IN (${actions})
        AND CASE WHEN JSON_VALID(detail_json) THEN JSON_EXTRACT(detail_json,'$.beforeRevision') ELSE NULL END>=?
        AND CASE WHEN JSON_VALID(detail_json) THEN JSON_EXTRACT(detail_json,'$.beforeRevision') ELSE NULL END<? ORDER BY id`,
    [`${kind}:${targetId}`, expectedRevision, currentRevision]);
    if (rows.length !== currentRevision - expectedRevision) return false;
    const steps = new Set();
    for (const row of rows) {
        let detail;
        try { detail = typeof row.detail_json === 'string' ? JSON.parse(row.detail_json) : row.detail_json; } catch { return false; }
        if (!detail || typeof detail !== 'object' || Array.isArray(detail) || detail.manual !== true || detail.ownerUserId !== ownerUserId
            || !Number.isSafeInteger(detail.beforeRevision) || !Number.isSafeInteger(detail.afterRevision)
            || detail.afterRevision !== detail.beforeRevision + 1 || detail.beforeRevision < expectedRevision || detail.afterRevision > currentRevision
            || steps.has(detail.beforeRevision)) return false;
        if (row.action === 'x.quota.move' && kind === 'x') {
            if (detail.preservesDelivery === false || !['free', 'supporter', 'special'].includes(detail.before) || !['free', 'supporter', 'special'].includes(detail.after)) return false;
        } else if (row.action !== (kind === 'x' ? 'x.monitor.rename' : 'monitor.rename') || detail.metadataOnly !== true) return false;
        steps.add(detail.beforeRevision);
    }
    return steps.size === currentRevision - expectedRevision;
}

module.exports = { monitorRevisionCompatible };
