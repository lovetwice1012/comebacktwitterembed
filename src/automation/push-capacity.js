'use strict';

const { AutomationError, requireActor } = require('./service');
const CAPACITY_LIMIT_MAX = 100000;
const DEFAULT_POOL_POLICY = Object.freeze({ freePoolLimit: 50, supporterPoolLimit: 100 });
const PLAN_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function requireAdmin(actor) {
    requireActor(actor);
    if (actor.isAdmin !== true) throw new AutomationError('AUTOMATION_FORBIDDEN', 'Push枠の設定には管理者権限が必要です。', 403);
    return actor.userId;
}
function invalid(path, message = 'Push枠の設定を確認してください。') {
    return Object.assign(new AutomationError('AUTOMATION_PUSH_CAPACITY_INVALID', message, 422), { issues: [{ path, message }] });
}
function bounded(value, maximum, path) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid(path, `0〜${maximum}の整数を指定してください。`);
    return value;
}
function strictInput(input, fields) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('$', 'オブジェクト形式の入力が必要です。');
    const unknown = Object.keys(input).find(key => !fields.includes(key));
    if (unknown !== undefined) throw invalid(`$.${unknown}`, '指定できない設定項目が含まれています。');
}
function conflict() {
    return new AutomationError('AUTOMATION_PUSH_CAPACITY_CONFLICT', 'Push枠が別の操作で更新されています。最新の設定を読み直してから保存してください。', 409);
}
function storedLimit(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= CAPACITY_LIMIT_MAX ? parsed : fallback;
}
function storedRevision(value) {
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
        throw new AutomationError('AUTOMATION_PUSH_CAPACITY_UNAVAILABLE', 'Push枠の設定を確認できません。管理者による確認が必要です。', 503);
    }
    return revision;
}
function poolDto(row) {
    return {
        featureEnabled: false,
        freePoolLimit: row ? storedLimit(row.free_pool_limit, 0) : DEFAULT_POOL_POLICY.freePoolLimit,
        supporterPoolLimit: row ? storedLimit(row.supporter_pool_limit, 0) : DEFAULT_POOL_POLICY.supporterPoolLimit,
        updatedAtMs: row ? storedRevision(row.updated_at_ms) : 0,
    };
}
function planDto(plan, row) {
    const specialSlotLimit = row ? storedLimit(row.special_slot_limit, 0) : 0;
    return {
        planId: plan.plan_id, label: plan.label, planEnabled: Number(plan.enabled) === 1, isPaid: true,
        eligible: !!row && Number(row.eligible) === 1 && Number(row.special_slot_limit) === specialSlotLimit,
        specialSlotLimit, realtimeEnabled: Number(row?.realtime_enabled) === 1, consumesUserSlots: true, featureEnabled: false,
        updatedAtMs: row ? storedRevision(row.updated_at_ms) : 0,
    };
}
async function getPoolPolicy(query, actor) {
    requireAdmin(actor);
    return poolDto((await query('SELECT * FROM automation_push_pool_policy WHERE id=1'))[0]);
}
async function savePoolPolicy(query, actor, input) {
    const actorId = requireAdmin(actor);
    strictInput(input, ['freePoolLimit', 'supporterPoolLimit', 'expectedUpdatedAtMs']);
    const free = bounded(input.freePoolLimit, CAPACITY_LIMIT_MAX, '$.freePoolLimit');
    const supporter = bounded(input.supporterPoolLimit, CAPACITY_LIMIT_MAX, '$.supporterPoolLimit');
    const expected = bounded(input.expectedUpdatedAtMs, Number.MAX_SAFE_INTEGER - 2, '$.expectedUpdatedAtMs');
    let previous = null;
    if (expected > 0) {
        previous = (await query('SELECT * FROM automation_push_pool_policy WHERE id=1 FOR UPDATE'))[0] || null;
        // A prior policy GET may already have established a REPEATABLE READ
        // snapshot. Locking current reads must see registrations that committed
        // while this editor waited for the global row.
        const occupied = await query("SELECT id,pool_kind FROM automation_x_monitors WHERE state<>'deleted' AND pool_kind IN ('free','supporter') FOR UPDATE");
        if (occupied.filter(row => row.pool_kind === 'free').length > free || occupied.filter(row => row.pool_kind === 'supporter').length > supporter) {
            throw new AutomationError('AUTOMATION_PUSH_CAPACITY_IN_USE', '使用中の枠数を下回る上限は保存できません。利用者または管理者による手動移動か登録解除の後に変更してください。', 409);
        }
    }
    const now = Math.max(Date.now(), expected + 1);
    if (expected === 0) {
        try {
            await query('INSERT INTO automation_push_pool_policy (id,free_pool_limit,supporter_pool_limit,actor_user_id,updated_at_ms) VALUES (1,?,?,?,?)', [free, supporter, actorId, now]);
        } catch (cause) { if (cause?.code === 'ER_DUP_ENTRY') throw conflict(); throw cause; }
    } else {
        const updated = await query('UPDATE automation_push_pool_policy SET free_pool_limit=?,supporter_pool_limit=?,actor_user_id=?,updated_at_ms=? WHERE id=1 AND updated_at_ms=?', [free, supporter, actorId, now, expected]);
        if (!updated.affectedRows) throw conflict();
    }
    await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,\'x:pool-policy\',NULL,\'x.capacity.global\',?,?)', [actorId,JSON.stringify({before:previous?{freePoolLimit:Number(previous.free_pool_limit),supporterPoolLimit:Number(previous.supporter_pool_limit)}:null,after:{freePoolLimit:free,supporterPoolLimit:supporter}}),now]);
    return getPoolPolicy(query, actor);
}
async function existingPaidPlan(query, planId, locked) {
    if (typeof planId !== 'string' || !PLAN_ID.test(planId) || ['free', 'supporter'].includes(planId.toLowerCase())) {
        throw invalid('$.planId', '既存の有償プランを指定してください。');
    }
    const rows = await query(`SELECT plan_id,label,enabled FROM automation_notification_plans WHERE plan_id=? LIMIT 1${locked ? ' FOR UPDATE' : ''}`, [planId]);
    if (!rows[0]) throw new AutomationError('AUTOMATION_PUSH_CAPACITY_NOT_FOUND', '対象の有償プランが見つかりません。先にプランを登録してください。', 404);
    return rows[0];
}
async function getPlanCapacity(query, actor, planId) {
    requireAdmin(actor);
    const plan = await existingPaidPlan(query, planId, false);
    return planDto(plan, (await query('SELECT * FROM automation_push_plan_policy WHERE plan_id=?', [plan.plan_id]))[0]);
}
async function savePlanCapacity(query, actor, planId, input) {
    const actorId = requireAdmin(actor);
    strictInput(input, ['eligible', 'specialSlotLimit', 'expectedUpdatedAtMs', 'realtimeEnabled']);
    if (typeof input.eligible !== 'boolean') throw invalid('$.eligible', '有償プランの対象状態を確認してください。');
    if (input.realtimeEnabled !== undefined && typeof input.realtimeEnabled !== 'boolean') throw invalid('$.realtimeEnabled', 'リアルタイム通知の対象状態を確認してください。');
    const special = bounded(input.specialSlotLimit, CAPACITY_LIMIT_MAX, '$.specialSlotLimit');
    const expected = bounded(input.expectedUpdatedAtMs, Number.MAX_SAFE_INTEGER - 2, '$.expectedUpdatedAtMs');
    // Serializes this configuration with ordinary plan edits/disable operations,
    // and uses the existing row's canonical ID without creating or replacing it.
    const plan = await existingPaidPlan(query, planId, true);
    const previous = (await query('SELECT * FROM automation_push_plan_policy WHERE plan_id=? FOR UPDATE', [plan.plan_id]))[0] || null;
    if (input.eligible && Number(plan.enabled) !== 1) throw invalid('$.eligible', '無効な有償プランはPush特殊枠の対象に設定できません。');
    const realtimeEnabled = input.realtimeEnabled === undefined ? Number(previous?.realtime_enabled) === 1 : input.realtimeEnabled;
    if (input.realtimeEnabled === true && Number(plan.enabled) !== 1) throw invalid('$.realtimeEnabled', '有効なプランでリアルタイム通知を設定してください。');
    const now = Math.max(Date.now(), expected + 1);
    if (expected === 0) {
        try {
            await query('INSERT INTO automation_push_plan_policy (plan_id,eligible,special_slot_limit,realtime_enabled,actor_user_id,updated_at_ms) VALUES (?,?,?,?,?,?)', [plan.plan_id, input.eligible ? 1 : 0, special, realtimeEnabled ? 1 : 0, actorId, now]);
        } catch (cause) { if (cause?.code === 'ER_DUP_ENTRY') throw conflict(); throw cause; }
    } else {
        const updated = await query('UPDATE automation_push_plan_policy SET eligible=?,special_slot_limit=?,realtime_enabled=?,actor_user_id=?,updated_at_ms=? WHERE plan_id=? AND updated_at_ms=?', [input.eligible ? 1 : 0, special, realtimeEnabled ? 1 : 0, actorId, now, plan.plan_id, expected]);
        if (!updated.affectedRows) throw conflict();
    }
    await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,\'x:plan-policy\',NULL,\'x.capacity.plan\',?,?)', [actorId,JSON.stringify({planId:plan.plan_id,before:previous?{eligible:Number(previous.eligible)===1,specialSlotLimit:Number(previous.special_slot_limit),realtimeEnabled:Number(previous.realtime_enabled)===1}:null,after:{eligible:input.eligible,specialSlotLimit:special,realtimeEnabled}}),now]);
    return planDto(plan, (await query('SELECT * FROM automation_push_plan_policy WHERE plan_id=?', [plan.plan_id]))[0]);
}
module.exports = { CAPACITY_LIMIT_MAX, DEFAULT_POOL_POLICY, requireAdmin, getPoolPolicy, savePoolPolicy, getPlanCapacity, savePlanCapacity };
