'use strict';
const { randomBytes } = require('node:crypto');
const { AutomationError, requireActor } = require('./service');
const entitlements = require('./entitlements');
const capacity = require('./push-capacity');
const grants = require('./push-support-grants');
const processing = require('./x-processing-settings');
const { evaluateXRollout, requireXEnrollment } = require('./x-rollout-policy');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function fail(code, message, status = 422) { throw new AutomationError(code, message, status); }
function id(value) { if (!/^\d{1,20}$/.test(String(value || ''))) fail('NOT_FOUND', '監視登録が見つかりません。', 404); return String(value); }
function strict(input, keys) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) fail('X_MONITOR_INVALID_INPUT', '指定できない監視設定が含まれています。');
}
/** @returns {{workflowId?:string,destinationId?:string,subscriptionId?:string,processingMode?:'batch'|'realtime'}} */
function settings(value = {}) {
    strict(value, ['workflowId', 'destinationId', 'subscriptionId', 'processingMode']);
    for (const key of Object.keys(value)) if (key === 'processingMode' ? !['batch', 'realtime'].includes(value[key]) : typeof value[key]!=='string' || !UUID.test(value[key])) fail('X_MONITOR_INVALID_INPUT', '既存のルール・通知先と通知方法を指定してください。');
    return { ...value };
}
function inputSettings(value = {}) {
    strict(value, ['workflowId', 'destinationId', 'subscriptionId']);
    return settings(value);
}
function modeInput(input) {
    if (input.processingMode !== undefined && !['batch','realtime'].includes(input.processingMode)) fail('X_MONITOR_INVALID_INPUT','通知方法を選んでください。');
    if (input.processingMode === 'realtime' && ![1,5].includes(input.expectedRealtimeSlotCost)
        || input.expectedRealtimeSlotCost !== undefined && ![1,5].includes(input.expectedRealtimeSlotCost)) fail('X_MONITOR_INVALID_INPUT','リアルタイム通知に使用する枠数を確認してください。');
}
function inputOf(input) {
    strict(input, ['accountId', 'accountHandle', 'name', 'notificationSettings', 'processingMode', 'expectedRealtimeSlotCost', 'poolPreference']);
    modeInput(input);
    if (input.poolPreference !== undefined && !['auto', 'supporter'].includes(input.poolPreference)
        || input.poolPreference === 'supporter' && input.processingMode !== 'realtime') fail('X_MONITOR_INVALID_INPUT', '支援者優先枠は、リアルタイム通知を選んで登録してください。');
    if (input.accountId !== undefined && (typeof input.accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(input.accountId))) fail('X_MONITOR_INVALID_INPUT', 'XアカウントIDを確認してください。');
    const accountHandle = handleOf(input.accountHandle);
    if (input.accountId === undefined && accountHandle === null) fail('X_MONITOR_INVALID_INPUT', '通知を受け取りたい相手の@ユーザー名を入力してください。');
    const name = input.name ?? accountHandle ?? input.accountId;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) fail('X_MONITOR_INVALID_INPUT', '監視の名前は1〜120文字で指定してください。');
    // Handle-based registration has no verified numeric X ID. Keep an opaque
    // server-only key in the existing column; reservations use the monitor ID.
    return { accountId: input.accountId ?? `h:${randomBytes(9).toString('hex')}`, accountHandle, name: name.trim(), notificationSettings: inputSettings(input.notificationSettings) };
}
function handleOf(value) {
    if (value == null) return null;
    if (typeof value !== 'string') fail('X_MONITOR_INVALID_INPUT', '通知を受け取りたい相手の@ユーザー名を確認してください。');
    const handle = value.replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || /^(?:i|intent)$/i.test(handle)) fail('X_MONITOR_INVALID_INPUT', '通知を受け取りたい相手の@ユーザー名を確認してください。');
    return handle;
}
const count = rows => Number(rows[0]?.n || 0);
function createXMonitorQuota(db, options = {}) {
    const now = options.now || Date.now;
    const enabled = options.registrationEnabled === true;
    const rolloutOptions = options.rolloutMode === undefined ? {} : { mode: options.rolloutMode };
    const quality = plan => ({ planId: plan.planId, priority: plan.priority, minuteLimit: plan.minuteLimit, dayLimit: plan.dayLimit, intervalMinutes: plan.intervalMinutes });
    async function audit(query, actor, target, action, detail = {}) {
        await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,?,NULL,?,?,?)', [actor.userId, `x:${target}`, action, JSON.stringify(detail), now()]);
    }
    async function lockGlobal(query, actor) {
        // All X transactions lock global first, then owner. Ordinary target
        // transactions lock owner only and never acquire this global lock.
        await query('INSERT INTO automation_push_pool_policy (id,free_pool_limit,supporter_pool_limit,actor_user_id,updated_at_ms) VALUES (1,50,100,?,?) ON DUPLICATE KEY UPDATE id=id', [actor.userId, now()]);
        await query('SELECT id FROM automation_push_pool_policy WHERE id=1 FOR UPDATE');
    }
    async function rowsFor(query, owner) { return query("SELECT * FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' ORDER BY id", [owner]); }
    async function pools(query, locked = false) {
        const row = (await query(`SELECT * FROM automation_push_pool_policy WHERE id=1${locked ? ' FOR UPDATE' : ''}`))[0];
        const used = locked ? await query("SELECT id,pool_kind FROM automation_x_monitors WHERE state<>'deleted' AND pool_kind IS NOT NULL FOR UPDATE")
            : await query("SELECT pool_kind,COUNT(*) n FROM automation_x_monitors WHERE state<>'deleted' AND pool_kind IS NOT NULL GROUP BY pool_kind");
        const validLimit = value => { const limit=Number(value); return Number.isSafeInteger(limit)&&limit>=0&&limit<=capacity.CAPACITY_LIMIT_MAX ? limit : 0; };
        const policy = row ? { freePoolLimit: validLimit(row.free_pool_limit), supporterPoolLimit: validLimit(row.supporter_pool_limit) } : capacity.DEFAULT_POOL_POLICY;
        const field = (kind, limit) => { const consumed = locked ? used.filter(item => item.pool_kind === kind).length : Number(used.find(item => item.pool_kind === kind)?.n || 0); return { limit, used: consumed, available: Math.max(0, limit - consumed) }; };
        return { free: field('free', policy.freePoolLimit), supporter: field('supporter', policy.supporterPoolLimit) };
    }
    async function paidLimit(query, plan) {
        if (plan.tier !== 'paid') return 0;
        const rows = await query(`SELECT c.special_slot_limit,c.eligible,p.enabled FROM automation_push_plan_policy c
            JOIN automation_notification_plans p ON p.plan_id=c.plan_id WHERE c.plan_id=?`, [plan.planId]);
        const row = rows[0], value = Number(row?.special_slot_limit);
        return row && Number(row.eligible) === 1 && Number(row.enabled) === 1 && Number.isSafeInteger(value) && value >= 0 && value <= capacity.CAPACITY_LIMIT_MAX ? value : 0;
    }
    async function planFor(query, owner) { return entitlements.inspectXPlan(query, owner, now(), { useLegacyUserInterval: options.useLegacyUserInterval === true }); }
    async function supportFor(query, owner) { return grants.getSupporterHolding(query, owner, now()); }
    async function isLegacyDonor(query, owner) { return Number((await query('SELECT is_donor FROM users WHERE user_id=?', [owner]))[0]?.is_donor) === 1; }
    async function choosePool(query, owner, plan, locked = true) {
        const shared = await pools(query, locked);
        if (shared.free.available > 0) return 'free';
        const support = await supportFor(query, owner);
        const supportUsed = count(await query("SELECT COUNT(*) n FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' AND pool_kind='supporter'", [owner]));
        if (support.isSupporter && supportUsed < support.totalSupporterSlots && shared.supporter.available > 0) return 'supporter';
        const specialUsed = count(await query("SELECT COUNT(*) n FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' AND pool_kind='special'", [owner]));
        if (specialUsed < await paidLimit(query, plan)) return 'special';
        return null;
    }
    async function verifySettings(query, actor, config) {
        for (const [key, table] of [['workflowId','automation_workflows'],['destinationId','automation_destinations']]) if (config[key]) {
            const rows = await query(`SELECT id FROM ${table} WHERE id=? AND owner_user_id=? AND scope='private' AND deleted_at_ms IS NULL`, [config[key], actor.userId]);
            if (!rows.length) fail('NOT_FOUND', '自分のルール・通知先を指定してください。', 404);
        }
        if (config.subscriptionId) {
            const rows = await query('SELECT id FROM automation_x_subscriptions WHERE id=? AND owner_user_id=?', [config.subscriptionId, actor.userId]);
            if (!rows.length) fail('NOT_FOUND', '自分の登録済み受信情報を指定してください。', 404);
        }
    }
    async function item(row, plan, query = db.queryDatabase) {
        const config = settings(JSON.parse(row.notification_settings_json));
        // Read-only owner-scoped status; do not take resource locks while
        // serializing allocation/update results or expose foreign metadata.
        const readiness = config.workflowId || config.destinationId ? (await query(`SELECT
            CASE WHEN ? IS NULL THEN NULL WHEN w.id IS NULL OR w.deleted_at_ms IS NOT NULL THEN 'missing'
                WHEN w.active_revision IS NULL THEN 'unapplied' WHEN r.workflow_id IS NULL THEN 'missing'
                WHEN w.enabled<>1 THEN 'paused' ELSE 'active' END AS workflow_status,
            CASE WHEN ? IS NULL THEN NULL WHEN d.id IS NULL OR d.deleted_at_ms IS NOT NULL
                OR (d.kind='dm' AND d.dm_user_id<>?) THEN 'missing'
                WHEN d.enabled<>1 THEN 'paused' ELSE 'active' END AS destination_status
            FROM (SELECT 1) seed
            LEFT JOIN automation_workflows w ON w.id=? AND w.owner_user_id=? AND w.scope='private'
            LEFT JOIN automation_revisions r ON r.workflow_id=w.id AND r.revision=w.active_revision
            LEFT JOIN automation_destinations d ON d.id=? AND d.owner_user_id=? AND d.scope='private'`,
        [config.workflowId || null, config.destinationId || null, row.owner_user_id, config.workflowId || null, row.owner_user_id, config.destinationId || null, row.owner_user_id]))[0] : null;
        return { id: String(row.id), accountId: /^[1-9]\d{0,19}$/.test(row.account_id) ? row.account_id : null, accountHandle: row.account_handle, name: row.name,
        enabled: Number(row.enabled) === 1, state: row.state, poolKind: row.pool_kind, notificationSettings: config,
        workflowStatus: readiness?.workflow_status ?? (config.workflowId ? 'unknown' : null), destinationStatus: readiness?.destination_status ?? (config.destinationId ? 'unknown' : null),
        subscriptionState: row.subscription_state, revision: Number(row.revision), quality: quality(plan), processing: await processing.inspectXMonitorProcessing(query, row, now(), { plan }),
        supporterRealtimeProcessing: await supporterMonitorProcessing(query, row, plan) }; }
    async function getRow(query, actor, target, includeDeleted = false) {
        const row = (await query(`SELECT * FROM automation_x_monitors WHERE id=? AND owner_user_id=?${includeDeleted ? '' : " AND state<>'deleted'"}`, [id(target), actor.userId]))[0];
        if (!row) fail('NOT_FOUND', '監視登録が見つかりません。', 404); return row;
    }
    async function reserveProcessingSlots(query, owner, target, cost) {
        const previous = (await query("SELECT updated_at_ms FROM automation_monitor_cadence WHERE owner_user_id=? AND target_kind='x' AND target_id=? FOR UPDATE", [owner, String(target)]))[0];
        return require('./monitor-cadence').reserve(query, owner, 'x', String(target), { slotCost: cost, expectedUpdatedAtMs: previous ? Number(previous.updated_at_ms) : null });
    }
    function confirmRealtimeCost(input, decision) {
        if (input.expectedRealtimeSlotCost !== decision.realtimeSlotCost) fail('X_REALTIME_COST_CONFLICT','リアルタイム通知に必要な枠数が変わりました。現在の見積もりを確認してから保存してください。',409);
        if (!decision.canEnableRealtime) fail(decision.reasonCode === 'X_MONITOR_NOT_AVAILABLE' ? 'X_MONITOR_NOT_AVAILABLE' : 'X_REALTIME_SLOT_LIMIT','リアルタイム通知に必要な利用資格と個人の空き枠を確認してください。');
    }
    async function supporterMonitorProcessing(query, row, plan) {
        const actor = { userId: row.owner_user_id }, support = await supportFor(query, actor.userId);
        const targets = await rowsFor(query, actor.userId);
        // Item serialization is also used by read-only administration. Inspect
        // raw reservations here instead of the adoption/reconciliation API.
        const slots = await query('SELECT slot_index,target_kind,target_id FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [actor.userId]);
        const boosts = await require('./monitor-cadence').boostRows(query, actor.userId);
        const supportUsed = targets.filter(value => value.pool_kind === 'supporter' && String(value.id) !== String(row.id)).length;
        const supportRank = targets.filter(value => value.pool_kind === 'supporter').findIndex(value => String(value.id) === String(row.id)) + 1;
        const supportExhausted = row.pool_kind === 'supporter' ? supportRank < 1 || supportRank > support.totalSupporterSlots : supportUsed >= support.totalSupporterSlots;
        const shared = await pools(query), rollout = await evaluateXRollout(query, actor, rolloutOptions);
        const decision = await processing.inspectXMonitorProcessing(query, { ...row, pool_kind: 'supporter', state: 'ready',
            notification_settings_json: JSON.stringify({ ...settings(JSON.parse(row.notification_settings_json)), processingMode: 'realtime' }) }, now(), { plan, prospectivePool: true });
        // This is an edit quote, so the existing primary reservation counts as
        // held. A full personal allowance must not require a second base slot.
        const slot = slots.find(value => value.target_kind === 'x' && String(value.target_id) === String(row.id));
        const eligible = await isLegacyDonor(query, actor.userId) && support.isSupporter && support.totalSupporterSlots > 0;
        const releasedExtras = Math.max(0, decision.slotCost - 1);
        const reasonCode = !enabled ? 'X_MONITOR_UNAVAILABLE' : !rollout.eligible ? rollout.reasonCode
            : !eligible ? 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE'
                : !slot || Number(slot.slot_index) > plan.slotLimit || slots.filter(value => value.target_kind).length + boosts.length - releasedExtras > plan.slotLimit ? 'X_MONITOR_PERSONAL_LIMIT'
                    : supportExhausted ? 'X_MONITOR_SUPPORTER_LIMIT'
                        : row.pool_kind !== 'supporter' && shared.supporter.available === 0 ? 'X_MONITOR_SUPPORTER_POOL_FULL'
                            : !decision.canEnableRealtime ? 'X_MONITOR_NOT_AVAILABLE' : null;
        const available = !reasonCode;
        const reason = reasonCode === 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE' ? '対象の既存支援者は、支援者特典を利用できます。'
            : reasonCode === 'X_MONITOR_PERSONAL_LIMIT' ? '個人の総登録上限を確認してください。'
                : reasonCode === 'X_MONITOR_SUPPORTER_LIMIT' ? '保有する支援者追加枠をすべて使用しています。'
                    : reasonCode === 'X_MONITOR_SUPPORTER_POOL_FULL' ? '支援者優先枠は現在満杯です。空きができると利用できます。'
                        : reasonCode === 'X_MONITOR_UNAVAILABLE' ? 'X通知の設定受付を準備しています。'
                            : !rollout.eligible ? rollout.reason : null;
        return { ...decision, isPreview: true, poolKind: 'supporter', eligible, available, canEnableRealtime: available, reasonCode, reason };
    }
    async function validatePoolChange(query, row, selected, plan, desiredCost) {
        const personal = await entitlements.listOwnerSlots(query, row.owner_user_id);
        const slot = personal.slots.find(value => value.targetKind === 'x' && value.targetId === String(row.id));
        const extras = count(await query("SELECT COUNT(*) n FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind='x' AND target_id=?", [row.owner_user_id, String(row.id)]));
        if (!slot || slot.slotIndex > plan.slotLimit || personal.usedSlots - extras + desiredCost - 1 > plan.slotLimit)
            fail('X_MONITOR_PERSONAL_LIMIT', '個人の総登録上限を確認してください。');
        const targets = await rowsFor(query, row.owner_user_id);
        const owned = targets.filter(value => value.pool_kind === selected && String(value.id) !== String(row.id)).length;
        const rank = targets.filter(value => value.pool_kind === selected).findIndex(value => String(value.id) === String(row.id)) + 1;
        if (selected === 'supporter') {
            const support = await supportFor(query, row.owner_user_id);
            if (!support.isSupporter || (selected === row.pool_kind ? rank < 1 || rank > support.totalSupporterSlots : owned >= support.totalSupporterSlots)) fail('X_MONITOR_DESTINATION_INELIGIBLE', '保有する支援者追加枠を確認してください。');
        } else if (selected === 'special') {
            const limit = await paidLimit(query, plan);
            if (selected === row.pool_kind ? rank < 1 || rank > limit : owned >= limit) fail('X_MONITOR_DESTINATION_INELIGIBLE', '現在の契約プランで利用できる特殊枠を確認してください。');
        }
        const shared = await pools(query, true);
        if (selected !== row.pool_kind && selected !== 'special' && shared[selected].available <= 0)
            fail('X_MONITOR_DESTINATION_FULL', '移動先の枠が満杯です。現在の登録は保持されています。', 409);
    }
    async function supporterRegistration(query, actor, plan, shared, support, supportUsed, personalAvailable, rollout) {
        const decision = await processing.inspectXRegistrationProcessing(query, actor.userId, 'supporter', 'realtime', now(), { plan });
        const eligible = await isLegacyDonor(query, actor.userId) && support.isSupporter && support.totalSupporterSlots > 0;
        const reasonCode = !enabled ? 'X_MONITOR_UNAVAILABLE' : !rollout.eligible ? rollout.reasonCode
            : !eligible ? 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE' : personalAvailable === 0 ? 'X_MONITOR_PERSONAL_LIMIT'
                : supportUsed >= support.totalSupporterSlots ? 'X_MONITOR_SUPPORTER_LIMIT'
                    : shared.supporter.available === 0 ? 'X_MONITOR_SUPPORTER_POOL_FULL' : decision.reasonCode;
        const available = !reasonCode && decision.canEnableRealtime;
        const reason = reasonCode === 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE' ? '支援者優先枠でのリアルタイム通知は、対象の既存支援者が利用できます。'
            : reasonCode === 'X_MONITOR_PERSONAL_LIMIT' ? '個人の総登録上限に達しています。登録中の通知を確認してください。'
                : reasonCode === 'X_MONITOR_SUPPORTER_LIMIT' ? '保有する支援者追加枠をすべて使用しています。'
                    : reasonCode === 'X_MONITOR_SUPPORTER_POOL_FULL' ? '支援者優先枠は現在満杯です。空きができると登録できます。'
                        : reasonCode === 'X_MONITOR_UNAVAILABLE' ? 'X通知の登録受付を準備しています。'
                            : !rollout.eligible ? rollout.reason : null;
        return { ...decision, poolKind: 'supporter', eligible, available, canEnableRealtime: available, reasonCode, reason };
    }
    async function chooseSupporterRegistration(query, actor) {
        if (!await isLegacyDonor(query, actor.userId)) fail('X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE', '支援者優先枠でのリアルタイム通知は、対象の既存支援者が利用できます。', 403);
        const support = await supportFor(query, actor.userId);
        const supportUsed = count(await query("SELECT COUNT(*) n FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' AND pool_kind='supporter'", [actor.userId]));
        if (!support.isSupporter || supportUsed >= support.totalSupporterSlots) fail('X_MONITOR_SUPPORTER_LIMIT', '保有する支援者追加枠をすべて使用しています。');
        if ((await pools(query, true)).supporter.available === 0) fail('X_MONITOR_SUPPORTER_POOL_FULL', '支援者優先枠は現在満杯です。空きができると登録できます。', 409);
        return 'supporter';
    }
    async function duplicateRegistration(query, actor, input, row) {
        const result = await item(row, await planFor(query, actor.userId), query);
        if (input.poolPreference === 'supporter') {
            // A retried create is idempotent only for the same explicit choice.
            // Never turn a duplicate request into an implicit pool move or edit.
            if (row.pool_kind !== 'supporter' || result.processing.explicitMode !== 'realtime') fail('X_MONITOR_REGISTRATION_CONFLICT', 'このXアカウントは登録済みです。一覧から枠と通知方法を変更してください。', 409);
            if (!await isLegacyDonor(query, actor.userId) || result.processing.realtimeEligibilitySource !== 'supporter') fail('X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE', '支援者優先枠でのリアルタイム通知を利用する資格を確認してください。', 403);
            confirmRealtimeCost(input, result.processing);
        }
        return result;
    }
    async function quota(query, actor) {
        const plan = await planFor(query, actor.userId), shared = await pools(query), support = await supportFor(query, actor.userId);
        const personal = await entitlements.listOwnerSlots(query, actor.userId);
        const targets = await rowsFor(query, actor.userId), specialLimit = await paidLimit(query, plan);
        const specialUsed = targets.filter(row => row.pool_kind === 'special').length;
        const supportUsed = targets.filter(row => row.pool_kind === 'supporter').length;
        const totalLimit = plan.slotLimit, available = Math.max(0, totalLimit - personal.usedSlots);
        const poolAvailable = shared.free.available + (support.isSupporter ? Math.min(shared.supporter.available, Math.max(0, support.totalSupporterSlots - supportUsed)) : 0) + Math.max(0, specialLimit - specialUsed);
        const rollout = await evaluateXRollout(query, actor, rolloutOptions);
        const reasonCode = !enabled ? 'X_MONITOR_UNAVAILABLE' : !rollout.eligible ? rollout.reasonCode : available === 0 ? 'X_MONITOR_PERSONAL_LIMIT' : poolAvailable === 0 ? 'X_MONITOR_POOL_FULL' : null;
        const reason = reasonCode === 'X_MONITOR_UNAVAILABLE' ? '実通知の受信・復号を検証中のため、新しいX自動展開の登録はまだ受け付けていません。'
            : reasonCode === 'X_MONITOR_PERSONAL_LIMIT' ? '個人の総登録上限に達しています。通常通知とX監視で枠を共有しています。'
                : reasonCode === 'X_MONITOR_POOL_FULL' ? '利用できる自動展開枠が満杯です。既存の通知は保持されています。' : null;
        const registrationPool = await choosePool(query, actor.userId, plan, false);
        const registrationProcessing = await processing.inspectXRegistrationProcessing(query, actor.userId, registrationPool, 'realtime', now(), { plan });
        const supporterRealtimeRegistration = await supporterRegistration(query, actor, plan, shared, support, supportUsed, available, rollout);
        return { featureEnabled: enabled && rollout.eligible, rollout, currentPlan: { planId: plan.planId, label: plan.label, tier: plan.tier, baseSlotLimit: plan.baseSlotLimit, ...quality(plan) },
            personal: { totalLimit, used: personal.usedSlots, registeredCount: personal.slots.length, available, supporterExtraSlots: totalLimit - plan.baseSlotLimit },
            x: { used: targets.length, available: enabled && rollout.eligible ? Math.min(available, poolAvailable) : 0, reasonCode, reason: rollout.eligible || !enabled ? reason : rollout.reason, specialLimit, specialUsed }, pools: shared,
            registrationProcessing: { ...registrationProcessing, poolKind: registrationPool, canEnableRealtime: enabled && rollout.eligible && registrationProcessing.canEnableRealtime,
                reasonCode: reasonCode || registrationProcessing.reasonCode }, supporterRealtimeRegistration };
    }
    async function reconcileRows(query, actor, owners) {
        for (const owner of [...new Set(owners)].sort()) {
            await entitlements.lockOwner(query, owner);
            const plan = await planFor(query, owner);
            const personal = await entitlements.listOwnerSlots(query, owner);
            const targets = await rowsFor(query, owner);
            const supporter = await supportFor(query,owner), specialLimit=await paidLimit(query,plan);
            let supportRank=0, specialRank=0;
            for (const row of targets) {
                const slot = personal.slots.find(value => value.targetKind === 'x' && value.targetId === String(row.id));
                const poolEligible = row.pool_kind==='free' || row.pool_kind==='supporter' && supporter.isSupporter && ++supportRank<=supporter.totalSupporterSlots
                    || row.pool_kind==='special' && ++specialRank<=specialLimit;
                const selectedState = slot && slot.slotIndex<=plan.slotLimit && poolEligible ? 'ready' : 'suspended';
                if (row.state!==selectedState) {
                    // Qualification changes can stop use but never change the
                    // reservation. Only explicit move/release changes pool_kind.
                    await query('UPDATE automation_x_monitors SET state=?,revision=revision+1,updated_at_ms=? WHERE id=?',[selectedState,now(),row.id]);
                    await audit(query,actor,row.id,'x.quota.qualification',{poolKind:row.pool_kind,state:selectedState});
                }
            }
        }
    }
    async function allOwners(query) { return (await query("SELECT DISTINCT owner_user_id FROM automation_x_monitors WHERE state<>'deleted' ORDER BY owner_user_id")).map(row => row.owner_user_id); }
    async function register(actor, input) {
        requireActor(actor);
        if (!enabled) fail('X_MONITOR_UNAVAILABLE', '新しいX自動展開は実通知検証待ちで、登録受付を開始していません。', 503);
        const parsed = inputOf(input);
        return db.withDatabaseTransaction(async query => {
            await lockGlobal(query, actor); await entitlements.lockOwner(query, actor.userId);
            await requireXEnrollment(query, actor, rolloutOptions);
            await grants.migrateLegacyGrants(query, actor.userId, { now: now() });
            await verifySettings(query, actor, parsed.notificationSettings);
            const existing = (await query('SELECT * FROM automation_x_monitors WHERE owner_user_id=? AND account_id=?', [actor.userId, parsed.accountId]))[0];
            if (existing && existing.state !== 'deleted') return duplicateRegistration(query, actor, input, existing);
            // All registrations/edits hold global->owner locks, so matching a
            // current handle here is atomic even across legacy numeric rows.
            const sameHandle = parsed.accountHandle && (await query("SELECT * FROM automation_x_monitors WHERE owner_user_id=? AND LOWER(account_handle)=? AND state<>'deleted' ORDER BY id LIMIT 1", [actor.userId, parsed.accountHandle.toLowerCase()]))[0];
            if (sameHandle) {
                if (input.accountId !== undefined && /^[1-9]\d{0,19}$/.test(sameHandle.account_id) && sameHandle.account_id !== input.accountId) fail('X_MONITOR_HANDLE_CONFLICT', '同じ@ユーザー名の監視が登録されています。一覧から編集してください。', 409);
                return duplicateRegistration(query, actor, input, sameHandle);
            }
            const before = await quota(query, actor);
            if (!before.personal.available) fail('X_MONITOR_PERSONAL_LIMIT', '個人の総登録上限に達しています。通常通知とX監視で枠を共有しています。');
            // Automatic allocation stays free-first. The verified legacy donor
            // can explicitly request their one-slot realtime supporter benefit.
            // That request never falls back to a different pool or five slots.
            const plan = await planFor(query, actor.userId), selected = input.poolPreference === 'supporter'
                ? await chooseSupporterRegistration(query, actor) : await choosePool(query, actor.userId, plan);
            if (!selected) fail('X_MONITOR_POOL_FULL', '利用できる自動展開枠が満杯です。個人の残り枠はあります。');
            let desiredCost = 1;
            if (input.processingMode === 'realtime') {
                const decision = await processing.inspectXRegistrationProcessing(query, actor.userId, selected, 'realtime', now(), { plan });
                confirmRealtimeCost(input, decision); desiredCost = decision.realtimeSlotCost;
            }
            if (input.processingMode !== undefined) parsed.notificationSettings.processingMode = input.processingMode;
            let target;
            if (existing) {
                target = existing.id;
                await query("UPDATE automation_x_monitors SET account_handle=?,name=?,enabled=1,state='ready',pool_kind=?,notification_settings_json=?,subscription_state=?,revision=revision+1,updated_at_ms=? WHERE id=?", [parsed.accountHandle, parsed.name, selected, JSON.stringify(parsed.notificationSettings), parsed.notificationSettings.subscriptionId ? 'bound' : 'pending', now(), target]);
            } else {
                const result = await query("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,1,'ready',?,?,?,1,?,?)", [actor.userId, parsed.accountId, parsed.accountHandle, parsed.name, selected, JSON.stringify(parsed.notificationSettings), parsed.notificationSettings.subscriptionId ? 'bound' : 'pending', now(), now()]);
                target = result.insertId;
            }
            await entitlements.assignSlot(query, actor.userId, 'x', String(target));
            if (input.processingMode !== undefined) await reserveProcessingSlots(query, actor.userId, target, desiredCost);
            await audit(query, actor, target, 'x.quota.allocate', { poolKind: selected, slotCost: desiredCost, allocationPreference: input.poolPreference || 'auto', ...(input.processingMode === undefined ? {} : { processingMode: input.processingMode }) });
            return item(await getRow(query, actor, target), plan, query);
        });
    }
    async function update(actor, target, input) {
        requireActor(actor); strict(input, ['expectedRevision','enabled','name','accountHandle','notificationSettings','processingMode','expectedRealtimeSlotCost','poolKind']);
        modeInput(input);
        if (input.poolKind !== undefined && !['free', 'supporter', 'special'].includes(input.poolKind)) fail('X_MONITOR_INVALID_INPUT', '利用する枠の種類を選んでください。');
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('X_MONITOR_REVISION_CONFLICT', '最新の監視設定を読み直してください。', 409);
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('X_MONITOR_INVALID_INPUT', '監視の状態を確認してください。');
        if (input.enabled === true && !enabled) fail('X_MONITOR_UNAVAILABLE', '新しいX自動展開は提供準備中です。', 503);
        if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)) fail('X_MONITOR_INVALID_INPUT', '監視の名前を確認してください。');
        const parsedHandle = input.accountHandle === undefined ? undefined : handleOf(input.accountHandle);
        if (input.notificationSettings !== undefined) inputSettings(input.notificationSettings);
        return db.withDatabaseTransaction(async query => {
            await lockGlobal(query, actor); await entitlements.lockOwner(query, actor.userId);
            let row = await getRow(query, actor, target);
            if (Number(row.revision) !== input.expectedRevision) fail('X_MONITOR_REVISION_CONFLICT', '監視が変更されています。再取得してください。', 409);
            const poolChanged = input.poolKind !== undefined && input.poolKind !== row.pool_kind;
            if (poolChanged && input.processingMode === undefined) fail('X_MONITOR_INVALID_INPUT', '枠の変更と一緒に通知タイミングを選んでください。');
            if (input.notificationSettings) await verifySettings(query, actor, input.notificationSettings);
            if (input.enabled === true) {
                await requireXEnrollment(query, actor, rolloutOptions);
                if (!poolChanged) {
                    await reconcileRows(query, actor, [actor.userId]);
                    const current = await getRow(query, actor, target);
                    if (current.state !== 'ready') fail('X_MONITOR_POOL_FULL', '現在の資格と空き枠では監視を再開できません。');
                    row = current;
                }
            }
            const plan = await planFor(query, actor.userId), selectedPool = input.poolKind ?? row.pool_kind;
            const oldSettings = settings(JSON.parse(row.notification_settings_json));
            const nextSettings = input.notificationSettings === undefined ? { ...oldSettings } : { ...inputSettings(input.notificationSettings),
                ...(oldSettings.processingMode === undefined ? {} : { processingMode: oldSettings.processingMode }) };
            let beforeProcessing, afterSlotCost;
            if (input.processingMode !== undefined) {
                beforeProcessing = await processing.inspectXMonitorProcessing(query, row, now(), { plan });
                const future = poolChanged ? await processing.inspectXMonitorProcessing(query, { ...row, pool_kind: selectedPool, state: 'ready' }, now(), { plan, prospectivePool: true }) : beforeProcessing;
                afterSlotCost = input.processingMode === 'batch' ? 1 : future.realtimeSlotCost;
                if (input.poolKind !== undefined) await validatePoolChange(query, row, selectedPool, plan, afterSlotCost);
                if (input.processingMode === 'realtime') {
                    if (!enabled) fail('X_MONITOR_UNAVAILABLE','X通知の設定は提供準備中です。',503);
                    await requireXEnrollment(query, actor, rolloutOptions);
                    confirmRealtimeCost(input, future);
                }
                await reserveProcessingSlots(query, actor.userId, target, afterSlotCost);
                nextSettings.processingMode = input.processingMode;
            } else if (input.poolKind !== undefined) {
                // Reconfirming the same pool still validates its current
                // qualification; a metadata-only edit without a pool choice
                // retains the existing cleanup behavior after a downgrade.
                const current = await processing.inspectXMonitorProcessing(query, row, now(), { plan });
                await validatePoolChange(query, row, selectedPool, plan, current.slotCost);
            }
            // Correcting a current handle preserves the registration identity,
            // reservations, settings and subscription. Legacy numeric IDs stay.
            const accountHandle = parsedHandle === undefined ? row.account_handle : parsedHandle;
            if (accountHandle === null && row.account_id.startsWith('h:')) fail('X_MONITOR_INVALID_INPUT', '通知を受け取りたい相手の@ユーザー名を入力してください。');
            if (parsedHandle !== undefined && accountHandle !== null) {
                const duplicate = (await query("SELECT id FROM automation_x_monitors WHERE owner_user_id=? AND LOWER(account_handle)=? AND id<>? AND state<>'deleted' LIMIT 1", [actor.userId, accountHandle.toLowerCase(), row.id]))[0];
                if (duplicate) fail('X_MONITOR_HANDLE_CONFLICT', '同じ@ユーザー名の監視が登録されています。一覧から編集してください。', 409);
            }
            const nextName = input.name?.trim() ?? row.name, nextEnabled = input.enabled === undefined ? Number(row.enabled) : input.enabled ? 1 : 0;
            const sameSettings = Object.keys(oldSettings).length === Object.keys(nextSettings).length && Object.keys(oldSettings).every(key => oldSettings[key] === nextSettings[key]);
            const purePoolMove = poolChanged && nextName === row.name && accountHandle === row.account_handle && nextEnabled === Number(row.enabled) && sameSettings;
            const metadataOnly = Object.keys(input).every(key => ['expectedRevision', 'name'].includes(key))
                && !poolChanged && accountHandle === row.account_handle && nextEnabled === Number(row.enabled) && sameSettings;
            if (metadataOnly && nextName === row.name && Object.keys(input).every(key => ['expectedRevision', 'name'].includes(key))) return item(row, plan, query);
            await query('UPDATE automation_x_monitors SET name=?,account_handle=?,enabled=?,notification_settings_json=?,subscription_state=?,pool_kind=?,state=?,revision=revision+1,updated_at_ms=? WHERE id=?', [nextName, accountHandle, nextEnabled, JSON.stringify(nextSettings), input.notificationSettings === undefined ? row.subscription_state : nextSettings.subscriptionId ? 'bound' : 'pending', selectedPool, poolChanged ? 'ready' : row.state, now(), row.id]);
            await audit(query, actor, target, metadataOnly && nextName !== row.name ? 'x.monitor.rename' : 'x.monitor.update', metadataOnly && nextName !== row.name
                ? { manual: true, metadataOnly: true, ownerUserId: actor.userId, beforeRevision: Number(row.revision), afterRevision: Number(row.revision) + 1 }
                : { enabled: input.enabled ?? Number(row.enabled) === 1, handleChanged: accountHandle !== row.account_handle });
            if (beforeProcessing) await audit(query, actor, target, 'x.processing.monitor', { beforeMode: beforeProcessing.requestedMode, afterMode: input.processingMode,
                beforeSlotCost: beforeProcessing.slotCost, afterSlotCost });
            if (poolChanged) await audit(query, actor, target, 'x.quota.move', { before: row.pool_kind, after: selectedPool, manual: true, ownerUserId: actor.userId,
                preservesDelivery: purePoolMove, ...(purePoolMove ? { beforeRevision: Number(row.revision), afterRevision: Number(row.revision) + 1 } : {}),
                releasedExtraSlots: beforeProcessing ? Math.max(0, beforeProcessing.slotCost - afterSlotCost) : 0 });
            return item(await getRow(query, actor, target), plan, query);
        });
    }
    async function release(actor, target, input = {}) {
        requireActor(actor); strict(input, ['expectedRevision']);
        return db.withDatabaseTransaction(async query => {
            await lockGlobal(query, actor); await entitlements.lockOwner(query, actor.userId);
            const row = await getRow(query, actor, target, true);
            if (row.state === 'deleted') return { released: false, id: String(row.id) };
            if (input.expectedRevision !== undefined && Number(row.revision) !== input.expectedRevision) fail('X_MONITOR_REVISION_CONFLICT', '監視が変更されています。再取得してください。', 409);
            const extraCount = count(await query("SELECT COUNT(*) n FROM automation_notification_boost_slots WHERE owner_user_id=? AND target_kind='x' AND target_id=?", [actor.userId, String(row.id)]));
            await query("UPDATE automation_x_monitors SET state='deleted',pool_kind=NULL,enabled=0,revision=revision+1,updated_at_ms=? WHERE id=?", [now(), row.id]);
            await entitlements.releaseSlot(query, actor.userId, 'x', String(row.id));
            await audit(query, actor, row.id, 'x.quota.release', { poolKind: row.pool_kind, personalSlotCost: 1 + extraCount });
            return { released: true, id: String(row.id) };
        });
    }
    async function summary(actor) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => { await entitlements.lockOwner(query, actor.userId); return quota(query, actor); });
    }
    async function list(actor) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => { await entitlements.lockOwner(query, actor.userId); const plan = await planFor(query, actor.userId); return { items: await Promise.all((await rowsFor(query, actor.userId)).map(row => item(row, plan, query))), quota: await quota(query, actor) }; });
    }
    async function reconcile(actor) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => { await lockGlobal(query, actor); await reconcileRows(query, actor, [actor.userId]); const plan = await planFor(query, actor.userId); return { items: await Promise.all((await rowsFor(query, actor.userId)).map(row => item(row, plan, query))), quota: await quota(query, actor) }; });
    }
    async function integrity(actor) {
        capacity.requireAdmin(actor);
        // Inspect raw state under the same global→owner lock order used by
        // allocation. Do not adopt slots, create users, migrate grants or repair
        // records here: a diagnostic must not hide the anomaly it inspects.
        return db.withDatabaseTransaction(async query => {
            const issues = [];
            const policy = (await query('SELECT * FROM automation_push_pool_policy WHERE id=1 FOR UPDATE'))[0];
            // Global reservation mutations cannot add an owner while this
            // policy row is locked. Acquire owners before monitor rows, also
            // matching owner-only subscription deletion/unbinding operations.
            const owners = (await query('SELECT DISTINCT owner_user_id FROM automation_x_monitors ORDER BY owner_user_id')).map(row => row.owner_user_id);
            for (const owner of owners) await query('SELECT user_id FROM users WHERE user_id=? FOR UPDATE', [owner]);
            const registrations = await query('SELECT * FROM automation_x_monitors ORDER BY id FOR UPDATE');
            const placeholders = owners.map(() => '?').join(',');
            // Existing owner locks already freeze their native reservations.
            // Snapshot reads here avoid locking unrelated native registrations
            // through an optimizer-selected table scan or an orphan mapping.
            const slots = await query(`SELECT * FROM automation_notification_slots WHERE target_kind='x'${owners.length ? ` OR owner_user_id IN (${placeholders})` : ''}`, owners);
            const boosts = await query(`SELECT * FROM automation_notification_boost_slots WHERE target_kind='x'${owners.length ? ` OR owner_user_id IN (${placeholders})` : ''}`, owners);
            const active = registrations.filter(row => row.state !== 'deleted');
            const allocated = active.filter(row => row.pool_kind != null);
            const poolLimits = policy ? { free: Number(policy.free_pool_limit), supporter: Number(policy.supporter_pool_limit) }
                : { free: capacity.DEFAULT_POOL_POLICY.freePoolLimit, supporter: capacity.DEFAULT_POOL_POLICY.supporterPoolLimit };
            if (!policy && active.length) issues.push({ code: 'MISSING_POOL_POLICY' });
            for (const kind of ['free', 'supporter']) {
                const limit = poolLimits[kind], used = allocated.filter(row => row.pool_kind === kind).length;
                if (!Number.isSafeInteger(limit) || limit < 0 || limit > capacity.CAPACITY_LIMIT_MAX) issues.push({ code: 'INVALID_POOL_POLICY', poolKind: kind });
                else if (used > limit) issues.push({ code: 'POOL_OVER_LIMIT', poolKind: kind, used, limit });
            }
            const byId = new Map(registrations.map(row => [String(row.id), row]));
            const xSlots = slots.filter(row => row.target_kind === 'x');
            for (const row of registrations) {
                const detail = { id: String(row.id), ownerUserId: row.owner_user_id };
                if (!['ready', 'suspended', 'deleted'].includes(row.state)) issues.push({ code: 'INVALID_REGISTRATION_STATE', ...detail });
                if (row.state === 'ready' && !['free', 'supporter', 'special'].includes(row.pool_kind)) issues.push({ code: 'MISSING_ALLOCATION', ...detail });
                if (row.state === 'deleted' && row.pool_kind != null) issues.push({ code: 'UNEXPECTED_ALLOCATION', poolKind: row.pool_kind, ...detail });
                if (row.state === 'deleted') continue;
                const assigned = xSlots.filter(slot => String(slot.target_id) === String(row.id));
                const matching = assigned.filter(slot => slot.owner_user_id === row.owner_user_id);
                if (!matching.length) issues.push({ code: 'ORPHANED_PERSONAL_SLOT', ...detail });
                if (matching.length > 1) issues.push({ code: 'DUPLICATE_PERSONAL_SLOT', ...detail });
                if (assigned.some(slot => slot.owner_user_id !== row.owner_user_id)) issues.push({ code: 'WRONG_SLOT_OWNER', ...detail });
                const extra = boosts.filter(boost => boost.target_kind === 'x' && String(boost.target_id) === String(row.id) && boost.owner_user_id === row.owner_user_id);
                if (![0,4].includes(extra.length)) issues.push({ code: 'INVALID_X_REALTIME_SLOT_COUNT', slotCost: 1 + extra.length, ...detail });
                let config;
                try { config = settings(JSON.parse(row.notification_settings_json)); }
                catch { issues.push({ code: 'INVALID_NOTIFICATION_SETTINGS', ...detail }); }
                if (config?.subscriptionId) {
                    const owner = (await query('SELECT owner_user_id FROM automation_x_subscriptions WHERE id=?', [config.subscriptionId]))[0];
                    if (!owner || owner.owner_user_id !== row.owner_user_id) issues.push({ code: 'INVALID_SUBSCRIPTION_BINDING', ...detail });
                }
            }
            for (const slot of xSlots) {
                const row = byId.get(String(slot.target_id));
                if (!row || row.state === 'deleted' || row.owner_user_id !== slot.owner_user_id) issues.push({ code: 'ORPHANED_REGISTRATION', id: String(slot.target_id), ownerUserId: slot.owner_user_id });
            }
            for (const boost of boosts.filter(value => value.target_kind === 'x')) {
                const row = byId.get(String(boost.target_id));
                if (!row || row.state === 'deleted' || row.owner_user_id !== boost.owner_user_id) issues.push({ code: 'ORPHANED_X_REALTIME_SLOT', id: String(boost.target_id), ownerUserId: boost.owner_user_id });
                const physical = slots.find(slot => slot.owner_user_id === boost.owner_user_id && Number(slot.slot_index) === Number(boost.slot_index));
                if (!physical || physical.target_kind) issues.push({ code: 'INVALID_X_REALTIME_RESERVATION', id: String(boost.target_id), ownerUserId: boost.owner_user_id, slotIndex: Number(boost.slot_index) });
            }
            for (const owner of owners) {
                if (!/^\d{1,32}$/.test(owner || '')) { issues.push({ code: 'INVALID_OWNER', ownerUserId: owner }); continue; }
                const owned = active.filter(row => row.owner_user_id === owner);
                if (!owned.length) continue;
                let plan, support;
                try { plan = await planFor(query, owner); support = await supportFor(query, owner); }
                catch (cause) {
                    if (!['AUTOMATION_SUPPORT_GRANT_CORRUPT','AUTOMATION_SLOT_ALLOWANCE_INVALID'].includes(cause?.code)) throw cause;
                    issues.push({ code: 'INVALID_PERSONAL_ALLOWANCE', ownerUserId: owner }); continue;
                }
                const personal = slots.filter(slot => slot.owner_user_id === owner && slot.target_kind);
                const used = personal.length + boosts.filter(slot => slot.owner_user_id === owner).length;
                if (!Number.isSafeInteger(plan.slotLimit) || plan.slotLimit < 0) issues.push({ code: 'INVALID_PERSONAL_ALLOWANCE', ownerUserId: owner });
                const ready = owned.filter(value => value.state === 'ready');
                let invalidPersonalSlot = false;
                for (const row of ready) {
                    const slot = personal.find(value => value.target_kind === 'x' && String(value.target_id) === String(row.id));
                    if (slot && Number(slot.slot_index) > plan.slotLimit) {
                        invalidPersonalSlot = true;
                        issues.push({ code: 'INELIGIBLE_PERSONAL_SLOT', id: String(row.id), ownerUserId: owner });
                    }
                }
                if (invalidPersonalSlot && used > plan.slotLimit) issues.push({ code: 'PERSONAL_OVER_LIMIT', ownerUserId: owner, used, limit: plan.slotLimit });
                const supporterUsed = ready.filter(row => row.pool_kind === 'supporter').length;
                if (supporterUsed && !support.isSupporter) issues.push({ code: 'SUPPORTER_INELIGIBLE', ownerUserId: owner, used: supporterUsed, limit: 0 });
                else if (supporterUsed > support.totalSupporterSlots) issues.push({ code: 'SUPPORTER_OVER_LIMIT', ownerUserId: owner, used: supporterUsed, limit: support.totalSupporterSlots });
                const specialUsed = ready.filter(row => row.pool_kind === 'special').length;
                const specialLimit = await paidLimit(query, plan);
                if (specialUsed && !specialLimit) issues.push({ code: 'SPECIAL_INELIGIBLE', ownerUserId: owner, used: specialUsed, limit: 0 });
                else if (specialUsed > specialLimit) issues.push({ code: 'SPECIAL_OVER_LIMIT', ownerUserId: owner, used: specialUsed, limit: specialLimit });
            }
            return { issues };
        });
    }
    async function adminSummary(actor, filters={}) {
        capacity.requireAdmin(actor);
        const afterUserId=filters.afterUserId||'0',afterMonitorId=filters.afterMonitorId||'0',afterAuditId=filters.afterAuditId||null;
        if(!/^\d{1,32}$/.test(afterUserId)||!/^\d{1,20}$/.test(afterMonitorId)||afterAuditId!==null&&!/^\d{1,20}$/.test(afterAuditId)) fail('INVALID_CURSOR','一覧の位置を確認してください。');
        const registrations = await db.queryDatabase("SELECT * FROM automation_x_monitors WHERE state<>'deleted' AND id>? ORDER BY id LIMIT 201",[afterMonitorId]);
        const owners = await db.queryDatabase('SELECT user_id FROM users WHERE user_id>? ORDER BY user_id LIMIT 101',[afterUserId]);
        const invalidOwners=[];
        const holdings = (await Promise.all(owners.slice(0,100).map(async row => {
            try {
                const holding=await supportFor(db.queryDatabase,row.user_id);
                return { userId:row.user_id,manualLegacySlots:holding.manualLegacySlots,legacySquareSlots:holding.legacySquareSlots,historicalSlots:holding.historicalSlots,legacySlots:holding.legacySlots,newPaidSlots:holding.newPaidSlots,paidSlots:holding.paidSlots,totalSupporterSlots:holding.totalSupporterSlots,isSupporter:holding.isSupporter,migrationRequired:holding.migrationRequired };
            }catch(cause) {
                if (cause?.code!=='AUTOMATION_SUPPORT_GRANT_CORRUPT') throw cause;
                invalidOwners.push({userId:row.user_id,errorCode:'INVALID_SUPPORT_HOLDING'});return null;
            }
        }))).filter(Boolean);
        const invalidRegistrations=[];
        const publicRows=(await Promise.all(registrations.slice(0,200).map(async row=>{
            try {return {...await item(row,await planFor(db.queryDatabase,row.owner_user_id)),ownerUserId:row.owner_user_id};}
            catch(cause) {
                if (!(cause instanceof SyntaxError)&&!['X_MONITOR_INVALID_INPUT','AUTOMATION_SUPPORT_GRANT_CORRUPT','AUTOMATION_SLOT_ALLOWANCE_INVALID'].includes(cause?.code)) throw cause;
                invalidRegistrations.push({id:String(row.id),ownerUserId:row.owner_user_id,errorCode:'INVALID_REGISTRATION_METADATA'});return null;
            }
        }))).filter(Boolean);
        const audits = await db.queryDatabase(`SELECT id,actor_user_id,entity_id,action,detail_json,created_at_ms FROM automation_audit WHERE action LIKE 'x.%'${afterAuditId?' AND id<?':''} ORDER BY id DESC LIMIT 101`,afterAuditId?[afterAuditId]:[]);
        return { pools:await pools(db.queryDatabase), owners:holdings, invalidOwners, nextCursor:owners.length>100?owners[99].user_id:null,
            registrations:publicRows,invalidRegistrations,registrationNextCursor:registrations.length>200?String(registrations[199].id):null,
            audits:audits.slice(0,100),auditNextCursor:audits.length>100?String(audits[99].id):null,integrity:await integrity(actor) };
    }
    async function recheckAll(actor) {
        capacity.requireAdmin(actor);
        await db.withDatabaseTransaction(async query=>{await lockGlobal(query,actor);await reconcileRows(query,actor,await allOwners(query));});
        return adminSummary(actor);
    }
    async function move(actor,target,input) {
        requireActor(actor); strict(input,['poolKind','expectedRevision']);
        if (!['free','supporter','special'].includes(input.poolKind)) fail('X_MONITOR_INVALID_INPUT','移動先の枠を選択してください。');
        if (!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1) fail('X_MONITOR_REVISION_CONFLICT','最新の監視設定を読み直してください。',409);
        // Resolve the immutable owner before opening a REPEATABLE READ
        // transaction. No consistent snapshot may precede the owner mutex:
        // donor-only administration can update qualifications while we wait.
        const candidate=(await db.queryDatabase(`SELECT * FROM automation_x_monitors WHERE id=? AND state<>'deleted'${actor.isAdmin===true?'':' AND owner_user_id=?'}`,
            actor.isAdmin===true?[id(target)]:[id(target),actor.userId]))[0];
        if (!candidate) fail('NOT_FOUND','監視登録が見つかりません。',404);
        return db.withDatabaseTransaction(async query=>{
            await lockGlobal(query,actor);
            await entitlements.lockOwner(query,candidate.owner_user_id);
            // A subscription can be explicitly removed under the owner lock
            // while this operation waits. Use a current locking read for CAS.
            const row = (await query("SELECT * FROM automation_x_monitors WHERE id=? AND owner_user_id=? AND state<>'deleted' FOR UPDATE", [id(target), candidate.owner_user_id]))[0];
            if (!row) fail('NOT_FOUND','監視登録が見つかりません。',404);
            if (Number(row.revision)!==input.expectedRevision) fail('X_MONITOR_REVISION_CONFLICT','監視が変更されています。再取得してください。',409);
            const plan=await planFor(query,row.owner_user_id), personal=await entitlements.listOwnerSlots(query,row.owner_user_id);
            const slot=personal.slots.find(value=>value.targetKind==='x'&&value.targetId===String(row.id));
            if (!slot||slot.slotIndex>plan.slotLimit) fail('X_MONITOR_PERSONAL_LIMIT','個人の総登録上限を超えているため、枠を移動できません。');
            const targets=await rowsFor(query,row.owner_user_id), selected=input.poolKind;
            const owned=targets.filter(value=>value.pool_kind===selected&&String(value.id)!==String(row.id)).length;
            if (selected==='supporter') {
                const support=await supportFor(query,row.owner_user_id);
                if (!support.isSupporter||owned>=support.totalSupporterSlots) fail('X_MONITOR_DESTINATION_INELIGIBLE','この利用者が保有する支援者追加枠では移動できません。');
            } else if (selected==='special'&&owned>=await paidLimit(query,plan)) fail('X_MONITOR_DESTINATION_INELIGIBLE','現在の契約プランではこの特殊枠へ移動できません。');
            const future = await processing.inspectXMonitorProcessing(query, { ...row, pool_kind: selected, state: 'ready' }, now(), { plan, prospectivePool: true });
            const releasedExtras = future.requestedMode === 'realtime' && future.realtimeSlotCost === 1 && future.canEnableRealtime ? Math.max(0, future.slotCost - 1) : 0;
            if (personal.usedSlots-releasedExtras>plan.slotLimit) fail('X_MONITOR_PERSONAL_LIMIT','個人の総登録上限を超えているため、枠を移動できません。');
            if (selected===row.pool_kind && !releasedExtras) return item(row,plan,query);
            const shared=await pools(query,true);
            if (selected!==row.pool_kind&&selected!=='special'&&shared[selected].available<=0) fail('X_MONITOR_DESTINATION_FULL','移動先の枠が満杯です。現在の登録は変更されていません。');
            // A manual move can return an existing realtime allocation to one
            // slot when its new/current privilege grants that option. Losing a
            // privilege never silently reserves four new slots.
            if (releasedExtras) await reserveProcessingSlots(query,row.owner_user_id,row.id,1);
            // One UPDATE changes the reservation atomically under the global
            // mutex. Notification/subscription data and personal slot stay put.
            await query("UPDATE automation_x_monitors SET pool_kind=?,state='ready',revision=revision+1,updated_at_ms=? WHERE id=?",[selected,now(),row.id]);
            await audit(query,actor,row.id,'x.quota.move',{before:row.pool_kind,after:selected,manual:true,ownerUserId:row.owner_user_id,
                beforeRevision:Number(row.revision),afterRevision:Number(row.revision)+1,releasedExtraSlots:releasedExtras});
            return item(await getRow(query,{userId:row.owner_user_id},row.id),plan,query);
        });
    }
    async function validateDelivery(actor, target) {
        await requireXEnrollment(db.queryDatabase, actor, rolloutOptions);
        await reconcile(actor);
        return db.withDatabaseTransaction(async query=>{
            await entitlements.lockOwner(query,actor.userId);const row=await getRow(query,actor,target);
            await requireXEnrollment(query, actor, rolloutOptions);
            const slot=await entitlements.findSlot(query,actor.userId,'x',String(row.id));
            if (!slot || row.state!=='ready' || Number(row.enabled)!==1) fail('X_MONITOR_NOT_AVAILABLE','現在の登録枠では通知を処理できません。');
            return item(row,await planFor(query,actor.userId),query);
        });
    }
    async function mutatePolicy(actor, work) {
        capacity.requireAdmin(actor);
        return db.withDatabaseTransaction(async query=>{
            await lockGlobal(query,actor); const value=await work(query);
            await reconcileRows(query,actor,await allOwners(query));return value;
        });
    }
    return { register,update,release,summary,list,reconcile,recheckAll,move,integrity,adminSummary,validateDelivery,mutatePolicy };
}
module.exports = { createXMonitorQuota };
