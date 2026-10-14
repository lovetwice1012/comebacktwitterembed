'use strict';

const { AutomationError, requireActor } = require('./service');

const DISABLED_REASON = 'X通知の新規登録は、提供準備のため停止しています。';
const SUPPORTERS_REASON = 'X通知は既存の寄付者向け先行提供中です。一般公開までお待ちください。';

/** @param {import('./x-rollout-policy').XRolloutOptions} options */
function rolloutMode(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return 'disabled';
    // Options are trusted server configuration. Request bodies and actor fields
    // must never be passed here as rollout configuration.
    const configured = Object.hasOwn(options, 'mode') ? options.mode : process.env.X_NOTIFICATION_ROLLOUT;
    return configured === 'supporters' || configured === 'public' ? configured : 'disabled';
}

/**
 * Checks access to the rollout only. Eligibility grants neither a reservation
 * nor delivery; capacity, subscription readiness and delivery checks remain separate.
 * @param {import('./x-rollout-policy').XRolloutQuery} query
 * @param {import('./x-rollout-policy').XRolloutActor} actor
 * @param {import('./x-rollout-policy').XRolloutOptions} [options]
 * @returns {Promise<import('./x-rollout-policy').XRolloutDecision>}
 */
async function evaluateXRollout(query, actor, options = {}) {
    requireActor(actor);
    const mode = rolloutMode(options);
    if (mode === 'disabled') return { mode, eligible: false, reasonCode: 'X_ROLLOUT_DISABLED', reason: DISABLED_REASON };
    if (mode === 'public') return { mode, eligible: true, reasonCode: null, reason: null };

    // This is the existing reviewed donor flag, not plan quality, purchased
    // credits or a new payment. Do not infer a beta cohort or cutoff timestamp.
    // Database failures propagate so callers can return their safe generic 503.
    const rows = await query('SELECT is_donor FROM users WHERE user_id=?', [String(actor.userId)]);
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const eligible = row?.is_donor === 1 || row?.is_donor === '1';
    return eligible ? { mode, eligible: true, reasonCode: null, reason: null }
        : { mode, eligible: false, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY', reason: SUPPORTERS_REASON };
}

/**
 * Enrollment/activation guard. Keep owner status, stop and deletion operations
 * outside this guard so rollout closure does not prevent cleanup.
 * @param {import('./x-rollout-policy').XRolloutQuery} query
 * @param {import('./x-rollout-policy').XRolloutActor} actor
 * @param {import('./x-rollout-policy').XRolloutOptions} [options]
 * @returns {Promise<import('./x-rollout-policy').XRolloutDecision>}
 */
async function requireXEnrollment(query, actor, options = {}) {
    const decision = await evaluateXRollout(query, actor, options);
    if (!decision.eligible) throw new AutomationError(decision.reasonCode, decision.reason,
        decision.reasonCode === 'X_ROLLOUT_DISABLED' ? 503 : 403);
    return decision;
}

module.exports = { evaluateXRollout, requireXEnrollment };
