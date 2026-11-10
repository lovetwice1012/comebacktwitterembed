'use strict';

// Resolve just the schedule policy without loading the owner's slot ledger or
// donation history on every source poll. Match inspectPlan's priority order.
async function currentPlanInterval(query, owner, now = Date.now()) {
    const square = require('./square-billing').getSquareScope();
    const valid = alias => `${alias}.enabled=1 AND ${alias}.plan_id NOT IN ('free','supporter') AND ${alias}.slot_limit BETWEEN 1 AND 10000 AND ${alias}.minute_limit BETWEEN 1 AND 10000 AND ${alias}.day_limit BETWEEN 1 AND 1000000 AND ${alias}.priority BETWEEN 0 AND 100`;
    const rows = await query(`SELECT cutover.id AS cutover_id,u.auto_watch_interval_minutes,
        CASE WHEN p.plan_id IS NOT NULL THEN p.confirmation_interval_minutes ${square.configured ? 'WHEN sp.plan_id IS NOT NULL THEN sp.confirmation_interval_minutes ' : ''}ELSE freeplan.confirmation_interval_minutes END AS interval_minutes,
        legacy.owner_user_id AS legacy_owner,legacy.confirmation_interval_minutes AS legacy_interval
        FROM (SELECT 1 AS id) seed LEFT JOIN automation_legacy_donor_cutover cutover ON cutover.id=seed.id
        LEFT JOIN users u ON u.user_id=?
        LEFT JOIN automation_legacy_donor_benefits legacy ON legacy.owner_user_id=u.user_id
        LEFT JOIN automation_notification_entitlements e ON e.owner_user_id=u.user_id AND (e.expires_at_ms IS NULL OR e.expires_at_ms>?)
        LEFT JOIN automation_notification_plans p ON p.plan_id=e.plan_id AND ${valid('p')}
        ${square.configured ? `LEFT JOIN automation_square_subscriptions ss ON ss.owner_user_id=u.user_id AND ss.environment=? AND ss.merchant_id=? AND ss.verified=1 AND ss.state IN ('ACTIVE','CANCELED') AND ss.valid_until_at_ms>?
        LEFT JOIN automation_notification_plans sp ON sp.plan_id=ss.plan_id AND ${valid('sp')}` : ''}
        LEFT JOIN automation_notification_plans freeplan ON freeplan.plan_id='free'`,
    [String(owner), now, ...(square.configured ? [square.environment, square.merchantId, now] : [])]);
    const row = rows[0];
    if (Number(row?.cutover_id) !== 1) return null;
    let interval = row.interval_minutes == null ? null : Number(row.interval_minutes);
    if (row.legacy_owner != null) {
        const floor = Number(row.legacy_interval);
        if (!Number.isSafeInteger(floor) || floor < 5 || floor > 10080) throw Object.assign(new Error('Invalid legacy interval'), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
        interval = interval == null ? floor : Math.min(interval, floor);
    }
    if (process.env.AUTOMATION_USE_LEGACY_USER_INTERVAL === '1' && row.auto_watch_interval_minutes != null)
        interval = Number(row.auto_watch_interval_minutes);
    if (!Number.isSafeInteger(interval) || interval < 5 || interval > 10080)
        throw Object.assign(new Error('Plan interval unavailable'), { code: 'AUTOMATION_PLAN_INTERVAL_UNAVAILABLE' });
    return interval;
}

async function wakeOwnerSources(query, owner, now = Date.now()) {
    const enabled = (await query('SELECT id FROM automation_legacy_donor_cutover WHERE id=1'))[0];
    if (!enabled) return;
    await query(`UPDATE auto_watch_sources s JOIN auto_watch_targets t ON t.source_id=s.id
        SET s.next_check_at_ms=LEAST(s.next_check_at_ms,?) WHERE t.user_id=? AND t.enabled=1`, [now, String(owner)]);
    await query(`UPDATE price_watch_sources s JOIN price_watch_targets t ON t.source_id=s.id
        SET s.next_check_at_ms=LEAST(s.next_check_at_ms,?) WHERE t.user_id=? AND t.enabled=1`, [now, String(owner)]);
}

async function wakePolicySources(query, now = Date.now()) {
    const enabled = (await query('SELECT id FROM automation_legacy_donor_cutover WHERE id=1'))[0];
    if (!enabled) return;
    // Spread reevaluation across five minutes; each target remains protected by
    // its own plan interval and the provider's existing request pacing.
    await query('UPDATE auto_watch_sources SET next_check_at_ms=LEAST(next_check_at_ms,?+MOD(id,300)*1000)', [now]);
    await query('UPDATE price_watch_sources SET next_check_at_ms=LEAST(next_check_at_ms,?+MOD(id,300)*1000)', [now]);
}

module.exports = { currentPlanInterval, wakeOwnerSources, wakePolicySources };
