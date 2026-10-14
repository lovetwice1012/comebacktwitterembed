'use strict';

const { requireActor, AutomationError } = require('./service');
const entitlements = require('./entitlements');
const { evaluateXRollout, requireXEnrollment } = require('./x-rollout-policy');

const isMode = value => value === 'batch' || value === 'realtime';
const fail = (code, message, status = 422) => { throw new AutomationError(code, message, status); };

// One owner preference applies to every X subscription belonging to that owner.
// Only the current contract's explicit, administrator-managed flag grants
// realtime access. Plan names, prices, priorities, pool kinds and donor status
// cannot grant it. A requested preference survives a downgrade for later reuse.
async function inspectXProcessingSettings(query, userId, now = Date.now(), options = {}) {
    const plan = options.plan || await entitlements.inspectXPlan(query, userId, now, options);
    const owner = (await query('SELECT x_notification_processing_mode FROM users WHERE user_id=?', [String(userId)]))[0];
    const requestedMode = owner?.x_notification_processing_mode === 'realtime' ? 'realtime' : 'batch';
    const policy = (await query(`SELECT c.realtime_enabled,p.enabled FROM automation_push_plan_policy c
        JOIN automation_notification_plans p ON p.plan_id=c.plan_id WHERE c.plan_id=?`, [plan.planId]))[0];
    const realtimeAllowed = plan.tier === 'paid' && Number(policy?.realtime_enabled) === 1 && Number(policy?.enabled) === 1;
    const effectiveMode = requestedMode === 'realtime' && realtimeAllowed ? 'realtime' : 'batch';
    const intervalMinutes = plan.intervalMinutes ?? null;
    const configured = effectiveMode === 'realtime'
        || Number.isSafeInteger(intervalMinutes) && intervalMinutes >= 5 && intervalMinutes <= 10080;
    return { requestedMode, effectiveMode, realtimeAllowed, planId: plan.planId, planLabel: plan.label,
        intervalMinutes, configured, reasonCode: !configured ? 'X_MONITOR_NOT_CONFIGURED'
            : requestedMode === 'realtime' && !realtimeAllowed ? 'X_REALTIME_PLAN_REQUIRED' : null };
}

/**
 * Inspect one server-owned monitor using current database facts. This is read
 * only: runtime callers hold their owner fence and never allocate extra slots.
 * An absent per-monitor preference inherits the existing owner preference.
 */
async function inspectXMonitorProcessing(query, monitor, now = Date.now(), options = {}) {
    const owner = String(monitor?.owner_user_id || '');
    requireActor({ userId: owner });
    const preview = options.registrationPreview === true;
    const plan = options.plan || await entitlements.inspectXPlan(query, owner, now, options);
    const common = options.ownerSettings || await inspectXProcessingSettings(query, owner, now, { ...options, plan });
    let config;
    try { config = JSON.parse(monitor.notification_settings_json || '{}'); } catch { fail('X_MONITOR_INVALID_INPUT', '監視の通知設定を確認してください。', 503); }
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || config.processingMode !== undefined && !isMode(config.processingMode)) fail('X_MONITOR_INVALID_INPUT', '監視の通知方法を確認してください。', 503);
    const explicitMode = config.processingMode ?? null;
    const requestedMode = explicitMode || common.requestedMode;
    const slots = await query('SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [owner]);
    const boosts = await require('./monitor-cadence').boostRows(query, owner);
    const target = String(monitor.id || '');
    const own = preview ? [] : boosts.filter(row => row.target_kind === 'x' && String(row.target_id) === target);
    const primary = slots.find(row => row.target_kind === 'x' && String(row.target_id) === target);
    const occupied = new Set([...slots.filter(row => row.target_kind).map(row => Number(row.slot_index)), ...boosts.map(row => Number(row.slot_index))]);
    let vacant = 0;
    for (let index = 1; index <= plan.slotLimit; index++) if (!occupied.has(index)) vacant++;
    const validOwn = own.filter(row => Number(row.slot_index) >= 1 && Number(row.slot_index) <= plan.slotLimit
        && slots.some(slot => Number(slot.slot_index) === Number(row.slot_index) && !slot.target_kind));
    const validReserved = own.length === 4 && validOwn.length === 4 && new Set(own.map(row => Number(row.slot_index))).size === 4;
    const baseUsable = preview ? vacant > 0 : !!primary && Number(primary.slot_index) >= 1 && Number(primary.slot_index) <= plan.slotLimit && monitor.state !== 'deleted' && monitor.state !== 'suspended';
    const donor = (await query('SELECT is_donor FROM users WHERE user_id=?', [owner]))[0];
    const existingDonor = donor?.is_donor === 1 || donor?.is_donor === '1';
    let poolUsable = monitor.pool_kind === 'free';
    if (monitor.pool_kind === 'supporter') {
        const holding = await require('./push-support-grants').getSupporterHolding(query, owner, now);
        const rows = await query("SELECT id FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' AND pool_kind='supporter' ORDER BY id", [owner]);
        const rank = preview ? rows.length + 1 : rows.findIndex(row => String(row.id) === target) + 1 || (options.prospectivePool === true ? rows.length + 1 : 0);
        poolUsable = holding.isSupporter && rank > 0 && rank <= holding.totalSupporterSlots;
    } else if (monitor.pool_kind === 'special') {
        const policy = (await query(`SELECT c.special_slot_limit,c.eligible,p.enabled FROM automation_push_plan_policy c
            JOIN automation_notification_plans p ON p.plan_id=c.plan_id WHERE c.plan_id=?`, [plan.planId]))[0];
        const rows = await query("SELECT id FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' AND pool_kind='special' ORDER BY id", [owner]);
        const rank = preview ? rows.length + 1 : rows.findIndex(row => String(row.id) === target) + 1 || (options.prospectivePool === true ? rows.length + 1 : 0);
        poolUsable = plan.tier === 'paid' && Number(policy?.eligible) === 1 && Number(policy.enabled) === 1
            && Number.isSafeInteger(Number(policy.special_slot_limit)) && rank > 0 && rank <= Number(policy.special_slot_limit);
    }
    const noExtraSource = existingDonor && monitor.pool_kind === 'supporter' && poolUsable ? 'supporter' : common.realtimeAllowed ? 'plan' : null;
    const realtimeSlotCost = noExtraSource ? 1 : 5;
    const slotCost = preview ? requestedMode === 'realtime' ? realtimeSlotCost : 1 : 1 + own.length;
    const canEnableRealtime = baseUsable && poolUsable && (realtimeSlotCost === 1 || vacant + validOwn.length >= (preview ? 5 : 4));
    const source = (noExtraSource || (preview ? canEnableRealtime : validReserved)) ? noExtraSource || 'slots' : null;
    const effectiveMode = requestedMode === 'realtime' && baseUsable && poolUsable && source ? 'realtime' : 'batch';
    const configured = effectiveMode === 'realtime' || Number.isSafeInteger(plan.intervalMinutes) && plan.intervalMinutes >= 5 && plan.intervalMinutes <= 10080;
    return { requestedMode, explicitMode, modeSource: explicitMode === null ? 'owner' : 'monitor', effectiveMode,
        realtimeSource: effectiveMode === 'realtime' ? source : null, realtimeEligibilitySource: noExtraSource || (canEnableRealtime ? 'slots' : null),
        slotCost, effectiveSlotCost: effectiveMode === 'realtime' ? realtimeSlotCost : 1, realtimeSlotCost, canEnableRealtime,
        additionalSlotsNeeded: realtimeSlotCost === 1 ? 0 : Math.max(0, 4 - validOwn.length),
        planId: plan.planId, planLabel: plan.label, intervalMinutes: plan.intervalMinutes ?? null, configured,
        reasonCode: !configured ? 'X_MONITOR_NOT_CONFIGURED' : requestedMode === 'realtime' && effectiveMode !== 'realtime'
            ? !baseUsable || !poolUsable ? 'X_MONITOR_NOT_AVAILABLE' : canEnableRealtime ? 'X_REALTIME_ALLOCATION_REQUIRED' : 'X_REALTIME_SLOT_LIMIT' : null,
        ...(preview ? { isPreview: true } : {}) };
}

async function inspectXRegistrationProcessing(query, owner, poolKind, processingMode, now = Date.now(), options = {}) {
    if (processingMode !== undefined && !isMode(processingMode)) fail('X_MONITOR_INVALID_INPUT', '通知方法を選んでください。');
    return inspectXMonitorProcessing(query, { owner_user_id: owner, pool_kind: poolKind, state: 'ready',
        notification_settings_json: JSON.stringify(processingMode === undefined ? {} : { processingMode }) }, now, { ...options, registrationPreview: true });
}

function createXProcessingSettings(db, options = {}) {
    const clock = options.now || Date.now;
    const rolloutOptions = options.rolloutMode === undefined ? {} : { mode: options.rolloutMode };
    const inspectionOptions = { useLegacyUserInterval: options.useLegacyUserInterval === true };
    async function get(actor) {
        requireActor(actor);
        const rollout = await evaluateXRollout(db.queryDatabase, actor, rolloutOptions);
        const settings = await inspectXProcessingSettings(db.queryDatabase, actor.userId, clock(), inspectionOptions);
        return { ...settings, rollout };
    }
    async function save(actor, input) {
        requireActor(actor);
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some(key => !['mode', 'expectedMode'].includes(key))
            || !isMode(input.mode) || !isMode(input.expectedMode))
            fail('X_PROCESSING_INVALID_INPUT', '通知方法を選び、現在の設定を確認してください。');
        return db.withDatabaseTransaction(async query => {
            await entitlements.lockOwner(query, actor.userId);
            // Returning to ordinary batching is an owner cleanup operation,
            // including after plan eligibility or rollout access is revoked.
            if (input.mode === 'realtime') await requireXEnrollment(query, actor, rolloutOptions);
            const before = await inspectXProcessingSettings(query, actor.userId, clock(), inspectionOptions);
            if (before.requestedMode !== input.expectedMode)
                fail('X_PROCESSING_CONFLICT', '通知方法が更新されています。最新の設定を読み直してください。', 409);
            if (input.mode === 'realtime' && !before.realtimeAllowed)
                fail('X_REALTIME_PLAN_REQUIRED', 'リアルタイム通知は、対応するプランで選べます。', 403);
            if (before.requestedMode !== input.mode) {
                const changed = await query('UPDATE users SET x_notification_processing_mode=? WHERE user_id=? AND x_notification_processing_mode=?',
                    [input.mode, actor.userId, input.expectedMode]);
                if (Number(changed.affectedRows) !== 1)
                    fail('X_PROCESSING_CONFLICT', '通知方法が更新されています。最新の設定を読み直してください。', 409);
                await query(`INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms)
                    VALUES (?,'x:processing-settings',NULL,'x.processing.mode',?,?)`,
                [actor.userId, JSON.stringify({ before: before.requestedMode, after: input.mode }), clock()]);
            }
            const rollout = await evaluateXRollout(query, actor, rolloutOptions);
            return { ...await inspectXProcessingSettings(query, actor.userId, clock(), inspectionOptions), rollout };
        });
    }
    return { get, save };
}

module.exports = { inspectXProcessingSettings, inspectXMonitorProcessing, inspectXRegistrationProcessing, createXProcessingSettings };
