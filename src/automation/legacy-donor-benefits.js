'use strict';

// Historical benefits are a floor over the current subscription. A donated
// registration allowance is applied separately by the permanent grant ledger.
// Do not infer membership from a current donation or recalculate old grants.
function applyLegacyBenefit(plan, benefit) {
    if (!benefit) return { ...plan };
    const fields = ['slotLimit', 'minuteLimit', 'dayLimit', 'priority'];
    for (const key of fields) {
        const minimum = key === 'priority' ? 0 : 1;
        const maximum = key === 'priority' ? 100 : key === 'dayLimit' ? 1000000 : 10000;
        if (!Number.isSafeInteger(plan[key]) || plan[key] < minimum
            || plan[key] > maximum || !Number.isSafeInteger(benefit[key]) || benefit[key] < minimum || benefit[key] > maximum) {
            throw Object.assign(new Error('Invalid legacy donor benefit'), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
        }
    }
    const result = { ...plan, legacyDonor: true };
    for (const key of fields) result[key] = Math.max(plan[key], benefit[key]);
    if (plan.intervalMinutes != null && (!Number.isSafeInteger(plan.intervalMinutes) || plan.intervalMinutes < 5 || plan.intervalMinutes > 10080))
        throw Object.assign(new Error('Invalid plan interval'), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
    if (benefit.intervalMinutes !== null) {
        if (!Number.isSafeInteger(benefit.intervalMinutes) || benefit.intervalMinutes < 5 || benefit.intervalMinutes > 10080)
            throw Object.assign(new Error('Invalid legacy donor interval'), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
        result.intervalMinutes = plan.intervalMinutes == null ? benefit.intervalMinutes : Math.min(plan.intervalMinutes, benefit.intervalMinutes);
    }
    return result;
}

async function inspectLegacyBenefit(query, userId) {
    const rows = await query(`SELECT c.id AS cutover_id,b.owner_user_id,b.slot_limit,b.minute_limit,b.day_limit,b.priority,b.confirmation_interval_minutes
        FROM (SELECT 1 AS id) seed LEFT JOIN automation_legacy_donor_cutover c ON c.id=seed.id
        LEFT JOIN automation_legacy_donor_benefits b ON b.owner_user_id=?`, [String(userId)]);
    const row = rows[0] || {};
    const cutover = Number(row.cutover_id) === 1;
    if (!cutover || !row.owner_user_id) return { cutover, benefit: null };
    return { cutover, benefit: { slotLimit: Number(row.slot_limit), minuteLimit: Number(row.minute_limit), dayLimit: Number(row.day_limit),
        priority: Number(row.priority), intervalMinutes: row.confirmation_interval_minutes == null ? null : Number(row.confirmation_interval_minutes) } };
}

async function isLegacyDonor(query, userId) {
    const legacy = await inspectLegacyBenefit(query, userId);
    if (legacy.cutover) return legacy.benefit !== null;
    const row = (await query('SELECT is_donor FROM users WHERE user_id=?', [String(userId)]))[0];
    return Number(row?.is_donor) === 1;
}

// Run within an explicit transaction before changing the active entitlement
// rules. The supplied cohort is reviewed separately; no current-donor flag or
// financial amount is treated as proof of historical cohort membership.
async function snapshotLegacyBenefits(query, { ownerIds, actor, now }) {
    const validId = id => typeof id === 'string' && /^\d{1,32}$/.test(id);
    if (actor?.isAdmin !== true || !validId(actor.userId))
        throw Object.assign(new Error('Administrator required'), { code: 'AUTOMATION_FORBIDDEN' });
    if (!Array.isArray(ownerIds) || !ownerIds.length || !ownerIds.every(validId)
        || new Set(ownerIds).size !== ownerIds.length
        || !Number.isSafeInteger(now) || now < 0)
        throw Object.assign(new Error('Invalid legacy donor cohort'), { code: 'LEGACY_DONOR_COHORT_INVALID' });
    if ((await query('SELECT id FROM automation_legacy_donor_cutover WHERE id=1 FOR UPDATE')).length)
        throw Object.assign(new Error('Legacy donor cutover already active'), { code: 'LEGACY_DONOR_CUTOVER_COMPLETE' });
    const baseline = (await query("SELECT slot_limit,minute_limit,day_limit,priority,confirmation_interval_minutes FROM automation_notification_plans WHERE plan_id='supporter' FOR UPDATE"))[0];
    if (!baseline) throw Object.assign(new Error('Legacy policy not found'), { code: 'LEGACY_DONOR_POLICY_MISSING' });
    const floor = { slotLimit: Number(baseline.slot_limit), minuteLimit: Number(baseline.minute_limit), dayLimit: Number(baseline.day_limit),
        priority: Number(baseline.priority), intervalMinutes: baseline.confirmation_interval_minutes == null ? null : Number(baseline.confirmation_interval_minutes) };
    if (floor.intervalMinutes === null) throw Object.assign(new Error('Legacy interval is not configured'), { code: 'LEGACY_DONOR_POLICY_MISSING' });
    applyLegacyBenefit({ ...floor }, floor);
    const expected = [...ownerIds].sort();
    const rows = await query(`SELECT u.user_id,u.is_donor,u.auto_watch_interval_minutes,
        (SELECT MIN(s.poll_interval_ms) FROM auto_watch_targets t JOIN auto_watch_sources s ON s.id=t.source_id WHERE t.user_id=u.user_id) AS fastest_source_interval_ms,
        (SELECT MIN(s.poll_interval_ms) FROM price_watch_targets t JOIN price_watch_sources s ON s.id=t.source_id WHERE t.user_id=u.user_id) AS fastest_price_interval_ms
        FROM users u WHERE u.user_id IN (?) ORDER BY u.user_id FOR UPDATE`, [expected]);
    const found = new Set(rows.filter(row => Number(row.is_donor) === 1).map(row => String(row.user_id)));
    if (expected.some(id => !found.has(id))) throw Object.assign(new Error('Cohort differs from verified donor records'), { code: 'LEGACY_DONOR_COHORT_MISMATCH' });
    for (const id of expected) {
        const donorRow = rows.find(row => String(row.user_id) === id);
        const previousInterval = donorRow?.auto_watch_interval_minutes;
        const override = previousInterval == null ? null : Number(previousInterval);
        if (override !== null && (!Number.isSafeInteger(override) || override < 5 || override > 10080))
            throw Object.assign(new Error('Invalid existing donor interval'), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
        const sourceMs = donorRow?.fastest_source_interval_ms == null ? null : Number(donorRow.fastest_source_interval_ms);
        const priceMs = donorRow?.fastest_price_interval_ms == null ? null : Number(donorRow.fastest_price_interval_ms);
        if (override === null && sourceMs !== null && (!Number.isSafeInteger(sourceMs) || sourceMs < 300000))
            throw Object.assign(new Error('Existing donor source interval cannot be preserved'), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
        if (priceMs !== null && (!Number.isSafeInteger(priceMs) || priceMs < 300000))
            throw Object.assign(new Error('Existing donor price interval cannot be preserved'), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
        const previous = override ?? (sourceMs === null ? null : Math.floor(sourceMs / 60000));
        const individualFloor = { ...floor, intervalMinutes: Math.min(floor.intervalMinutes, previous ?? floor.intervalMinutes, priceMs === null ? floor.intervalMinutes : Math.floor(priceMs / 60000)) };
        const inserted = await query(`INSERT INTO automation_legacy_donor_benefits (owner_user_id,slot_limit,minute_limit,day_limit,priority,confirmation_interval_minutes,granted_at_ms,actor_user_id)
            VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)`,
        [id, individualFloor.slotLimit, individualFloor.minuteLimit, individualFloor.dayLimit, individualFloor.priority, individualFloor.intervalMinutes, now, actor.userId]);
        if (inserted.affectedRows === 1) await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,?,NULL,?,?,?)',
            [actor.userId, id, 'donor.legacy.snapshot', JSON.stringify(individualFloor), now]);
    }
    return { count: expected.length, floor };
}

// Call only in the same transaction as snapshot and the plan configuration
// switch. Verify the complete current cohort to avoid removing a privilege
// from a donor that was not included in the reviewed input.
async function activateLegacyCutover(query, { ownerIds, actor, now }) {
    if (actor?.isAdmin !== true || !/^\d{1,32}$/.test(String(actor.userId || '')))
        throw Object.assign(new Error('Administrator required'), { code: 'AUTOMATION_FORBIDDEN' });
    if (!Array.isArray(ownerIds) || !ownerIds.length || ownerIds.some(id => typeof id !== 'string' || !/^\d{1,32}$/.test(id)) || new Set(ownerIds).size !== ownerIds.length || !Number.isSafeInteger(now) || now < 0)
        throw Object.assign(new Error('Invalid legacy donor cohort'), { code: 'LEGACY_DONOR_COHORT_INVALID' });
    const donors = await query('SELECT user_id FROM users WHERE is_donor=1 ORDER BY user_id FOR UPDATE');
    const expected = [...ownerIds].sort(), actual = donors.map(row => String(row.user_id)).sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]))
        throw Object.assign(new Error('Legacy donor cohort changed'), { code: 'LEGACY_DONOR_COHORT_MISMATCH' });
    const saved = await query('SELECT owner_user_id,slot_limit,minute_limit,day_limit,priority,confirmation_interval_minutes FROM automation_legacy_donor_benefits WHERE owner_user_id IN (?) ORDER BY owner_user_id FOR UPDATE', [expected]);
    const savedIds = new Set(saved.map(row => String(row.owner_user_id)));
    if (expected.some(id => !savedIds.has(id))) throw Object.assign(new Error('Legacy benefit snapshot incomplete'), { code: 'LEGACY_DONOR_SNAPSHOT_INCOMPLETE' });
    for (const row of saved) {
        const benefit = { slotLimit: Number(row.slot_limit), minuteLimit: Number(row.minute_limit), dayLimit: Number(row.day_limit),
            priority: Number(row.priority), intervalMinutes: row.confirmation_interval_minutes == null ? null : Number(row.confirmation_interval_minutes) };
        if (benefit.intervalMinutes === null) throw Object.assign(new Error('Legacy benefit interval incomplete'), { code: 'LEGACY_DONOR_SNAPSHOT_INCOMPLETE' });
        applyLegacyBenefit(benefit, benefit);
    }
    const inserted = await query('INSERT INTO automation_legacy_donor_cutover (id,activated_at_ms,actor_user_id) VALUES (1,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)', [now, actor.userId]);
    if (inserted.affectedRows === 1) await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,\'donor:cutover\',NULL,?,?,?)',
        [actor.userId, 'donor.legacy.cutover', JSON.stringify({ count: expected.length }), now]);
}

module.exports = { applyLegacyBenefit, inspectLegacyBenefit, isLegacyDonor, snapshotLegacyBenefits, activateLegacyCutover };
