'use strict';

const FREE_PLAN = Object.freeze({ tier: 'free', planId: 'free', label: '無料', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0 });
const SUPPORTER_PLAN = Object.freeze({ ...FREE_PLAN, tier: 'supporter', planId: 'supporter', label: '支援者', priority: 1 });
const BUILTIN_PLANS = Object.freeze({ free: FREE_PLAN, supporter: SUPPORTER_PLAN });
const builtinPlan = id => typeof id === 'string' && Object.hasOwn(BUILTIN_PLANS, id.toLowerCase()) ? BUILTIN_PLANS[id.toLowerCase()] : undefined;
const TARGET_TABLES = Object.freeze({ auto: 'auto_watch_targets', price: 'price_watch_targets', x: 'automation_x_monitors' });
const PLAN_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function error(code, message, status = 400, issues) { return Object.assign(new Error(message), { name: 'AutomationError', code, status, ...(issues ? { issues } : {}) }); }
function ownerId(value) {
    if (!/^\d{1,32}$/.test(String(value || ''))) throw error('AUTOMATION_INVALID_USER', '利用者を確認できません。');
    return String(value);
}
function target(kind, id) {
    if (!Object.hasOwn(TARGET_TABLES, kind) || !/^\d{1,20}$/.test(String(id || ''))) throw error('AUTOMATION_INVALID_TARGET', '通知の登録を確認できません。');
    return String(id);
}
function number(value, minimum, maximum, path) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw error('AUTOMATION_PLAN_INVALID', 'プランの上限を確認してください。', 422, [{ path, message: `${minimum}〜${maximum}の整数を指定してください。` }]);
    return value;
}
function admin(actor) {
    if (actor?.isAdmin !== true) throw error('AUTOMATION_FORBIDDEN', 'プランの変更には管理者権限が必要です。', 403);
    return ownerId(actor.userId);
}
function slotError(plan) {
    return Object.assign(error('AUTOMATION_SLOT_LIMIT', `${plan.label}の通知枠は${plan.slotLimit}枠です。停止中の通知と、確認間隔の短縮に使う枠も含みます。使用枠を減らすか、不要な通知を削除してください。`, 422,
        [{ path: '$.monitor', code: 'AUTOMATION_SLOT_LIMIT', message: `${plan.label}の通知枠は${plan.slotLimit}枠までです。` }]), { maxSlots: plan.slotLimit, availableSlots: 0, planName: plan.label });
}
function validPolicy(row) {
    return Number.isSafeInteger(Number(row.slot_limit)) && Number(row.slot_limit) >= 1 && Number(row.slot_limit) <= 10000
        && Number.isSafeInteger(Number(row.minute_limit)) && Number(row.minute_limit) >= 1 && Number(row.minute_limit) <= 10000
        && Number.isSafeInteger(Number(row.day_limit)) && Number(row.day_limit) >= 1 && Number(row.day_limit) <= 1000000
        && Number.isSafeInteger(Number(row.priority)) && Number(row.priority) >= 0 && Number(row.priority) <= 100;
}
function policyDto(row) {
    const builtin = builtinPlan(row.plan_id);
    return { tier: builtin?.tier || 'paid', planId: builtin?.planId || row.plan_id, label: row.label,
        slotLimit: Number(row.slot_limit), minuteLimit: Number(row.minute_limit), dayLimit: Number(row.day_limit), priority: Number(row.priority),
        enabled: builtin ? true : Number(row.enabled) === 1, isBuiltin: !!builtin, updatedAtMs: Number(row.updated_at_ms),
        ...(row.confirmation_interval_minutes == null ? {} : { intervalMinutes: Number(row.confirmation_interval_minutes) }) };
}
function planConflict() { return error('AUTOMATION_PLAN_CONFLICT', 'プランが別の操作で更新されています。最新の設定を読み直してから保存してください。', 409); }

// Entitlements are exclusively server-managed. Request bodies never select a
// plan, supporter status, quota, or priority for the sending user.
async function inspectPlan(query, userId, now = Date.now(), squareScope) {
    const id = ownerId(userId);
    const users = await query('SELECT is_donor,additional_auto_extract_slots FROM users WHERE user_id=?', [id]);
    const square = squareScope || require('./square-billing').getSquareScope();
    const donation = await require('./square-donations').getSquareDonationGrant(query, id, now, square);
    const additional = Number(users[0]?.additional_auto_extract_slots || 0);
    const manualExtraSlots = Number.isSafeInteger(additional) && additional > 0 ? additional : 0;
    const holding = await require('./push-support-grants').getSupporterHolding(query, id, now, square);
    // The permanent ledger is the personal additional allowance. Legacy
    // recorded grants are frozen there; new rolling financial multipliers do
    // not mint a second registration allowance for the same new payment.
    const totalExtras = holding.totalSupporterSlots;
    const withAdditional = plan => {
        if (!Number.isSafeInteger(plan.slotLimit + totalExtras)) throw error('AUTOMATION_SLOT_ALLOWANCE_INVALID','個人の登録上限を安全に計算できません。管理者による確認が必要です。',503);
        return ({ ...plan, baseSlotLimit: plan.slotLimit, manualExtraSlots,
        addonGrantUnits: donation.purchaseUnits, addonExtraSlots: totalExtras - manualExtraSlots, donationPaymentCount: donation.paymentCount,
        addonValidUntilAtMs: donation.unitsValidUntilAtMs, slotLimit: plan.slotLimit + totalExtras });
    };
    const rows = await query(`SELECT p.* FROM automation_notification_entitlements e
        JOIN automation_notification_plans p ON p.plan_id=e.plan_id
        WHERE e.owner_user_id=? AND p.enabled=1 AND (e.expires_at_ms IS NULL OR e.expires_at_ms>?) LIMIT 1`, [id, now]);
    if (rows[0]) {
        const row = rows[0];
        // Invalid manually-written policy fails closed to the free allowance.
        if (!builtinPlan(row.plan_id) && validPolicy(row)) return withAdditional({ tier: 'paid', planId: row.plan_id, label: row.label, slotLimit: Number(row.slot_limit), minuteLimit: Number(row.minute_limit), dayLimit: Number(row.day_limit), priority: Number(row.priority) });
    }
    // A Square contract grants allowance only after the billing service has
    // verified its paid invoice, current merchant and current environment.
    // Administrative assignments keep precedence and are never overwritten by
    // billing events; deleting or canceling a contract leaves slot counters.
    if (square.configured) {
        const subscriptions = await query(`SELECT p.* FROM automation_square_subscriptions s
            JOIN automation_notification_plans p ON p.plan_id=s.plan_id AND p.enabled=1
            WHERE s.owner_user_id=? AND s.environment=? AND s.merchant_id=? AND s.verified=1
                AND s.state IN ('ACTIVE','CANCELED') AND s.valid_until_at_ms>? LIMIT 1`, [id, square.environment, square.merchantId, now]);
        const row = subscriptions[0];
        if (row && !builtinPlan(row.plan_id) && validPolicy(row)) return withAdditional({ tier: 'paid', planId: row.plan_id, label: row.label, slotLimit: Number(row.slot_limit), minuteLimit: Number(row.minute_limit), dayLimit: Number(row.day_limit), priority: Number(row.priority) });
    }
    const supporter = Number(users[0]?.is_donor) === 1 || donation.active;
    const base = supporter ? SUPPORTER_PLAN : FREE_PLAN;
    const policies = await query('SELECT * FROM automation_notification_plans WHERE plan_id=? LIMIT 1', [base.planId]);
    const configured = policies[0] && validPolicy(policies[0]) ? policyDto(policies[0]) : base;
    return withAdditional({ tier: base.tier, planId: base.planId, label: configured.label, minuteLimit: configured.minuteLimit,
        dayLimit: configured.dayLimit, priority: configured.priority, slotLimit: configured.slotLimit });
}

// X uses the same current plan as ordinary notifications, including the
// server-managed supporter plan. Allocation pools never select send quality.
async function inspectXPlan(query, userId, now = Date.now(), options = {}) {
    const normal = await inspectPlan(query, userId, now);
    const rows = await query('SELECT confirmation_interval_minutes FROM automation_notification_plans WHERE plan_id=? LIMIT 1', [normal.planId]);
    let intervalMinutes = rows[0]?.confirmation_interval_minutes == null ? null : Number(rows[0].confirmation_interval_minutes);
    if (intervalMinutes !== null && (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10080)) intervalMinutes = null;
    if (options.useLegacyUserInterval === true) {
        const overrides = await query('SELECT auto_watch_interval_minutes FROM users WHERE user_id=?', [String(userId)]);
        const legacy = Number(overrides[0]?.auto_watch_interval_minutes);
        if (Number.isSafeInteger(legacy) && legacy >= 5 && legacy <= 10080) intervalMinutes = legacy;
    }
    return { ...normal, intervalMinutes };
}
async function inspectPersonalPlan(query, userId, now = Date.now()) {
    return inspectPlan(query, userId, now);
}

async function lockOwner(query, userId) {
    const id = ownerId(userId);
    // Persistent owner row serializes allocation, release, downgrade and lazy
    // adoption across all workers and both native monitoring services.
    await query('INSERT INTO users (user_id,registered_at_ms) VALUES (?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)', [id, Date.now()]);
    await query('SELECT user_id FROM users WHERE user_id=? FOR UPDATE', [id]);
    return id;
}
const describeSlot = (owner, row, plan) => ({ ...plan, slotId: `${owner}:${Number(row.slot_index)}`, slotIndex: Number(row.slot_index), targetKind: row.target_kind, targetId: String(row.target_id) });
async function adoptExisting(query, userId) {
    const slots = await query('SELECT * FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index FOR UPDATE', [userId]);
    const boosts = await require('./monitor-cadence').boostRows(query, userId);
    const targets = await query(`SELECT 'auto' AS target_kind,id AS target_id,created_at_ms FROM auto_watch_targets WHERE user_id=?
        UNION ALL SELECT 'price' AS target_kind,id AS target_id,created_at_ms FROM price_watch_targets WHERE user_id=?
        ORDER BY created_at_ms,target_kind,target_id`, [userId, userId]);
    const xTargets = await query("SELECT 'x' AS target_kind,id AS target_id,created_at_ms FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' ORDER BY id", [userId]);
    targets.push(...xTargets);
    const registered = new Set(targets.map(row => `${row.target_kind}:${row.target_id}`));
    for (const row of boosts) if (!registered.has(`${row.target_kind}:${row.target_id}`)) await require('./monitor-cadence').release(query, userId, row.target_kind, String(row.target_id));
    const reserved = new Set(boosts.filter(row => registered.has(`${row.target_kind}:${row.target_id}`)).map(row => Number(row.slot_index)));
    for (const row of slots) if (row.target_kind && !registered.has(`${row.target_kind}:${row.target_id}`)) {
        await query('UPDATE automation_notification_slots SET target_kind=NULL,target_id=NULL WHERE owner_user_id=? AND slot_index=?', [userId, row.slot_index]);
        row.target_kind = null; row.target_id = null;
    }
    const assigned = new Set(slots.filter(row => row.target_kind).map(row => `${row.target_kind}:${row.target_id}`));
    for (const item of targets) {
        if (assigned.has(`${item.target_kind}:${item.target_id}`)) continue;
        let row = slots.find(slot => !slot.target_kind && !reserved.has(Number(slot.slot_index)));
        if (!row) {
            const index = slots.reduce((largest,slot)=>Math.max(largest,Number(slot.slot_index)),0) + 1;
            await query('INSERT INTO automation_notification_slots (owner_user_id,slot_index,target_kind,target_id,created_at_ms) VALUES (?,?,NULL,NULL,?)', [userId, index, Date.now()]);
            row = { slot_index: index, target_kind: null, target_id: null }; slots.push(row);
        }
        await query('UPDATE automation_notification_slots SET target_kind=?,target_id=? WHERE owner_user_id=? AND slot_index=?', [item.target_kind, item.target_id, userId, row.slot_index]);
        row.target_kind = item.target_kind; row.target_id = item.target_id; assigned.add(`${item.target_kind}:${item.target_id}`);
    }
    return slots;
}
async function assertSlotAvailable(query, userId, kind, targetId) {
    const id = await lockOwner(query, userId), plan = await inspectPersonalPlan(query, id), slots = await adoptExisting(query, id);
    if (targetId !== undefined && targetId !== null) {
        const nativeId = target(kind, targetId), slot = slots.find(row => row.target_kind === kind && String(row.target_id) === nativeId);
        if (!slot) throw error('AUTOMATION_NOT_FOUND', '通知の登録が見つかりません。', 404);
        if (Number(slot.slot_index) > plan.slotLimit) throw slotError(plan);
        return describeSlot(id, slot, plan);
    }
    if (!Object.hasOwn(TARGET_TABLES, kind)) throw error('AUTOMATION_INVALID_TARGET', '通知の種類を確認してください。');
    const boosts = await require('./monitor-cadence').boostRows(query, id);
    if (slots.filter(row => row.target_kind).length + boosts.length >= plan.slotLimit) throw slotError(plan);
    return plan;
}
async function assignSlot(query, userId, kind, targetId) { return assertSlotAvailable(query, userId, kind, target(kind, targetId)); }
async function releaseSlot(query, userId, kind, targetId) {
    const id = await lockOwner(query, userId), nativeId = target(kind, targetId);
    await require('./monitor-cadence').release(query, id, kind, nativeId);
    await query('UPDATE automation_notification_slots SET target_kind=NULL,target_id=NULL WHERE owner_user_id=? AND target_kind=? AND target_id=?', [id, kind, nativeId]);
}
async function findSlot(query, userId, kind, targetId) {
    const id = ownerId(userId), nativeId = target(kind, targetId);
    const native = await query(`SELECT id FROM ${TARGET_TABLES[kind]} WHERE id=? AND ${kind === 'x' ? "owner_user_id=? AND state<>'deleted'" : 'user_id=?'} LIMIT 1`, [nativeId, id]);
    if (!native.length) throw error('AUTOMATION_NOT_FOUND', '通知の登録が見つかりません。', 404);
    const plan = await inspectPersonalPlan(query, id), slots = await query('SELECT * FROM automation_notification_slots WHERE owner_user_id=? AND target_kind=? AND target_id=? LIMIT 1', [id, kind, nativeId]);
    if (!slots[0]) return null;
    if (Number(slots[0].slot_index) > plan.slotLimit) throw slotError(plan);
    return describeSlot(id, slots[0], plan);
}
async function resolveNotificationEntitlement(db, input) {
    return db.withDatabaseTransaction(async query => {
        const slot = await assignSlot(query, input.ownerUserId, input.targetKind, input.targetId);
        if (input.targetKind !== 'x') return slot;
        // X and native notifications use the same current plan even when its
        // reservation came from another pool; a pool never selects send rates.
        const plan = await inspectXPlan(query, input.ownerUserId, Date.now(), { useLegacyUserInterval: process.env.ANGELIC_X_USE_LEGACY_USER_INTERVAL === '1' });
        if (slot.slotIndex > plan.slotLimit) throw slotError(plan);
        return { ...slot, ...plan };
    });
}
async function listOwnerSlots(query, userId) {
    const id = await lockOwner(query, userId), plan = await inspectPersonalPlan(query, id), rows = await adoptExisting(query, id);
    const boosts = await require('./monitor-cadence').boostRows(query, id);
    const slots = rows.filter(row => row.target_kind).map(row => ({ ...describeSlot(id, row, plan), slotCost: 1 + boosts.filter(extra => extra.target_kind === row.target_kind && String(extra.target_id) === String(row.target_id)).length, allowed: Number(row.slot_index) <= plan.slotLimit }));
    const usedSlots = slots.length + boosts.length;
    return { ...plan, usedSlots, remainingSlots: Math.max(0, plan.slotLimit - usedSlots), slots };
}
async function getEntitlementSummary(db, userId) { return db.withDatabaseTransaction(query => listOwnerSlots(query, userId)); }
async function savePlanPolicy(query, actor, input) {
    const actorId = admin(actor), requestedId = String(input?.planId || ''), planId = builtinPlan(requestedId)?.planId || requestedId;
    if (!PLAN_ID.test(planId)) throw error('AUTOMATION_PLAN_INVALID', 'プランのIDは英字で始まる1〜64文字の英数字・ハイフン・アンダースコアで指定してください。', 422);
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120) throw error('AUTOMATION_PLAN_INVALID', 'プラン名は1〜120文字で指定してください。', 422);
    const slotLimit = number(input.slotLimit, 1, 10000, '$.slotLimit'), minuteLimit = number(input.minuteLimit, 1, 10000, '$.minuteLimit'), dayLimit = number(input.dayLimit, 1, 1000000, '$.dayLimit'), priority = number(input.priority, 0, 100, '$.priority');
    if (input.intervalMinutes !== undefined && input.intervalMinutes !== null) number(input.intervalMinutes, 5, 10080, '$.intervalMinutes');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw error('AUTOMATION_PLAN_INVALID', '有効状態を確認してください。', 422);
    if (builtinPlan(planId) && input.enabled === false) throw error('AUTOMATION_PLAN_INVALID', '無料枠・支援者枠は無効化できません。', 422, [{ path: '$.enabled', message: '無料枠・支援者枠は有効のまま設定してください。' }]);
    const expected = input.expectedUpdatedAtMs === undefined ? undefined : number(input.expectedUpdatedAtMs, 0, Number.MAX_SAFE_INTEGER - 1, '$.expectedUpdatedAtMs');
    const timestamp = Math.max(Date.now(), (expected || 0) + 1);
    const values = [planId, input.label.trim(), slotLimit, minuteLimit, dayLimit, priority, input.enabled === false ? 0 : 1, actorId, timestamp];
    if (expected === 0) {
        try { await query(`INSERT INTO automation_notification_plans (plan_id,label,slot_limit,minute_limit,day_limit,priority,enabled,actor_user_id,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`, values); }
        catch (cause) { if (cause?.code === 'ER_DUP_ENTRY') throw planConflict(); throw cause; }
    } else if (expected !== undefined) {
        const updated = await query(`UPDATE automation_notification_plans SET plan_id=IF(LOWER(plan_id) IN ('free','supporter'),LOWER(plan_id),plan_id),label=?,slot_limit=?,minute_limit=?,day_limit=?,priority=?,enabled=?,actor_user_id=?,updated_at_ms=? WHERE plan_id=? AND updated_at_ms=?`, [...values.slice(1), planId, expected]);
        if (!updated.affectedRows) throw planConflict();
    } else {
        // Legacy trusted callers may omit the revision; UI callers always use
        // CAS. The SQL timestamp remains monotonic even within one millisecond.
        await query(`INSERT INTO automation_notification_plans (plan_id,label,slot_limit,minute_limit,day_limit,priority,enabled,actor_user_id,updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE plan_id=IF(LOWER(plan_id) IN ('free','supporter'),LOWER(plan_id),plan_id),label=VALUES(label),slot_limit=VALUES(slot_limit),minute_limit=VALUES(minute_limit),day_limit=VALUES(day_limit),priority=VALUES(priority),enabled=VALUES(enabled),actor_user_id=VALUES(actor_user_id),updated_at_ms=GREATEST(VALUES(updated_at_ms),updated_at_ms+1)`, values);
    }
    if (input.intervalMinutes !== undefined) {
        if (input.intervalMinutes !== null) number(input.intervalMinutes, 5, 10080, '$.intervalMinutes');
        await query('UPDATE automation_notification_plans SET confirmation_interval_minutes=? WHERE plan_id=?', [input.intervalMinutes, planId]);
    }
    return policyDto((await query('SELECT * FROM automation_notification_plans WHERE plan_id=? LIMIT 1', [planId]))[0]);
}
async function setUserPlan(query, actor, userId, planId, options = {}) {
    const actorId = admin(actor), id = await lockOwner(query, userId);
    if (planId === null || builtinPlan(planId)?.planId === 'free') {
        await query('DELETE FROM automation_notification_entitlements WHERE owner_user_id=?', [id]);
        return inspectPlan(query, id);
    }
    if (!PLAN_ID.test(planId || '') || builtinPlan(planId)) throw error('AUTOMATION_PLAN_INVALID', '有償プランを確認してください。', 422);
    const rows = await query('SELECT plan_id FROM automation_notification_plans WHERE plan_id=? AND enabled=1 LIMIT 1', [planId]);
    if (!rows.length) throw error('AUTOMATION_PLAN_NOT_FOUND', '有効なプランが見つかりません。', 404);
    const expires = options.expiresAtMs ?? null;
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= Date.now())) throw error('AUTOMATION_PLAN_INVALID', '将来の有効期限を指定してください。', 422);
    await query(`INSERT INTO automation_notification_entitlements (owner_user_id,plan_id,expires_at_ms,actor_user_id,updated_at_ms) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE plan_id=VALUES(plan_id),expires_at_ms=VALUES(expires_at_ms),actor_user_id=VALUES(actor_user_id),updated_at_ms=VALUES(updated_at_ms)`, [id, rows[0].plan_id, expires, actorId, Date.now()]);
    return inspectPlan(query, id);
}
async function listPlanPolicies(query, actor) {
    admin(actor);
    const rows = await query('SELECT * FROM automation_notification_plans ORDER BY plan_id');
    return [...Object.values(BUILTIN_PLANS).map(plan => {
        const row = rows.find(item => builtinPlan(item.plan_id)?.planId === plan.planId);
        return row && validPolicy(row) ? policyDto(row) : { ...plan, enabled: true, isBuiltin: true, updatedAtMs: Number(row?.updated_at_ms || 0) };
    }), ...rows.filter(row => !builtinPlan(row.plan_id)).map(policyDto)];
}

module.exports = { FREE_PLAN, SUPPORTER_PLAN, inspectPlan, inspectXPlan, inspectPersonalPlan, lockOwner, assertSlotAvailable, assignSlot, releaseSlot, findSlot, resolveNotificationEntitlement, listOwnerSlots, getEntitlementSummary, savePlanPolicy, setUserPlan, listPlanPolicies };
