'use strict';

// A native handoff window contains the deliveries that were already due when
// it opened. Its receipt lives on the target, so a short claim lease or restart
// cannot turn one discovery burst into one notification per check interval.
const policyFields = ['updatedAtMs', 'effectiveSlotCost', 'intervalMs', 'baseIntervalMs'];
const deliveryId = value => /^[1-9]\d{0,19}$/.test(String(value || ''));
function policy(cadence) { return Object.fromEntries(policyFields.map(field => [field, cadence[field]])); }
function readWindow(target, cadence, now = Date.now()) {
    let window;
    try { window = typeof target.notification_window_json === 'string' ? JSON.parse(target.notification_window_json) : target.notification_window_json; } catch { return null; }
    if (!window || window.version !== 1 || !deliveryId(window.upperDeliveryId)
        || !Number.isSafeInteger(window.openedAtMs) || window.openedAtMs <= 0
        || window.openedAtMs > now
        || window.openedAtMs !== Number(target.last_notification_window_at_ms)
        || !policyFields.every(field => window.policy?.[field] === cadence[field])) return null;
    return window;
}
function contains(window, delivery) {
    // A failed handoff moves next_attempt_at_ms for backoff. Its original due
    // time remains the cohort boundary, including after a process restart.
    // Legacy NULL rows use the value that the first valid claim atomically
    // freezes; the live retry time still gates both claim and locked handoff.
    const cadenceDueAtMs = Number(delivery.cadence_due_at_ms ?? delivery.next_attempt_at_ms ?? NaN);
    return !!window && deliveryId(delivery.id) && BigInt(delivery.id) <= BigInt(window.upperDeliveryId)
        && Number.isSafeInteger(cadenceDueAtMs) && cadenceDueAtMs >= 0 && cadenceDueAtMs <= window.openedAtMs;
}
function createWindow(cadence, upperDeliveryId, openedAtMs) {
    if (!deliveryId(upperDeliveryId) || !Number.isSafeInteger(openedAtMs) || openedAtMs <= 0) throw new Error('Invalid native notification window');
    return { version: 1, upperDeliveryId: String(upperDeliveryId), openedAtMs, policy: policy(cadence) };
}
module.exports = { readWindow, contains, createWindow };
