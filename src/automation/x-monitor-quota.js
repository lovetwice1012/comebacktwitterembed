'use strict';
const { AutomationError, requireActor } = require('./service');
const entitlements = require('./entitlements');
const capacity = require('./push-capacity');
const grants = require('./push-support-grants');
const { evaluateXRollout, requireXEnrollment } = require('./x-rollout-policy');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function fail(code, message, status = 422) { throw new AutomationError(code, message, status); }
function id(value) { if (!/^\d{1,20}$/.test(String(value || ''))) fail('NOT_FOUND', '監視登録が見つかりません。', 404); return String(value); }
function strict(input, keys) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) fail('X_MONITOR_INVALID_INPUT', '指定できない監視設定が含まれています。');
}
/** @returns {{workflowId?:string,destinationId?:string,subscriptionId?:string}} */
function settings(value = {}) {
    strict(value, ['workflowId', 'destinationId', 'subscriptionId']);
    for (const key of Object.keys(value)) if (typeof value[key]!=='string' || !UUID.test(value[key])) fail('X_MONITOR_INVALID_INPUT', '既存のルール・通知先を指定してください。');
    return { ...value };
}
function inputOf(input) {
    strict(input, ['accountId', 'accountHandle', 'name', 'notificationSettings']);
    if (typeof input.accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(input.accountId)) fail('X_MONITOR_INVALID_INPUT', 'XアカウントIDを確認してください。');
    if (input.accountHandle != null && (typeof input.accountHandle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(input.accountHandle))) fail('X_MONITOR_INVALID_INPUT', 'Xアカウント名を確認してください。');
    const name = input.name ?? input.accountHandle ?? input.accountId;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) fail('X_MONITOR_INVALID_INPUT', '監視の名前は1〜120文字で指定してください。');
    return { accountId: input.accountId, accountHandle: input.accountHandle ?? null, name: name.trim(), notificationSettings: settings(input.notificationSettings) };
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
    async function choosePool(query, owner, plan) {
        const shared = await pools(query, true);
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
    function item(row, plan) { return { id: String(row.id), accountId: row.account_id, accountHandle: row.account_handle, name: row.name,
        enabled: Number(row.enabled) === 1, state: row.state, poolKind: row.pool_kind, notificationSettings: settings(JSON.parse(row.notification_settings_json)),
        subscriptionState: row.subscription_state, revision: Number(row.revision), quality: quality(plan) }; }
    async function getRow(query, actor, target, includeDeleted = false) {
        const row = (await query(`SELECT * FROM automation_x_monitors WHERE id=? AND owner_user_id=?${includeDeleted ? '' : " AND state<>'deleted'"}`, [id(target), actor.userId]))[0];
        if (!row) fail('NOT_FOUND', '監視登録が見つかりません。', 404); return row;
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
        return { featureEnabled: enabled && rollout.eligible, rollout, currentPlan: { planId: plan.planId, label: plan.label, tier: plan.tier, baseSlotLimit: plan.baseSlotLimit, ...quality(plan) },
            personal: { totalLimit, used: personal.usedSlots, registeredCount: personal.slots.length, available, supporterExtraSlots: totalLimit - plan.baseSlotLimit },
            x: { used: targets.length, available: enabled && rollout.eligible ? Math.min(available, poolAvailable) : 0, reasonCode, reason: rollout.eligible || !enabled ? reason : rollout.reason, specialLimit, specialUsed }, pools: shared };
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
            if (existing && existing.state !== 'deleted') return item(existing, await planFor(query, actor.userId));
            const before = await quota(query, actor);
            if (!before.personal.available) fail('X_MONITOR_PERSONAL_LIMIT', '個人の総登録上限に達しています。通常通知とX監視で枠を共有しています。');
            // Free vacancies take precedence even for supporters/paid owners.
            const plan = await planFor(query, actor.userId), selected = await choosePool(query, actor.userId, plan);
            if (!selected) fail('X_MONITOR_POOL_FULL', '利用できる自動展開枠が満杯です。個人の残り枠はあります。');
            let target;
            if (existing) {
                target = existing.id;
                await query("UPDATE automation_x_monitors SET account_handle=?,name=?,enabled=1,state='ready',pool_kind=?,notification_settings_json=?,subscription_state=?,revision=revision+1,updated_at_ms=? WHERE id=?", [parsed.accountHandle, parsed.name, selected, JSON.stringify(parsed.notificationSettings), parsed.notificationSettings.subscriptionId ? 'bound' : 'pending', now(), target]);
            } else {
                const result = await query("INSERT INTO automation_x_monitors (owner_user_id,account_id,account_handle,name,enabled,state,pool_kind,notification_settings_json,subscription_state,revision,created_at_ms,updated_at_ms) VALUES (?,?,?,?,1,'ready',?,?,?,1,?,?)", [actor.userId, parsed.accountId, parsed.accountHandle, parsed.name, selected, JSON.stringify(parsed.notificationSettings), parsed.notificationSettings.subscriptionId ? 'bound' : 'pending', now(), now()]);
                target = result.insertId;
            }
            await entitlements.assignSlot(query, actor.userId, 'x', String(target));
            await audit(query, actor, target, 'x.quota.allocate', { poolKind: selected });
            return item(await getRow(query, actor, target), plan);
        });
    }
    async function update(actor, target, input) {
        requireActor(actor); strict(input, ['expectedRevision','enabled','name','notificationSettings']);
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('X_MONITOR_REVISION_CONFLICT', '最新の監視設定を読み直してください。', 409);
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('X_MONITOR_INVALID_INPUT', '監視の状態を確認してください。');
        if (input.enabled === true && !enabled) fail('X_MONITOR_UNAVAILABLE', '新しいX自動展開は提供準備中です。', 503);
        if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)) fail('X_MONITOR_INVALID_INPUT', '監視の名前を確認してください。');
        if (input.notificationSettings !== undefined) settings(input.notificationSettings);
        return db.withDatabaseTransaction(async query => {
            await lockGlobal(query, actor); await entitlements.lockOwner(query, actor.userId);
            const row = await getRow(query, actor, target);
            if (Number(row.revision) !== input.expectedRevision) fail('X_MONITOR_REVISION_CONFLICT', '監視が変更されています。再取得してください。', 409);
            if (input.notificationSettings) await verifySettings(query, actor, input.notificationSettings);
            if (input.enabled === true) {
                await requireXEnrollment(query, actor, rolloutOptions);
                await reconcileRows(query, actor, [actor.userId]);
                const current = await getRow(query, actor, target);
                if (current.state !== 'ready') fail('X_MONITOR_POOL_FULL', '現在の資格と空き枠では監視を再開できません。');
            }
            await query('UPDATE automation_x_monitors SET name=?,enabled=?,notification_settings_json=?,subscription_state=?,revision=revision+1,updated_at_ms=? WHERE id=?', [input.name?.trim() ?? row.name, input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0, input.notificationSettings === undefined ? row.notification_settings_json : JSON.stringify(input.notificationSettings), input.notificationSettings === undefined ? row.subscription_state : input.notificationSettings.subscriptionId ? 'bound' : 'pending', now(), row.id]);
            await audit(query, actor, target, 'x.monitor.update', { enabled: input.enabled ?? Number(row.enabled) === 1 });
            return item(await getRow(query, actor, target), await planFor(query, actor.userId));
        });
    }
    async function release(actor, target, input = {}) {
        requireActor(actor); strict(input, ['expectedRevision']);
        return db.withDatabaseTransaction(async query => {
            await lockGlobal(query, actor); await entitlements.lockOwner(query, actor.userId);
            const row = await getRow(query, actor, target, true);
            if (row.state === 'deleted') return { released: false, id: String(row.id) };
            if (input.expectedRevision !== undefined && Number(row.revision) !== input.expectedRevision) fail('X_MONITOR_REVISION_CONFLICT', '監視が変更されています。再取得してください。', 409);
            await query("UPDATE automation_x_monitors SET state='deleted',pool_kind=NULL,enabled=0,revision=revision+1,updated_at_ms=? WHERE id=?", [now(), row.id]);
            await entitlements.releaseSlot(query, actor.userId, 'x', String(row.id));
            await audit(query, actor, row.id, 'x.quota.release', { poolKind: row.pool_kind });
            return { released: true, id: String(row.id) };
        });
    }
    async function summary(actor) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => { await entitlements.lockOwner(query, actor.userId); return quota(query, actor); });
    }
    async function list(actor) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => { await entitlements.lockOwner(query, actor.userId); const plan = await planFor(query, actor.userId); return { items: (await rowsFor(query, actor.userId)).map(row => item(row, plan)), quota: await quota(query, actor) }; });
    }
    async function reconcile(actor) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => { await lockGlobal(query, actor); await reconcileRows(query, actor, [actor.userId]); const plan = await planFor(query, actor.userId); return { items: (await rowsFor(query, actor.userId)).map(row => item(row, plan)), quota: await quota(query, actor) }; });
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
            const slots = await query(`SELECT * FROM automation_notification_slots WHERE target_kind='x'${owners.length ? ` OR (target_kind IS NOT NULL AND owner_user_id IN (${placeholders}))` : ''}`, owners);
            const boosts = owners.length ? await query(`SELECT * FROM automation_notification_boost_slots WHERE owner_user_id IN (${placeholders})`, owners) : [];
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
                const personal = slots.filter(slot => slot.owner_user_id === owner);
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
            try {return {...item(row,await planFor(db.queryDatabase,row.owner_user_id)),ownerUserId:row.owner_user_id};}
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
        return db.withDatabaseTransaction(async query=>{
            await lockGlobal(query,actor);
            let row=(await query(`SELECT * FROM automation_x_monitors WHERE id=? AND state<>'deleted'${actor.isAdmin===true?'':' AND owner_user_id=?'}`,
                actor.isAdmin===true?[id(target)]:[id(target),actor.userId]))[0];
            if (!row) fail('NOT_FOUND','監視登録が見つかりません。',404);
            await entitlements.lockOwner(query,row.owner_user_id);
            // A subscription can be explicitly removed under the owner lock
            // while this operation waits. Use a current locking read for CAS.
            row = (await query("SELECT * FROM automation_x_monitors WHERE id=? AND owner_user_id=? AND state<>'deleted' FOR UPDATE", [id(target), row.owner_user_id]))[0];
            if (!row) fail('NOT_FOUND','監視登録が見つかりません。',404);
            if (Number(row.revision)!==input.expectedRevision) fail('X_MONITOR_REVISION_CONFLICT','監視が変更されています。再取得してください。',409);
            const plan=await planFor(query,row.owner_user_id), personal=await entitlements.listOwnerSlots(query,row.owner_user_id);
            const slot=personal.slots.find(value=>value.targetKind==='x'&&value.targetId===String(row.id));
            if (!slot||slot.slotIndex>plan.slotLimit||personal.usedSlots>plan.slotLimit) fail('X_MONITOR_PERSONAL_LIMIT','個人の総登録上限を超えているため、枠を移動できません。');
            const targets=await rowsFor(query,row.owner_user_id), selected=input.poolKind;
            const owned=targets.filter(value=>value.pool_kind===selected&&String(value.id)!==String(row.id)).length;
            if (selected==='supporter') {
                const support=await supportFor(query,row.owner_user_id);
                if (!support.isSupporter||owned>=support.totalSupporterSlots) fail('X_MONITOR_DESTINATION_INELIGIBLE','この利用者が保有する支援者追加枠では移動できません。');
            } else if (selected==='special'&&owned>=await paidLimit(query,plan)) fail('X_MONITOR_DESTINATION_INELIGIBLE','現在の契約プランではこの特殊枠へ移動できません。');
            if (selected===row.pool_kind) return item(row,plan);
            const shared=await pools(query,true);
            if (selected!=='special'&&shared[selected].available<=0) fail('X_MONITOR_DESTINATION_FULL','移動先の枠が満杯です。現在の登録は変更されていません。');
            // One UPDATE changes the reservation atomically under the global
            // mutex. Notification/subscription data and personal slot stay put.
            await query("UPDATE automation_x_monitors SET pool_kind=?,state='ready',revision=revision+1,updated_at_ms=? WHERE id=?",[selected,now(),row.id]);
            await audit(query,actor,row.id,'x.quota.move',{before:row.pool_kind,after:selected,manual:true,ownerUserId:row.owner_user_id});
            return item(await getRow(query,{userId:row.owner_user_id},row.id),plan);
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
            return item(row,await planFor(query,actor.userId));
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
