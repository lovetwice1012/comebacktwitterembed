'use strict';

// Final job creation time is not provenance: restored flow work can create a
// brand-new job. Always fence the persisted originating run instead.
async function currentRunIds(query, runIds, { revoke = false, now = Date.now() } = {}) {
    const ids = [...new Set(runIds)];
    const recovery = require('../recoveryBootstrap');
    if (!ids.length || !recovery.begin()) return new Set(ids);
    const rows = await query('SELECT id,created_at_ms,target_kind,target_id FROM automation_runs WHERE id IN (?)', [ids]);
    const byId = new Map(rows.map(row => [row.id, row])), current = new Set(), old = [];
    for (const id of ids) {
        const origin = byId.get(id);
        if (recovery.notificationAllowed('automation_origin', { id, created_at_ms: origin?.created_at_ms ?? null,
            target_kind: origin?.target_kind, target_id: origin?.target_id }, origin?.created_at_ms == null ? undefined : Number(origin.created_at_ms))) current.add(id);
        else old.push(id);
    }
    if (revoke && old.length) await query("UPDATE automation_flow_runs SET revoked_at_ms=COALESCE(revoked_at_ms,?),revocation_code=COALESCE(revocation_code,'RECOVERY_QUARANTINED'),needs_sync=1 WHERE run_id IN (?)", [now, old]);
    return current;
}

function inboxAllowed(inbox) {
    return require('../recoveryBootstrap').notificationAllowed('x_push_inbox', { id: String(inbox.id),
        subscription_id: inbox.subscriptionId, subscription_revision: inbox.revision, received_at_ms: inbox.receivedAtMs }, inbox.receivedAtMs);
}

function priceObservedAt(delivery) {
    try {
        const event = typeof delivery.event_json === 'string' ? JSON.parse(delivery.event_json) : delivery.event_json;
        if (Number.isSafeInteger(event?.observedAtMs) && event.observedAtMs >= 0) return event.observedAtMs;
    } catch { /* Legacy rows retain the existing creation-time fallback. */ }
    const created = delivery.created_at instanceof Date ? delivery.created_at.getTime() : Date.parse(delivery.created_at);
    return Number.isFinite(created) ? created : undefined;
}

module.exports = { currentRunIds, inboxAllowed, priceObservedAt };
