'use strict';
const MIN_INTERVAL_MS = 5 * 60000;
function fail(code, message, status = 422) { return Object.assign(new Error(message), { name: 'AutomationError', code, status }); }
async function boostRows(query, owner) { return query('SELECT * FROM automation_notification_boost_slots WHERE owner_user_id=? ORDER BY slot_index', [owner]); }
// Hold the owner lock first. Source completion locks its source before targets,
// so cadence edits and native handoff must acquire the same source-first order.
async function lockTargetSource(query, owner, targetId) {
    const target = (await query('SELECT source_id FROM auto_watch_targets WHERE id=? AND user_id=?', [targetId, owner]))[0];
    if (!target) return null;
    return (await query('SELECT id,poll_interval_ms FROM auto_watch_sources WHERE id=? FOR UPDATE', [target.source_id]))[0] || null;
}
async function runtimeCadence(query, owner, kind, targetId, baseMs, now = Date.now()) {
    const selected = (await query('SELECT slot_cost,updated_at_ms FROM automation_monitor_cadence WHERE owner_user_id=? AND target_kind=? AND target_id=?', [owner, kind, targetId]))[0];
    const cost = Number(selected?.slot_cost || 1), base = Number(baseMs);
    let effectiveCost = 1;
    if (cost > 1) {
        const plan = await require('./entitlements').inspectPlan(query, owner, now);
        const main = (await query('SELECT slot_index FROM automation_notification_slots WHERE owner_user_id=? AND target_kind=? AND target_id=?', [owner, kind, targetId]))[0];
        const extra = await query('SELECT slot_index FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind=? AND target_id=?', [owner, kind, targetId]);
        if (main && Number(main.slot_index) <= plan.slotLimit && extra.length === cost - 1 && extra.every(row => Number(row.slot_index) <= plan.slotLimit)) effectiveCost = cost;
    }
    return { slotCost: cost, effectiveSlotCost: effectiveCost, intervalMs: effectiveCost === 1 ? base : Math.max(MIN_INTERVAL_MS, Math.ceil(base / effectiveCost)), baseIntervalMs: base,
        updatedAtMs: selected ? Number(selected.updated_at_ms) : null, limited: effectiveCost !== cost };
}
// Caller holds the persistent owner lock; real numbered slots are reserved so
// pause, delete, concurrent registration and downgrades use one capacity pool.
async function reserve(query, owner, kind, targetId, input) {
    if (kind !== 'auto') throw fail('AUTOMATION_CADENCE_UNSUPPORTED', '間隔の短縮は新着通知で選択できます。');
    const cost = input.slotCost;
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 10000) throw fail('AUTOMATION_CADENCE_INVALID', '使用する通知枠数を1〜10,000の整数で指定してください。');
    const current = (await query('SELECT * FROM automation_monitor_cadence WHERE owner_user_id=? AND target_kind=? AND target_id=? FOR UPDATE', [owner, kind, targetId]))[0];
    if ((input.expectedUpdatedAtMs ?? null) !== (current ? Number(current.updated_at_ms) : null)) throw fail('AUTOMATION_CADENCE_CONFLICT', '確認間隔が別の操作で変更されました。最新の通知を読み直してください。', 409);
    const entitlement = await require('./entitlements').listOwnerSlots(query, owner);
    const slots = await query('SELECT * FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [owner]);
    const main = slots.find(row => row.target_kind === kind && String(row.target_id) === String(targetId));
    if (!main) throw fail('AUTOMATION_NOT_FOUND', '通知の登録が見つかりません。', 404);
    const extra = await boostRows(query, owner), own = extra.filter(row => row.target_kind === kind && String(row.target_id) === String(targetId));
    const occupied = new Set([...slots.filter(row => row.target_kind).map(row => Number(row.slot_index)), ...extra.filter(row => !own.includes(row)).map(row => Number(row.slot_index))]);
    const indices = own.filter(row => Number(row.slot_index) <= entitlement.slotLimit).map(row => Number(row.slot_index));
    for (let index = 1; indices.length < cost - 1 && index <= entitlement.slotLimit; index++) if (!occupied.has(index) && !indices.includes(index)) indices.push(index);
    if (cost > 1 && (Number(main.slot_index) > entitlement.slotLimit || indices.length < cost - 1)) throw Object.assign(fail('AUTOMATION_SLOT_LIMIT', '間隔を短くするための空き枠が足りません。通知の枠配分を確認してください。'), { maxSlots: entitlement.slotLimit, availableSlots: entitlement.remainingSlots + own.length, planName: entitlement.label });
    await query('DELETE FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind=? AND target_id=?', [owner, kind, targetId]);
    const retained = indices.slice(0, cost - 1);
    if (retained.length) {
        await query(`INSERT INTO automation_notification_slots (owner_user_id,slot_index,target_kind,target_id,created_at_ms) VALUES ${retained.map(() => '(?,?,NULL,NULL,?)').join(',')} ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)`, retained.flatMap(index => [owner, index, Date.now()]));
        await query(`INSERT INTO automation_notification_boost_slots (owner_user_id,slot_index,target_kind,target_id) VALUES ${retained.map(() => '(?,?,?,?)').join(',')}`, retained.flatMap(index => [owner, index, kind, targetId]));
    }
    const timestamp = Math.max(Date.now(), Number(current?.updated_at_ms || 0) + 1);
    await query('INSERT INTO automation_monitor_cadence (owner_user_id,target_kind,target_id,slot_cost,updated_at_ms) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE slot_cost=VALUES(slot_cost),updated_at_ms=VALUES(updated_at_ms)', [owner, kind, targetId, cost, timestamp]);
    return { slotCost: cost, updatedAtMs: timestamp };
}
async function release(query, owner, kind, targetId) {
    await query('DELETE FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind=? AND target_id=?', [owner, kind, targetId]);
    await query('DELETE FROM automation_monitor_cadence WHERE owner_user_id=? AND target_kind=? AND target_id=?', [owner, kind, targetId]);
}
async function sourceSchedule(query, source, now = Date.now()) {
    const targets = await query(`SELECT t.id,t.user_id,COALESCE(u.auto_watch_interval_minutes*60000,s.poll_interval_ms) AS base_interval_ms,u.auto_watch_interval_minutes
        FROM auto_watch_targets t JOIN auto_watch_sources s ON s.id=t.source_id JOIN users u ON u.user_id=t.user_id WHERE t.source_id=? AND t.enabled=1`, [source.id]);
    let requested = Infinity, override = false;
    for (const target of targets) {
        const cadence = await runtimeCadence(query, target.user_id, 'auto', String(target.id), Number(target.base_interval_ms), now);
        requested = Math.min(requested, cadence.intervalMs); override ||= cadence.effectiveSlotCost > 1 || target.auto_watch_interval_minutes != null;
    }
    return { requested_poll_interval_ms: Number.isFinite(requested) ? requested : source.poll_interval_ms, has_user_interval: override ? 1 : 0 };
}
module.exports = { MIN_INTERVAL_MS, boostRows, lockTargetSource, runtimeCadence, reserve, release, sourceSchedule };
