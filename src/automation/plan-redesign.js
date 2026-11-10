'use strict';

const entitlements = require('./entitlements');
const capacity = require('./push-capacity');
const legacy = require('./legacy-donor-benefits');

// Approved policy values. Square prices must be separately verified against
// the merchant's monthly catalog before any binding is enabled.
const PLANS = Object.freeze([
    { planId: 'free', label: '無料', slotLimit: 3, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 180, specialSlotLimit: 0, realtimeEnabled: false, amountYen: 0 },
    { planId: 'subscription_lite', label: 'ライト', slotLimit: 5, minuteLimit: 10, dayLimit: 36, priority: 2, intervalMinutes: 60, specialSlotLimit: 0, realtimeEnabled: false, amountYen: 130 },
    { planId: 'subscription_basic', label: 'ベーシック', slotLimit: 10, minuteLimit: 20, dayLimit: 72, priority: 4, intervalMinutes: 10, specialSlotLimit: 10, realtimeEnabled: true, amountYen: 400 },
    { planId: 'subscription_ultra', label: 'ウルトラ', slotLimit: 30, minuteLimit: 30, dayLimit: 200, priority: 5, intervalMinutes: 5, specialSlotLimit: 30, realtimeEnabled: true, amountYen: 980 },
    { planId: 'subscription_community', label: 'コミュニティ', slotLimit: 50, minuteLimit: 40, dayLimit: 300, priority: 6, intervalMinutes: 5, specialSlotLimit: 50, realtimeEnabled: true, amountYen: 1480 },
].map(plan => Object.freeze(plan)));

// Must be invoked inside one DB transaction. This function does not create
// Square catalog objects, turn on bindings, delete records or move monitors.
async function applyApprovedPlanPolicies(query, { actor, ownerIds, now }) {
    if (actor?.isAdmin !== true || !/^\d{1,32}$/.test(String(actor.userId || '')))
        throw Object.assign(new Error('Administrator required'), { code: 'AUTOMATION_FORBIDDEN' });
    if (!Number.isSafeInteger(now) || now < 0) throw Object.assign(new Error('Invalid plan change time'), { code: 'PLAN_REDESIGN_INVALID' });
    const oldIds = ['subscription_lite_plus', 'subscription_ultra_max'];
    const assigned = await query('SELECT owner_user_id FROM automation_notification_entitlements WHERE expires_at_ms IS NULL OR expires_at_ms>? FOR UPDATE', [now]);
    const contracts = await query("SELECT subscription_id FROM automation_square_subscriptions WHERE state IN ('ACTIVE','PENDING','PAUSED','CANCELED') AND (valid_until_at_ms IS NULL OR valid_until_at_ms>?) FOR UPDATE", [now]);
    const checkouts = await query(`SELECT c.id FROM automation_square_checkouts c WHERE c.state NOT IN ('FAILED','KNOWN_REJECTED','COMPLETE')
        AND (c.state<>'QUOTED' OR c.expires_at_ms>? OR c.lease_until_at_ms>? OR c.source_digest IS NOT NULL OR c.card_id IS NOT NULL
          OR c.customer_id IS NOT NULL OR c.subscription_id IS NOT NULL OR EXISTS (SELECT 1 FROM automation_square_accounts a WHERE a.current_checkout_id=c.id)) FOR UPDATE`, [now, now]);
    if (assigned.length || contracts.length || checkouts.length)
        throw Object.assign(new Error('Existing subscriptions require reconciliation before plan switch'), { code: 'PLAN_REDESIGN_SUBSCRIPTIONS_EXIST' });
    const before = await query('SELECT * FROM automation_notification_plans ORDER BY plan_id FOR UPDATE');
    // Freeze the source intervals that form the donor floor. Owner-first and
    // source-before-target is the existing mutation lock order.
    await query('SELECT user_id FROM users WHERE is_donor=1 ORDER BY user_id FOR UPDATE');
    await query('SELECT id FROM auto_watch_sources ORDER BY id FOR UPDATE');
    await query('SELECT id FROM price_watch_sources ORDER BY id FOR UPDATE');
    await legacy.snapshotLegacyBenefits(query, { ownerIds, actor, now });
    for (const plan of PLANS) {
        await entitlements.savePlanPolicy(query, actor, { ...plan, enabled: true });
        if (plan.planId !== 'free') {
            const previous = await capacity.getPlanCapacity(query, actor, plan.planId);
            await capacity.savePlanCapacity(query, actor, plan.planId, {
                eligible: plan.specialSlotLimit > 0, specialSlotLimit: plan.specialSlotLimit,
                realtimeEnabled: plan.realtimeEnabled, expectedUpdatedAtMs: previous.updatedAtMs,
            });
        }
    }
    for (const planId of oldIds) {
        const old = before.find(row => row.plan_id === planId);
        if (old) await entitlements.savePlanPolicy(query, actor, { planId, label: old.label, slotLimit: Number(old.slot_limit),
            minuteLimit: Number(old.minute_limit), dayLimit: Number(old.day_limit), priority: Number(old.priority), enabled: false });
    }
    // Never sell using a stale daily or old-price variation.
    await query('UPDATE automation_square_bindings SET enabled=0 WHERE enabled<>0 AND plan_id IN (?)', [[...PLANS.map(plan => plan.planId), ...oldIds]]);
    await legacy.activateLegacyCutover(query, { ownerIds, actor, now });
    // Recompute untouched native-watch schedules while the same transaction
    // still holds the plan change. Existing retry attempts remain untouched.
    const sources = await query('SELECT id,poll_interval_ms,last_checked_at_ms FROM auto_watch_sources ORDER BY id FOR UPDATE');
    for (const source of sources) {
        const targets = await query('SELECT id,user_id,last_polled_at_ms,last_notification_window_at_ms FROM auto_watch_targets WHERE source_id=? AND enabled=1 ORDER BY id FOR UPDATE', [source.id]);
        let earliest = null;
        for (const target of targets) {
            const cadence = await require('./monitor-cadence').runtimeCadence(query, target.user_id, 'auto', String(target.id), Number(source.poll_interval_ms), now);
            const anchor = Number(target.last_polled_at_ms ?? (Number(source.last_checked_at_ms) || now));
            const next = anchor + cadence.intervalMs;
            await query('UPDATE auto_watch_targets SET next_poll_at_ms=? WHERE id=?', [next, target.id]);
            await query(`UPDATE auto_watch_deliveries d JOIN auto_watch_items i ON i.id=d.item_id
                SET d.next_attempt_at_ms=GREATEST(i.discovered_at_ms,?,?+?),d.cadence_due_at_ms=GREATEST(i.discovered_at_ms,?,?+?)
                WHERE d.target_id=? AND d.status='pending' AND d.attempt_count=0 AND d.lease_expires_at_ms<=?`,
            [next, Number(target.last_notification_window_at_ms || 0), cadence.intervalMs, next, Number(target.last_notification_window_at_ms || 0), cadence.intervalMs, target.id, now]);
            earliest = earliest === null ? next : Math.min(earliest, next);
        }
        if (earliest !== null) await query('UPDATE auto_watch_sources SET next_check_at_ms=LEAST(next_check_at_ms,?) WHERE id=?', [earliest, source.id]);
    }
    const priceSources = await query('SELECT id,state_json,initialized_at_ms,last_checked_at_ms FROM price_watch_sources ORDER BY id FOR UPDATE');
    for (const source of priceSources) {
        const targets = await query('SELECT id,user_id,baseline_at_ms FROM price_watch_targets WHERE source_id=? AND enabled=1 ORDER BY id FOR UPDATE', [source.id]);
        let earliest = null;
        for (const target of targets) {
            const minutes = await require('./plan-interval').currentPlanInterval(query, target.user_id, now);
            if (minutes === null) throw Object.assign(new Error('Price plan interval unavailable'), { code: 'PLAN_REDESIGN_INVALID' });
            const last = target.baseline_at_ms == null || source.initialized_at_ms == null ? 0 : Number(source.last_checked_at_ms || 0);
            const next = last ? last + minutes * 60000 : now;
            await query(`INSERT INTO automation_price_watch_cadence (target_id,last_checked_at_ms,next_check_at_ms,baseline_json) VALUES (?,?,?,?)
                ON DUPLICATE KEY UPDATE target_id=VALUES(target_id)`, [target.id, last, next, last ? source.state_json : null]);
            earliest = earliest === null ? next : Math.min(earliest, next);
        }
        if (earliest !== null) await query('UPDATE price_watch_sources SET next_check_at_ms=LEAST(next_check_at_ms,?) WHERE id=?', [earliest, source.id]);
    }
    await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,\'plan:redesign\',NULL,?,?,?)',
        [actor.userId, 'plan.redesign.apply', JSON.stringify({ before, plans: PLANS.map(plan => ({ ...plan })), squareBindingsDisabled: true }), now]);
    return { planCount: PLANS.length, donorCount: ownerIds.length, squareBindingsEnabled: false };
}

module.exports = { PLANS, applyApprovedPlanPolicies };
