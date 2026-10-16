'use strict';

const { randomUUID } = require('node:crypto');
const { hash, AutomationError } = require('./service');
const { newWorkflow, NODE_TYPES } = require('./schema');
const { evaluateWorkflow, normalizeEvent } = require('./engine');
const { scheduleDelivery, MINUTE } = require('./schedule');
const { scopeOf } = require('./monitors');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const table = kind => {
    if (!['auto', 'price'].includes(kind)) throw new Error('Invalid queue target kind');
    return kind === 'auto' ? 'auto_watch' : 'price_watch';
};
const fail = (code, message) => { throw new AutomationError(code, message, 409); };

function deliveryEvent(kind, delivery, now) {
    if (kind === 'x') return delivery.x_notification.event;
    if (kind === 'price') return normalizeEvent({ ...(parse(delivery.event_json) || {}), kind: 'price', observedAtMs: parse(delivery.event_json)?.observedAtMs ?? now });
    const payload = parse(delivery.payload_json) || {};
    return normalizeEvent({ ...payload, providerId: delivery.provider_id, kind: payload.kind || 'new',
        sourceKey: delivery.source_key, contentId: delivery.content_key, url: delivery.content_url,
        title: delivery.title ?? undefined, publishedAtMs: delivery.published_at_ms == null ? undefined : Number(delivery.published_at_ms), observedAtMs: Number(delivery.discovered_at_ms) || now });
}
function groupKey(workflowId, revision, destinationKey, plan, dueAtMs) {
    if (!plan.aggregate) return null;
    const width = plan.aggregate.minutes * MINUTE;
    return hash(JSON.stringify([workflowId, revision, destinationKey, plan.aggregate.nodeId, plan.aggregate.group, Math.floor(dueAtMs / width), plan.path]));
}

function createQueue(db, evaluator, options = {}) {
    const clock = options.clock || Date.now;
    const queryDB = db.queryDatabase;
    const graph = options.graph || null;
    const admittedXInputs = new WeakSet();
    const containsX = (job, plan = job.plan) => job.target_kind === 'x' || Array.isArray(plan?.members) && plan.members.some(member => member?.targetKind === 'x');
    async function snapshot(query, kind, id, lock = false, ownerUserId = null) {
        if (kind === 'x') return snapshotX(query, id, lock, ownerUserId);
        const rows = await query(`SELECT t.*,m.scope,m.revision AS monitor_revision,m.destination_id,a.workflow_id,
            w.enabled AS workflow_enabled,w.deleted_at_ms,w.active_revision,r.definition_json,r.bindings_json
            FROM ${table(kind)}_targets t LEFT JOIN automation_monitors m ON m.target_kind=? AND m.target_id=t.id
            LEFT JOIN automation_assignments a ON a.target_kind=? AND a.target_id=t.id
            LEFT JOIN automation_workflows w ON w.id=a.workflow_id
            LEFT JOIN automation_revisions r ON r.workflow_id=w.id AND r.revision=w.active_revision WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`, [kind, kind, id]);
        return rows[0];
    }
    async function snapshotX(query, id, lock = false, ownerUserId = null) {
        // Every mutable X path takes the owner mutex before subscription,
        // receiver or monitor rows, matching intake, renewal and deletion.
        if (lock) {
            if (!ownerUserId) fail('X_NOTIFICATION_INBOX_INVALID', 'X通知の所有者を確認できません。');
            await require('./entitlements').lockOwner(query, ownerUserId);
        }
        const row = (await query(`SELECT * FROM automation_x_monitors WHERE id=?${ownerUserId ? ' AND owner_user_id=?' : ''}${lock ? ' FOR UPDATE' : ''}`, ownerUserId ? [id, ownerUserId] : [id]))[0];
        if (!row) return null;
        let config;
        try { config = parse(row.notification_settings_json); } catch { return null; }
        if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['workflowId', 'destinationId', 'subscriptionId', 'processingMode'].includes(key))
            || config.processingMode !== undefined && !['batch','realtime'].includes(config.processingMode)) return null;
        const subscription = config.subscriptionId && (await query(`SELECT s.id,s.revision,p.state AS receiver_state,p.subscription_revision AS receiver_revision,
            p.last_process_at_ms,p.process_window_at_ms,p.process_window_mode FROM automation_x_subscriptions s
            LEFT JOIN automation_x_push_receivers p ON p.subscription_id=s.id WHERE s.id=? AND s.owner_user_id=?${lock ? ' FOR UPDATE' : ''}`, [config.subscriptionId, row.owner_user_id]))[0];
        const workflow = config.workflowId && (await query(`SELECT w.id AS workflow_id,w.enabled AS workflow_enabled,w.deleted_at_ms,w.active_revision,r.definition_json,r.bindings_json
            FROM automation_workflows w LEFT JOIN automation_revisions r ON r.workflow_id=w.id AND r.revision=w.active_revision
            WHERE w.id=? AND w.owner_user_id=? AND w.scope='private'${lock ? ' FOR UPDATE' : ''}`, [config.workflowId, row.owner_user_id]))[0];
        const destination = config.destinationId && (await query(`SELECT id FROM automation_destinations WHERE id=? AND owner_user_id=? AND scope='private' AND deleted_at_ms IS NULL${lock ? ' FOR UPDATE' : ''}`, [config.destinationId, row.owner_user_id]))[0];
        return { ...row, ...workflow, user_id: row.owner_user_id, guild_id: null, scope: 'private', source_locale: 'ja',
            source_id: `${row.account_id}:${subscription?.id || ''}:${subscription?.revision || 0}`, destination_key: config.destinationId || `dm:${row.owner_user_id}`,
            destination_type: 'dm', destination_id: config.destinationId || null, monitor_revision: Number(row.revision),
            workflow_id: config.workflowId || null, x_subscription_id: config.subscriptionId || null,
            x_subscription_revision: Number(subscription?.revision || 0),
            x_processing_window_mode: subscription?.process_window_mode || null,
            x_processing_window_at_ms: subscription?.process_window_at_ms == null ? null : Number(subscription.process_window_at_ms),
            x_last_process_at_ms: subscription?.last_process_at_ms == null ? null : Number(subscription.last_process_at_ms),
            x_binding_ready: !!subscription && Number(subscription.receiver_revision) === Number(subscription.revision) && !!subscription.receiver_state && subscription.receiver_state !== 'requires_reenrollment',
            enabled: Number(row.enabled) === 1 && row.state === 'ready' && (!config.workflowId || !!workflow && !workflow.deleted_at_ms) && (!config.destinationId || !!destination),
            deleted_at_ms: row.state === 'deleted' ? Number(row.updated_at_ms) || 1 : workflow?.deleted_at_ms || null };
    }
    async function xEligibility(query, target, now, lock = false, realtimeAdmittedAtMs = null) {
        if (!target?.enabled || !target.x_binding_ready) return { state: 'cancelled', code: 'X_MONITOR_NOT_AVAILABLE' };
        const owner = target.user_id;
        if (lock) await require('./entitlements').lockOwner(query, owner);
        const rollout = await require('./x-rollout-policy').evaluateXRollout(query, { userId: owner }, options.rolloutMode === undefined ? {} : { mode: options.rolloutMode });
        if (!rollout.eligible) return { state: 'excluded', code: rollout.reasonCode };
        const plan = await require('./entitlements').inspectXPlan(query, owner, now, { useLegacyUserInterval: options.useLegacyUserInterval === true || process.env.ANGELIC_X_USE_LEGACY_USER_INTERVAL === '1' });
        const processing = await require('./x-processing-settings').inspectXMonitorProcessing(query, target, now, { plan });
        if (!processing.configured) return { state: 'pending', code: 'X_MONITOR_NOT_CONFIGURED', dueAtMs: now + MINUTE };
        if (processing.effectiveMode === 'batch' && target.x_processing_window_mode === 'realtime' && target.x_processing_window_at_ms !== null) {
            const dueAtMs = (target.x_last_process_at_ms ?? target.x_processing_window_at_ms) + processing.intervalMinutes * MINUTE;
            if (dueAtMs > now) return { state: 'pending', code: 'X_NOTIFICATION_BATCH_WAIT', dueAtMs };
        }
        // A queued realtime admission keeps its own trusted anchor when the
        // monitor subsequently loses that privilege. It must honor the current
        // batch interval without advancing the subscription's batch clock.
        if (processing.effectiveMode === 'batch' && Number.isSafeInteger(realtimeAdmittedAtMs) && realtimeAdmittedAtMs >= 0) {
            const dueAtMs = realtimeAdmittedAtMs + processing.intervalMinutes * MINUTE;
            if (dueAtMs > now) return { state: 'pending', code: 'X_NOTIFICATION_BATCH_WAIT', dueAtMs };
        }
        const slot = (await query("SELECT slot_index FROM automation_notification_slots WHERE owner_user_id=? AND target_kind='x' AND target_id=?", [owner, String(target.id)]))[0];
        if (!slot || Number(slot.slot_index) > plan.slotLimit) return { state: 'excluded', code: 'AUTOMATION_SLOT_LIMIT' };
        if (target.pool_kind === 'free') return { state: 'ready' };
        const rows = await query("SELECT id FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted' AND pool_kind=? ORDER BY id", [owner, target.pool_kind]);
        const rank = rows.findIndex(row => String(row.id) === String(target.id)) + 1;
        if (!rank) return { state: 'excluded', code: 'X_MONITOR_NOT_AVAILABLE' };
        if (target.pool_kind === 'supporter') {
            const support = await require('./push-support-grants').getSupporterHolding(query, owner, now);
            if (support.isSupporter && rank <= support.totalSupporterSlots) return { state: 'ready' };
        } else if (target.pool_kind === 'special' && plan.tier === 'paid') {
            const row = (await query(`SELECT c.special_slot_limit,c.eligible,p.enabled FROM automation_push_plan_policy c
                JOIN automation_notification_plans p ON p.plan_id=c.plan_id WHERE c.plan_id=?`, [plan.planId]))[0];
            if (Number(row?.eligible) === 1 && Number(row.enabled) === 1 && Number.isSafeInteger(Number(row.special_slot_limit)) && rank <= Number(row.special_slot_limit)) return { state: 'ready' };
        }
        return { state: 'excluded', code: 'X_MONITOR_NOT_AVAILABLE' };
    }
    async function monitorRevisionMatches(query, kind, target, expectedRevision, ownerUserId) {
        if (target?.user_id !== ownerUserId || kind === 'x' && target.owner_user_id !== ownerUserId) return false;
        return require('./monitor-revision-compat').monitorRevisionCompatible(query, { kind, targetId: String(target.id), ownerUserId,
            expectedRevision: Number(expectedRevision), currentRevision: Number(target.monitor_revision || 1) });
    }
    async function finishLegacy(query, kind, delivery, state, now, code = null, nextAttemptAtMs = null, nativeWindow = null) {
        if (kind === 'x') return true;
        const result = await query(`UPDATE ${table(kind)}_deliveries SET status=?,lease_token=NULL,lease_expires_at_ms=0,next_attempt_at_ms=?,last_error_code=? WHERE id=? AND status='pending' AND lease_token=?`,
            [state, state === 'pending' ? nextAttemptAtMs ?? now + 60000 : 0, code, delivery.id, delivery.lease_token]);
        // This is the cadence window in which the event is handed to the
        // workflow, whose own timing/quiet hours can delay actual delivery.
        if (kind === 'auto' && state === 'routed' && Number(result.affectedRows) === 1 && nativeWindow) {
            await query('UPDATE auto_watch_targets SET last_notification_window_at_ms=?,notification_window_json=? WHERE id=?', [nativeWindow.openedAtMs, JSON.stringify(nativeWindow), delivery.target_id]);
        } else if (kind === 'auto' && state === 'routed' && Number(result.affectedRows) === 1) {
            // Unmodified legacy one-slot targets already schedule deliveries
            // at creation and retain their existing handoff behavior.
            await query('UPDATE auto_watch_targets SET last_notification_window_at_ms=GREATEST(COALESCE(last_notification_window_at_ms,0),?) WHERE id=?', [now, delivery.target_id]);
        }
        return Number(result.affectedRows) === 1;
    }
    async function route(kind, delivery, now = Date.now()) {
        if (kind === 'x' && !admittedXInputs.has(delivery)) fail('X_NOTIFICATION_INBOX_INVALID', 'X通知は受信記録から処理してください。');
        const before = await snapshot(queryDB, kind, delivery.target_id, false, kind === 'x' ? delivery.owner_user_id : null);
        if (kind === 'x' && (!before || before.user_id !== delivery.owner_user_id || before.x_subscription_id !== delivery.subscription_id || !require('./x-event-router').matchesXMonitor(before, delivery.x_notification))) return { state: 'cancelled', code: 'X_MONITOR_CHANGED' };
        let evaluation, bindings = {};
        const graphEnabled = graph?.enabled === true && !!before?.workflow_id && !!before?.workflow_enabled && !!before?.definition_json;
        if (graphEnabled) bindings = parse(before.bindings_json) || {};
        if (!graphEnabled && before?.enabled && !before.deleted_at_ms && (!before.workflow_id || before.workflow_enabled && before.definition_json)) {
            bindings = before.workflow_id ? parse(before.bindings_json) : {};
            const event = deliveryEvent(kind, delivery, now);
            evaluation = before.workflow_id ? await evaluator.evaluate(parse(before.definition_json), event, bindings, now)
                : evaluateWorkflow(newWorkflow(), event, { now });
        }
        return db.withDatabaseTransaction(async query => {
            let source = null;
            if (kind === 'x') await require('./entitlements').lockOwner(query, delivery.owner_user_id);
            if (kind === 'auto' && before?.user_id) {
                await require('./entitlements').lockOwner(query, before.user_id);
                source = await require('./monitor-cadence').lockTargetSource(query, before.user_id, String(delivery.target_id));
            }
            const target = await snapshot(query, kind, delivery.target_id, true, kind === 'x' ? delivery.owner_user_id : null);
            const records = kind === 'x' ? [] : await query(`SELECT status,lease_token,lease_expires_at_ms,next_attempt_at_ms${kind === 'auto' ? ',cadence_due_at_ms' : ''} FROM ${table(kind)}_deliveries WHERE id=? FOR UPDATE`, [delivery.id]);
            const record = records[0];
            if (kind !== 'x' && (!record || record.status !== 'pending' || record.lease_token !== delivery.lease_token || Number(record.lease_expires_at_ms) <= clock())) return { state: 'lease_lost' };
            if (kind !== 'x' && require('../recoveryBootstrap').begin()) {
                const original = kind === 'auto'
                    ? (await query('SELECT i.discovered_at_ms FROM auto_watch_items i JOIN auto_watch_deliveries d ON d.item_id=i.id WHERE d.id=?', [delivery.id]))[0]
                    : (await query('SELECT event_json,created_at FROM price_watch_deliveries WHERE id=?', [delivery.id]))[0];
                const createdAtMs = kind === 'auto' ? Number(original?.discovered_at_ms) : require('./recovery-origin').priceObservedAt(original || {});
                if (!require('../recoveryBootstrap').notificationAllowed(`${kind}_watch_delivery`, { id: String(delivery.id), target_id: String(delivery.target_id) }, createdAtMs)) {
                    await finishLegacy(query, kind, delivery, 'suppressed', now, 'RECOVERY_QUARANTINED');
                    return { state: 'suppressed', code: 'RECOVERY_QUARANTINED' };
                }
            }
            if (kind === 'auto' && record.cadence_due_at_ms === null) {
                // Old claimants may already hold a native delivery lease.
                // Freeze its current scheduled time under that same locked
                // lease without reconstructing historical settings or times.
                await query('UPDATE auto_watch_deliveries SET cadence_due_at_ms=next_attempt_at_ms WHERE id=? AND lease_token=? AND status=\'pending\' AND cadence_due_at_ms IS NULL', [delivery.id, delivery.lease_token]);
                record.cadence_due_at_ms = record.next_attempt_at_ms;
            }
            if (kind === 'x') {
                if (target?.user_id !== delivery.owner_user_id || target.x_subscription_id !== delivery.subscription_id || target.x_subscription_revision !== delivery.subscription_revision || !require('./x-event-router').matchesXMonitor(target, delivery.x_notification)) return { state: 'cancelled', code: 'X_MONITOR_CHANGED' };
                const received = await query("SELECT i.id,i.received_at_ms FROM automation_x_push_inbox i JOIN automation_x_subscriptions s ON s.id=i.subscription_id WHERE i.id=? AND i.subscription_id=? AND s.owner_user_id=? AND i.subscription_revision=s.revision AND i.status IN ('received','routed') FOR UPDATE", [delivery.id, delivery.subscription_id, delivery.owner_user_id]);
                if (!received.length) return { state: 'cancelled', code: 'X_NOTIFICATION_INBOX_CHANGED' };
                if (!require('./recovery-origin').inboxAllowed({ id: delivery.id, subscriptionId: delivery.subscription_id, revision: delivery.subscription_revision, receivedAtMs: Number(received[0].received_at_ms) })) return { state: 'cancelled', code: 'RECOVERY_QUARANTINED' };
                if (delivery.x_processing_mode === 'realtime') {
                    const current = await require('./x-processing-settings').inspectXMonitorProcessing(query, target, now);
                    if (current.effectiveMode !== 'realtime') return { state: 'pending', code: 'X_REALTIME_NOT_ELIGIBLE' };
                }
                const eligibility = await xEligibility(query, target, now);
                if (eligibility.state !== 'ready') return eligibility;
            }
            if (!target?.enabled || target.deleted_at_ms) {
                await finishLegacy(query, kind, delivery, 'cancelled', now, 'MONITOR_DISABLED');
                return { state: 'cancelled' };
            }
            if ((!graphEnabled && !evaluation) || target.workflow_id !== before?.workflow_id || target.active_revision !== before?.active_revision
                || !await monitorRevisionMatches(query, kind, target, Number(before?.monitor_revision || 1), before?.user_id) || target.workflow_id && !target.workflow_enabled) {
                await finishLegacy(query, kind, delivery, 'pending', now, 'RULE_PAUSED_OR_CHANGED');
                return { state: 'pending' };
            }
            const dedupe = kind === 'x' ? hash(JSON.stringify(['x-post', target.user_id, String(target.id), delivery.x_notification.event.contentId])) : hash(`delivery:${kind}:${delivery.id}`);
            const existing = await query('SELECT id FROM automation_runs WHERE dedupe_key=?', [dedupe]);
            if (existing.length) {
                await finishLegacy(query, kind, delivery, 'routed', now);
                return { state: 'routed', runId: existing[0].id };
            }
            const handoffAtMs = Math.max(now, clock());
            let nativeWindow = null;
            if (source && String(source.id) === String(target.source_id)) {
                const user = (await query('SELECT auto_watch_interval_minutes FROM users WHERE user_id=?', [target.user_id]))[0];
                const base = user?.auto_watch_interval_minutes == null ? Number(source.poll_interval_ms) : Number(user.auto_watch_interval_minutes) * MINUTE;
                const cadence = await require('./monitor-cadence').runtimeCadence(query, target.user_id, 'auto', String(target.id), base, handoffAtMs);
                // A lease is not permission to retain a shorter interval after
                // returning frames, refund, expiry or downgrade. Native handoff
                // is the cadence boundary; already routed workflow events keep
                // their own schedules and live per-slot send quota checks.
                if (cadence.updatedAtMs !== null || Number(delivery.slot_cost) > 1) {
                    const windows = require('./native-notification-window');
                    nativeWindow = windows.readWindow(target, cadence, handoffAtMs);
                    const inWindow = windows.contains(nativeWindow, { id: delivery.id, cadence_due_at_ms: record.cadence_due_at_ms, next_attempt_at_ms: record.next_attempt_at_ms });
                    const anchor = Number(target.last_notification_window_at_ms || target.baseline_at_ms || 0);
                    const due = Math.max(Number(record.next_attempt_at_ms || 0), !inWindow && anchor ? anchor + cadence.intervalMs : 0);
                    if (due > handoffAtMs) {
                        await finishLegacy(query, kind, delivery, 'pending', handoffAtMs, 'MONITOR_CADENCE_WAIT', due);
                        return { state: 'pending', code: 'MONITOR_CADENCE_WAIT', dueAtMs: due };
                    }
                    if (!inWindow) {
                        // The source and target locks also fence source
                        // completion, so no later observation can join this
                        // cohort. IDs stay strings to preserve BIGINT values.
                        const upper = (await query("SELECT MAX(id) AS id FROM auto_watch_deliveries WHERE target_id=? AND status='pending' AND COALESCE(cadence_due_at_ms,next_attempt_at_ms)<=?", [target.id, handoffAtMs]))[0]?.id;
                        nativeWindow = windows.createWindow(cadence, upper || delivery.id, handoffAtMs);
                    }
                }
            }
            const runId = randomUUID(), scope = scopeOf(target);
            if (graphEnabled) {
                if (typeof graph.store?.initializeInTransaction !== 'function') fail('FLOW_STORE_UNAVAILABLE', '新しいルール実行基盤を開始できません。');
                const definition = parse(target.definition_json), event = deliveryEvent(kind, delivery, now);
                const deadlineMs = definition.expiresAfterMinutes ? (event.observedAtMs ?? now) + definition.expiresAfterMinutes * MINUTE : null;
                const flowContext = { ownerUserId: target.user_id, guildId: scope === 'guild' ? target.guild_id : null, scope, workflowId: target.workflow_id, revision: Number(target.active_revision),
                    targetKind: kind, targetId: String(target.id), monitorRevision: Number(target.monitor_revision || 1), targetIdentity: targetIdentity(target),
                    destinationId: target.destination_id || null, bindings, locale: target.source_locale || 'ja',
                    sourceContext: { channelId: target.origin_channel_id || null, nsfw: !!target.origin_channel_nsfw, destinationType: target.destination_type, webhookEndpointId: target.webhook_endpoint_id ? String(target.webhook_endpoint_id) : null,
                        ...(kind === 'x' && delivery.x_processing_mode === 'realtime' ? { xRealtimeAdmittedAtMs: handoffAtMs } : {}) } };
                await query('INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,guild_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    [runId, dedupe, target.workflow_id, target.active_revision, target.user_id, target.guild_id, scope, kind, target.id, JSON.stringify(event), '[]', 'flow_pending', now]);
                await graph.store.initializeInTransaction(query, { runId, context: flowContext, nodeId: require('./graph-plan').compileWorkflow(parse(target.definition_json)).startId, now, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event, display: { ...structuredClone(NODE_TYPES.transform.defaults), ...(kind === 'x' ? { format: 'normal' } : {}) }, schedules: [], dueAtMs: now, deadlineMs,
                    defaultPriceText: kind === 'price' ? delivery.message_text : null, context: flowContext.sourceContext, targetKind: kind }] } });
                await finishLegacy(query, kind, delivery, 'routed', handoffAtMs, null, null, nativeWindow);
                return { state: 'routed', runId, execution: 'flow_v2' };
            }
            let plannedJobs = 0;
            const routingTrace = [...evaluation.trace];
            await query('INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,guild_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [runId, dedupe, target.workflow_id || null, target.active_revision || null, target.user_id, target.guild_id, scope, kind, target.id, JSON.stringify(evaluation.event), JSON.stringify(evaluation.trace), evaluation.outputs.length ? 'queued' : 'excluded', now]);
            for (const output of evaluation.outputs) {
                const transformed = before.workflow_id && output.path.some(id => parse(before.definition_json).nodes.some(node => node.id === id && node.type === 'transform'));
                const destinationId = output.destination === 'default' ? target.destination_id || null : bindings.destinations?.[output.destination];
                if (output.destination !== 'default' && !destinationId) fail('DESTINATION_MISSING', '通知先の割り当てがありません。');
                const plan = { ...output, event: evaluation.event, dictionaryRefs: bindings.dictionaries || {}, monitorRevision: Number(target.monitor_revision || 1), targetIdentity: targetIdentity(target),
                    context: { userId: target.user_id, guildId: target.guild_id, channelId: target.origin_channel_id, nsfw: !!target.origin_channel_nsfw, locale: target.source_locale || 'ja',
                        destinationType: target.destination_type, webhookEndpointId: target.webhook_endpoint_id ? String(target.webhook_endpoint_id) : null,
                        ...(kind === 'x' && delivery.x_processing_mode === 'realtime' ? { xRealtimeAdmittedAtMs: handoffAtMs } : {}) },
                    // Preserve the observed price, never refetch current prices
                    // to compose an older scheduled notification.
                    defaultPriceText: kind === 'price' && !transformed ? delivery.message_text : null };
                // X defaults to the ordinary Bot expansion path. Existing
                // auto/price workflows keep their current default display.
                if (kind === 'x' && !transformed) {
                    plan.display = { ...plan.display, format: 'normal' };
                    plan.text = require('./text-transform').outputText(plan.display, plan.event);
                }
                const destinationKey = destinationId || `${kind}:${target.id}:${target.destination_key}`;
                let due = plan.dueAtMs;
                if (plan.aggregate && !plan.aggregateClosed) due = scheduleDelivery((Math.floor(due / (plan.aggregate.minutes * MINUTE)) + 1) * plan.aggregate.minutes * MINUTE, plan.schedules, plan.deadlineMs ?? Infinity);
                if (due === null) {
                    routingTrace.push({ nodeId: plan.aggregate?.nodeId || plan.path.at(-1), outcome: 'expired', reason: 'まとめ通知の時刻が通知期限・通知可能時間を超えるため送りません' });
                    continue;
                }
                const jobId = randomUUID(), key = groupKey(target.workflow_id || `${kind}:${target.id}`, target.active_revision || 0, destinationKey, plan, plan.dueAtMs);
                let parentId = null;
                if (key) {
                    await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,?)', [key, due + 86400000]);
                    await query('SELECT counter_key FROM automation_counters WHERE counter_key=? FOR UPDATE', [key]);
                    // Keep each target isolated: deleting/editing one monitor
                    // cannot leave its event in another monitor's aggregate.
                    const parents = await query("SELECT j.* FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE j.group_key=? AND j.state='pending' AND j.due_at_ms=? AND r.target_kind=? AND r.target_id=? ORDER BY j.created_at_ms DESC LIMIT 1 FOR UPDATE", [key, due, kind, target.id]);
                    if (parents[0]) {
                        const parent = parents[0], parentPlan = parse(parent.plan_json), members = parentPlan.members || [];
                        const receivedCount = Number(parentPlan.aggregateCount || members.length);
                        if (receivedCount < plan.aggregate.maxItems) {
                            const entry = { jobId, text: plan.text, event: plan.event, display: plan.display, targetKind: kind, defaultPriceText: plan.defaultPriceText, ...(kind === 'x' ? { context: plan.context } : {}) };
                            parentPlan.members = plan.aggregate.mode === 'latest' ? [entry] : [...members, entry];
                            parentPlan.aggregateCount = receivedCount + 1;
                            parentPlan.deadlineMs = plan.aggregate.mode === 'latest' ? plan.deadlineMs : earliest(parent.deadline_ms, plan.deadlineMs);
                            if (plan.aggregate.mode === 'latest') { parentPlan.limits = plan.limits; parentPlan.latestTrace = evaluation.trace; }
                            const serialized = JSON.stringify(parentPlan);
                            if (Buffer.byteLength(serialized) <= 1024 * 1024) {
                                parentId = parent.id;
                                if (plan.aggregate.mode === 'latest') await query("UPDATE automation_jobs SET state='excluded',last_error_code='AGGREGATE_SUPERSEDED',updated_at_ms=? WHERE parent_job_id=? AND state='aggregated'", [now, parentId]);
                                await query('UPDATE automation_jobs SET plan_json=?,deadline_ms=?,updated_at_ms=? WHERE id=?', [serialized, parentPlan.deadlineMs, now, parentId]);
                            }
                        }
                    }
                    if (!parentId) { plan.members = [{ jobId, text: plan.text, event: plan.event, display: plan.display, targetKind: kind, defaultPriceText: plan.defaultPriceText, ...(kind === 'x' ? { context: plan.context } : {}) }]; plan.aggregateCount = 1; }
                }
                await query('INSERT INTO automation_jobs (id,run_id,destination_id,group_key,parent_job_id,plan_json,due_at_ms,deadline_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    [jobId, runId, destinationId, key, parentId, JSON.stringify(plan), due, plan.deadlineMs, parentId ? 'aggregated' : 'pending', now, now]);
                plannedJobs++;
            }
            if (!plannedJobs || routingTrace.length !== evaluation.trace.length) await query('UPDATE automation_runs SET state=?,trace_json=? WHERE id=?', [plannedJobs ? 'queued' : 'excluded', JSON.stringify(routingTrace), runId]);
            await finishLegacy(query, kind, delivery, 'routed', handoffAtMs, null, null, nativeWindow);
            return { state: 'routed', runId };
        });
    }
    async function routeX(input, now = clock()) {
        if (!input || !/^\d{1,32}$/.test(String(input.ownerUserId || '')) || !/^[1-9]\d{0,19}$/.test(String(input.monitorId || ''))
            || !/^[1-9]\d{0,19}$/.test(String(input.inboxEventId || '')) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(input.subscriptionId || ''))
            || input.processingMode !== undefined && !['batch','realtime'].includes(input.processingMode)) fail('X_NOTIFICATION_INBOX_INVALID', 'X通知の受信元を確認できません。');
        const inbox = (await queryDB("SELECT i.subscription_revision,i.received_at_ms FROM automation_x_push_inbox i JOIN automation_x_subscriptions s ON s.id=i.subscription_id WHERE i.id=? AND i.subscription_id=? AND s.owner_user_id=? AND i.subscription_revision=s.revision AND i.status IN ('received','routed')", [String(input.inboxEventId), input.subscriptionId, String(input.ownerUserId)]))[0];
        if (!inbox) return { state: 'cancelled', code: 'X_NOTIFICATION_INBOX_CHANGED' };
        if (!require('./recovery-origin').inboxAllowed({ id: input.inboxEventId, subscriptionId: input.subscriptionId, revision: Number(inbox.subscription_revision), receivedAtMs: Number(inbox.received_at_ms) })) return { state: 'cancelled', code: 'RECOVERY_QUARANTINED' };
        const notification = require('./x-event-router').normalizeXNotification(input.payload, { receivedAtMs: Number(inbox.received_at_ms) });
        const delivery = { id: String(input.inboxEventId), target_id: String(input.monitorId), owner_user_id: String(input.ownerUserId),
            subscription_id: input.subscriptionId, subscription_revision: Number(inbox.subscription_revision), x_notification: notification, x_processing_mode: input.processingMode };
        admittedXInputs.add(delivery);
        return route('x', delivery, now);
    }
    async function claim(now = Date.now()) {
        return db.withDatabaseTransaction(async query => {
            // A crashed process may have submitted a message before its DB ACK.
            // Never recycle a sending lease into pending automatically.
            await query("UPDATE automation_jobs SET state=IF(sent_steps>0 OR discord_message_id IS NOT NULL,'partial','failed'),last_error_code='LEGACY_REVIEW_ENDED',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE state='held'", [now]);
            await query("UPDATE automation_jobs SET state='unknown',last_error_code='SEND_LEASE_EXPIRED',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE state='sending' AND lease_until_ms<=?", [now, now]);
            await query("UPDATE automation_jobs child JOIN automation_jobs parent ON child.parent_job_id=parent.id SET child.state=parent.state,child.last_error_code=parent.last_error_code,child.updated_at_ms=? WHERE child.state='aggregated' AND parent.state IN ('unknown','partial','cancelled','sent','failed','expired','excluded')", [now]);
            const priorityKey = hash('automation:discord:priority-turn');
            await query('INSERT INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,?) ON DUPLICATE KEY UPDATE counter_key=VALUES(counter_key)', [priorityKey, Number.MAX_SAFE_INTEGER]);
            const turn = Number((await query('SELECT used_count FROM automation_counters WHERE counter_key=? FOR UPDATE', [priorityKey]))[0]?.used_count || 0) % 4;
            const square = require('./square-billing').getSquareScope();
            const supporter = `u.is_donor=1${square.configured ? ' OR ds.active=1' : ''}`;
            const priority = `COALESCE(p.priority,${square.configured ? 'sp.priority,' : ''}b.priority,IF(${supporter},1,0))`;
            const validPolicy = alias => `${alias}.slot_limit BETWEEN 1 AND 10000 AND ${alias}.minute_limit BETWEEN 1 AND 10000 AND ${alias}.day_limit BETWEEN 1 AND 1000000 AND ${alias}.priority BETWEEN 0 AND 100`;
            // Three priority turns, then an oldest-first turn. This durable
            // shared fair turn also serves lower nonzero priorities when an
            // administrator changes the free/supporter defaults.
            const rows = await query(`SELECT j.*,r.workflow_id,r.revision,r.target_kind,r.target_id,r.owner_user_id,r.guild_id,r.scope
                FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
                LEFT JOIN users u ON u.user_id=r.owner_user_id
                LEFT JOIN automation_notification_entitlements e ON e.owner_user_id=r.owner_user_id AND (e.expires_at_ms IS NULL OR e.expires_at_ms>?)
                LEFT JOIN automation_notification_plans p ON p.plan_id=e.plan_id AND p.enabled=1 AND p.plan_id NOT IN ('free','supporter') AND ${validPolicy('p')}
                ${square.configured ? `LEFT JOIN automation_square_subscriptions ss ON ss.owner_user_id=r.owner_user_id AND ss.environment=? AND ss.merchant_id=? AND ss.verified=1 AND ss.state IN ('ACTIVE','CANCELED') AND ss.valid_until_at_ms>?
                LEFT JOIN automation_notification_plans sp ON sp.plan_id=ss.plan_id AND sp.enabled=1 AND sp.plan_id NOT IN ('free','supporter') AND ${validPolicy('sp')}
                LEFT JOIN automation_square_donation_policy dp ON dp.environment=? AND dp.merchant_id=? AND dp.currency IS NOT NULL
                LEFT JOIN automation_square_donation_supporters ds ON ds.owner_user_id=r.owner_user_id AND ds.environment=dp.environment AND ds.merchant_id=dp.merchant_id AND ds.policy_updated_at_ms=dp.updated_at_ms AND ds.active=1 AND (ds.valid_until_at_ms IS NULL OR ds.valid_until_at_ms>?)` : ''}
                LEFT JOIN automation_notification_plans b ON b.plan_id=IF(${supporter},'supporter','free') AND ${validPolicy('b')} WHERE
                (j.state='pending' AND j.due_at_ms<=? OR j.state='leased' AND j.lease_until_ms<=?)
                ORDER BY ${turn === 3 ? '' : `${priority} DESC,`}j.due_at_ms,j.created_at_ms,j.id LIMIT 1 FOR UPDATE`, [now, ...(square.configured ? [square.environment, square.merchantId, now, square.environment, square.merchantId, now] : []), now, now]);
            if (!rows.length) return null;
            const job = rows[0], token = randomUUID();
            let plan;
            try {
                plan = parse(job.plan_json);
                if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.schedules) || !plan.context || typeof plan.context !== 'object' || Array.isArray(plan.context)) throw new Error('QUEUE_PLAN_INVALID');
            } catch {
                // One corrupt legacy snapshot must not roll back cleanup and
                // keep every later job (or old safety hold) stuck indefinitely.
                const state = Number(job.sent_steps) > 0 || job.discord_message_id ? 'partial' : 'failed';
                await query("UPDATE automation_jobs SET state=?,last_error_code='QUEUE_PLAN_INVALID',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE id=?", [state, now, job.id]);
                await query("UPDATE automation_jobs SET state=?,last_error_code='QUEUE_PLAN_INVALID',updated_at_ms=? WHERE parent_job_id=? AND state='aggregated'", [state, now, job.id]);
                return null;
            }
            await query("UPDATE automation_jobs SET state='leased',lease_token=?,lease_until_ms=?,updated_at_ms=? WHERE id=?", [token, now + 120000, now, job.id]);
            await query('UPDATE automation_counters SET used_count=? WHERE counter_key=?', [(turn + 1) % 4, priorityKey]);
            return { ...job, state: 'leased', lease_token: token, lease_until_ms: now + 120000, plan };
        });
    }
    async function validFlowMembers(query, job, plan, lock = false, now = clock()) {
        const members = Array.isArray(plan.members) ? plan.members : [];
        const accepted = [], missing = [];
        const currentOrigins = await require('./recovery-origin').currentRunIds(query, members.map(member => member?.runId));
        const eligibility = new Map();
        // Locked X/mixed flows share this connection's owner mutex and current
        // snapshot. Do not depend on a DB adapter implicitly merging nested
        // transactions (or opening another connection waiting on our mutex).
        const entitlementDb = lock && containsX(job, plan) ? { withDatabaseTransaction: work => work(query) } : db;
        let paused = false, eligibilityCode = null, pauseCode = null, pauseDueAtMs = null;
        for (const member of members) {
            if (member && !currentOrigins.has(member.runId)) { eligibilityCode = 'RECOVERY_QUARANTINED'; missing.push(member); continue; }
            if (member && now > require('./flow-projector').memberDeadline(member)) { missing.push(member); continue; }
            if (!member || !['auto', 'price', 'x'].includes(member.targetKind) || !/^\d{1,20}$/.test(String(member.targetId))) { missing.push(member); continue; }
            const key = `${member.targetKind}:${member.targetId}`;
            if (!eligibility.has(key)) {
                try {
                    await require('./entitlements').resolveNotificationEntitlement(entitlementDb, { ownerUserId: job.owner_user_id, targetKind: member.targetKind, targetId: String(member.targetId) });
                    eligibility.set(key, true);
                } catch (error) {
                    if (!['AUTOMATION_SLOT_LIMIT', 'AUTOMATION_NOT_FOUND'].includes(error.code)) throw error;
                    if (error.code === 'AUTOMATION_SLOT_LIMIT') eligibilityCode = error.code;
                    eligibility.set(key, false);
                }
            }
            if (!eligibility.get(key)) { missing.push(member); continue; }
            const target = await snapshot(query, member.targetKind, member.targetId, lock, job.owner_user_id);
            if (member.targetKind === 'x') {
                const status = await xEligibility(query, target, clock(), lock, member.context?.xRealtimeAdmittedAtMs);
                if (status.state === 'pending') { paused = true; pauseCode = status.code; pauseDueAtMs = Math.max(pauseDueAtMs || 0, status.dueAtMs || clock() + MINUTE); }
                else if (status.state !== 'ready') { eligibilityCode = status.code; missing.push(member); continue; }
            }
            const valid = target?.enabled && !target.deleted_at_ms && target.user_id === job.owner_user_id
                && targetIdentity(target) === member.targetIdentity && (job.workflow_id || null) === (target.workflow_id || null)
                && await monitorRevisionMatches(query, member.targetKind, target, Number(member.monitorRevision), job.owner_user_id);
            if (!valid) { missing.push(member); continue; }
            if (job.workflow_id && !target.workflow_enabled) paused = true;
            accepted.push(member);
        }
        return { accepted, changed: missing.length > 0, paused, eligibilityCode, pauseCode, pauseDueAtMs };
    }
    async function refreshFlowJob(job, now = Date.now()) {
        if (!job.plan?.flowV2) return { state: 'ready', job };
        return db.withDatabaseTransaction(async query => {
            const rows = await query('SELECT * FROM automation_jobs WHERE id=? FOR UPDATE', [job.id]);
            const row = rows[0];
            if (!row || row.state !== 'leased' || row.lease_token !== job.lease_token || Number(row.lease_until_ms) <= now) return { state: 'lease_lost' };
            let plan;
            try { plan = parse(row.plan_json); } catch { return { state: 'failed', code: 'QUEUE_PLAN_INVALID' }; }
            if (!plan?.flowV2 || !Array.isArray(plan.members)) return { state: 'failed', code: 'QUEUE_PLAN_INVALID' };
            const status = await validFlowMembers(query, job, plan, true, now);
            if (!status.accepted.length && plan.members.length && plan.members.every(member => now > require('./flow-projector').memberDeadline(member))) return { state: 'expired', code: 'DEADLINE_EXCEEDED' };
            if (!status.accepted.length) return status.eligibilityCode ? { state: 'excluded', code: status.eligibilityCode } : { state: 'cancelled', code: 'FLOW_MEMBERS_CANCELLED' };
            let snapshotChanged = false;
            if (!Number.isSafeInteger(plan.flowV2.originalDueAtMs)) {
                // Preserve the current reservation of pre-fix queued jobs. A
                // temporary expiry wake must not replace a user's lower bound.
                plan.flowV2.originalDueAtMs = Number(row.due_at_ms); snapshotChanged = true;
            }
            if (typeof plan.aggregateSnapshot !== 'boolean' && plan.flowV2.sendId) {
                // Old queued flow-v2 snapshots did not distinguish singleton
                // events from genuine one-item aggregates. Recover the exact
                // immutable send unit rather than guessing from member count.
                const source = (await query('SELECT u.* FROM automation_flow_sends s JOIN automation_flow_units u ON u.id=s.unit_id WHERE s.id=?', [plan.flowV2.sendId]))[0];
                if (!source) return { state: 'failed', code: 'FLOW_UNIT_INVALID' };
                try { const unit = require('./flow-projector').safeUnit(source); plan.aggregateSnapshot = unit.kind !== 'event' || !!unit.ancestry?.some(stage => stage.batchId); }
                catch { return { state: 'failed', code: 'FLOW_UNIT_INVALID' }; }
                snapshotChanged = true;
            }
            const currentDeadline = require('./flow-projector').jobDeadline(status.accepted);
            if (status.changed || snapshotChanged || plan.deadlineMs !== currentDeadline || (row.deadline_ms == null ? null : Number(row.deadline_ms)) !== currentDeadline) {
                const memberIds = new Set(status.accepted.map(member => member.id));
                const removed = plan.members.filter(member => !memberIds.has(member.id)).map(member => ({ memberId: member.id, runId: member.runId,
                    code: now > require('./flow-projector').memberDeadline(member) ? 'DEADLINE_EXCEEDED' : status.eligibilityCode || 'MONITOR_CHANGED' }));
                plan.flowV2.excludedMembers = [...new Map([...(plan.flowV2.excludedMembers || []), ...removed].map(member => [member.memberId, member])).values()];
                plan.members = status.accepted;
                plan.flowV2.members = (plan.flowV2.members || []).filter(member => memberIds.has(member.memberId));
                plan.event = plan.members[0].event; plan.display = plan.members[0].display; plan.text = plan.members[0].text; plan.defaultPriceText = plan.members[0].defaultPriceText || null;
                plan.deadlineMs = require('./flow-projector').jobDeadline(plan.members);
                plan.schedules = require('./flow-projector').uniqueSchedules(plan.members);
                await query('UPDATE automation_jobs SET plan_json=?,deadline_ms=?,updated_at_ms=? WHERE id=? AND lease_token=?', [JSON.stringify(plan), plan.deadlineMs, now, job.id, job.lease_token]);
                await require('./flow-history').refreshFlowHistory(query, [...plan.flowV2.members, ...plan.flowV2.excludedMembers].map(member => member.runId));
            }
            return { state: status.paused ? 'pending' : 'ready', code: status.paused ? status.pauseCode || 'WORKFLOW_PAUSED' : null, dueAtMs: status.paused ? status.pauseDueAtMs || now + 60000 : null, job: { ...job, deadline_ms: plan.deadlineMs, plan } };
        });
    }
    async function check(job, now = Date.now(), query = queryDB, lock = false) {
        // Public preflight can cancel a job before beginSend is reached. Its X
        // monitor, pool rank and audit reads need the same atomic owner fence.
        if (!lock && containsX(job)) return db.withDatabaseTransaction(transactionQuery => check(job, now, transactionQuery, true));
        // Package safety performs ordinary reads. Acquire the X owner mutex
        // before those reads establish a REPEATABLE READ snapshot, otherwise a
        // concurrent committed move can mix a new monitor with old ranks/audit.
        if (lock && containsX(job)) await require('./entitlements').lockOwner(query, job.owner_user_id);
        if (!job.plan?.flowV2 && !(await require('./recovery-origin').currentRunIds(query, [job.run_id])).has(job.run_id)) return { state: 'cancelled', code: 'RECOVERY_QUARANTINED' };
        try { await require('./package-safety').assertPackageSafety(query, job); }
        catch (error) { if (error instanceof require('./safety').SafetyError) return { state: error.decision === 'deny' ? 'excluded' : 'failed', code: error.code }; throw error; }
        if (job.plan?.flowV2) {
            const flow = await validFlowMembers(query, job, job.plan, lock, now);
            if (!flow.accepted.length && job.plan.members.length && job.plan.members.every(member => now > require('./flow-projector').memberDeadline(member))) return { state: 'expired', code: 'DEADLINE_EXCEEDED' };
            if (!flow.accepted.length) return flow.eligibilityCode ? { state: 'excluded', code: flow.eligibilityCode } : { state: 'cancelled', code: 'FLOW_MEMBERS_CANCELLED' };
            if (flow.changed) return { state: 'pending', code: 'FLOW_MEMBERSHIP_CHANGED', dueAtMs: now };
            if (flow.paused) return { state: 'pending', code: flow.pauseCode || 'WORKFLOW_PAUSED', dueAtMs: flow.pauseDueAtMs || now + 60000 };
            const target = await snapshot(query, flow.accepted[0].targetKind, flow.accepted[0].targetId, lock, job.owner_user_id);
            if (job.deadline_ms != null && now > Number(job.deadline_ms)) return { state: 'expired', code: 'DEADLINE_EXCEEDED' };
            const window = require('./flow-projector').flowDeliveryWindow(flow.accepted, Math.max(Number(job.due_at_ms), job.plan.flowV2.originalDueAtMs ?? 0, now));
            if (!window) return { state: 'expired', code: 'NO_DELIVERY_WINDOW' };
            if (window.dueAtMs > now) return { state: 'pending', code: 'WAIT_FOR_WINDOW', dueAtMs: window.dueAtMs };
            return checkDestination(query, job, target, now);
        }
        const target = await snapshot(query, job.target_kind, job.target_id, lock, job.owner_user_id);
        if (!target?.enabled || targetIdentity(target) !== job.plan.targetIdentity || target.deleted_at_ms || (job.workflow_id || null) !== (target.workflow_id || null)
            || !await monitorRevisionMatches(query, job.target_kind, target, job.plan.monitorRevision, job.owner_user_id)) return { state: 'cancelled', code: 'MONITOR_CHANGED' };
        if (job.target_kind === 'x') {
            if (target.user_id !== job.owner_user_id) return { state: 'cancelled', code: 'X_MONITOR_CHANGED' };
            const anchors = [job.plan.context?.xRealtimeAdmittedAtMs, ...(job.plan.members || []).map(member => member.context?.xRealtimeAdmittedAtMs)].filter(value => Number.isSafeInteger(value) && value >= 0);
            const status = await xEligibility(query, target, now, lock, anchors.length ? Math.max(...anchors) : null);
            if (status.state !== 'ready') return status;
        }
        if (job.deadline_ms != null && now > Number(job.deadline_ms)) return { state: 'expired', code: 'DEADLINE_EXCEEDED' };
        if (job.workflow_id && !target.workflow_enabled) return { state: 'pending', code: 'WORKFLOW_PAUSED', dueAtMs: now + 60000 };
        const next = scheduleDelivery(Math.max(Number(job.due_at_ms), now), job.plan.schedules, job.deadline_ms == null ? Infinity : Number(job.deadline_ms));
        if (next === null) return { state: 'expired', code: 'NO_DELIVERY_WINDOW' };
        if (next > now) return { state: 'pending', code: 'WAIT_FOR_WINDOW', dueAtMs: next };
        return checkDestination(query, job, target, now);
    }
    async function checkDestination(query, job, target, now) {
        if (job.destination_id) {
            const rows = await query('SELECT * FROM automation_destinations WHERE id=?', [job.destination_id]);
            const dest = rows[0];
            if (!dest || dest.deleted_at_ms) return { state: 'cancelled', code: 'DESTINATION_DELETED' };
            if (!dest.enabled) return { state: 'pending', code: 'DESTINATION_DISABLED', dueAtMs: now + 60000 };
            if ((job.target_kind === 'x' || job.plan?.members?.some(member => member.targetKind === 'x')) && (dest.scope !== 'private' || dest.owner_user_id !== job.owner_user_id)) return { state: 'cancelled', code: 'DESTINATION_SCOPE_CHANGED' };
            if (dest.scope === 'private' && dest.owner_user_id !== job.owner_user_id || job.scope === 'guild' && (dest.scope !== 'guild' || dest.guild_id !== job.guild_id) || dest.kind === 'dm' && dest.dm_user_id !== job.owner_user_id) return { state: 'cancelled', code: 'DESTINATION_SCOPE_CHANGED' };
            return { state: 'ready', destination: dest, target };
        }
        return { state: 'ready', destination: { kind: target.destination_type, dm_user_id: target.user_id, webhook_endpoint_id: target.webhook_endpoint_id, guild_id: target.guild_id, channel_id: target.origin_channel_id, owner_user_id: target.user_id }, target };
    }
    async function transition(job, state, code = null, dueAtMs = null) {
        return db.withDatabaseTransaction(async query => {
            const result = await query("UPDATE automation_jobs SET state=?,last_error_code=?,due_at_ms=COALESCE(?,due_at_ms),lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE id=? AND lease_token=? AND state IN ('leased','sending')", [state, code, dueAtMs, Date.now(), job.id, job.lease_token]);
            if (Number(result.affectedRows) === 1 && !['pending', 'leased', 'sending', 'held'].includes(state)) await query('UPDATE automation_jobs SET state=?,last_error_code=?,updated_at_ms=? WHERE parent_job_id=? AND state=\'aggregated\'', [state, code, Date.now(), job.id]);
            if (Number(result.affectedRows) === 1 && job.plan?.flowV2) await require('./flow-history').refreshFlowHistory(query, job.plan.flowV2.members.map(member => member.runId));
            return Number(result.affectedRows) === 1;
        });
    }
    async function beginSend(job, now = Date.now()) {
        return db.withDatabaseTransaction(async query => {
            const rows = await query('SELECT * FROM automation_jobs WHERE id=? FOR UPDATE', [job.id]);
            if (rows[0]?.state !== 'leased' || rows[0]?.lease_token !== job.lease_token || Number(rows[0]?.lease_until_ms) <= now) return { state: 'lease_lost' };
            const checkResult = await check(job, now, query, true);
            if (checkResult.state !== 'ready') return checkResult;
            const plan = parse(rows[0].plan_json);
            const keys = (plan.limitsCharged ? [] : plan.limits || []).map(limit => ({ ...limit, counterKey: hash(JSON.stringify(['limit', job.workflow_id, job.revision, limit.nodeId, limit.group, Math.floor(now / (limit.minutes * MINUTE))])), until: (Math.floor(now / (limit.minutes * MINUTE)) + 1) * limit.minutes * MINUTE })).sort((a, b) => a.counterKey.localeCompare(b.counterKey));
            for (const gate of keys) {
                await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,?)', [gate.counterKey, gate.until]);
                const counters = await query('SELECT used_count FROM automation_counters WHERE counter_key=? FOR UPDATE', [gate.counterKey]);
                if (Number(counters[0].used_count) >= gate.count) {
                    if (gate.overflow === 'drop') return { state: 'excluded', code: 'RATE_GATE_LIMIT' };
                    const due = scheduleDelivery(gate.until, plan.schedules, plan.deadlineMs ?? Infinity);
                    return due === null ? { state: 'expired', code: 'RATE_GATE_DEADLINE' } : { state: 'pending', code: 'RATE_GATE_DEFERRED', dueAtMs: due };
                }
            }
            for (const gate of keys) await query('UPDATE automation_counters SET used_count=used_count+1 WHERE counter_key=?', [gate.counterKey]);
            plan.limitsCharged = true;
            await query("UPDATE automation_jobs SET state='sending',plan_json=?,attempts=attempts+1,lease_until_ms=?,updated_at_ms=? WHERE id=? AND lease_token=?", [JSON.stringify(plan), now + 120000, now, job.id, job.lease_token]);
            return { state: 'sending', attempts: Number(rows[0].attempts) + 1 };
        });
    }
    async function acknowledgeStep(job, messageId) {
        if (!/^\d{16,22}$/.test(String(messageId))) fail('DELIVERY_UNKNOWN', '送信結果を確認できません。');
        const result = await queryDB("UPDATE automation_jobs SET sent_steps=sent_steps+1,discord_message_id=?,lease_until_ms=?,updated_at_ms=? WHERE id=? AND lease_token=? AND state='sending'", [String(messageId), Date.now() + 120000, Date.now(), job.id, job.lease_token]);
        if (Number(result.affectedRows) !== 1) fail('DELIVERY_UNKNOWN', '送信後の記録を確認できません。');
    }
    async function renewLease(job, now = Date.now()) {
        const result = await queryDB("UPDATE automation_jobs SET lease_until_ms=?,updated_at_ms=? WHERE id=? AND lease_token=? AND state IN ('leased','sending') AND lease_until_ms>?", [now + 120000, now, job.id, job.lease_token, now]);
        return Number(result.affectedRows) === 1;
    }
    return { route, routeX, claim, check, refreshFlowJob, beginSend, transition, acknowledgeStep, renewLease };
}
function earliest(a, b) { return a == null ? b ?? null : b == null ? Number(a) : Math.min(Number(a), Number(b)); }
function targetIdentity(target) { return hash(JSON.stringify([String(target.source_id), target.destination_key, target.rule_key || null, target.user_id, target.guild_id])); }
module.exports = { createQueue, deliveryEvent, groupKey, earliest, targetIdentity };
