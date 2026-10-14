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

module.exports = { inspectXProcessingSettings, createXProcessingSettings };
