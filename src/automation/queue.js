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
    async function snapshot(query, kind, id, lock = false) {
        const rows = await query(`SELECT t.*,m.scope,m.revision AS monitor_revision,m.destination_id,a.workflow_id,
            w.enabled AS workflow_enabled,w.deleted_at_ms,w.active_revision,r.definition_json,r.bindings_json
            FROM ${table(kind)}_targets t LEFT JOIN automation_monitors m ON m.target_kind=? AND m.target_id=t.id
            LEFT JOIN automation_assignments a ON a.target_kind=? AND a.target_id=t.id
            LEFT JOIN automation_workflows w ON w.id=a.workflow_id
            LEFT JOIN automation_revisions r ON r.workflow_id=w.id AND r.revision=w.active_revision WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`, [kind, kind, id]);
        return rows[0];
    }
    async function finishLegacy(query, kind, delivery, state, now, code = null) {
        const result = await query(`UPDATE ${table(kind)}_deliveries SET status=?,lease_token=NULL,lease_expires_at_ms=0,next_attempt_at_ms=?,last_error_code=? WHERE id=? AND status='pending' AND lease_token=?`,
            [state, state === 'pending' ? now + 60000 : 0, code, delivery.id, delivery.lease_token]);
        // This is the cadence window in which the event is handed to the
        // workflow, whose own timing/quiet hours can delay actual delivery.
        if (kind === 'auto' && state === 'routed' && Number(result.affectedRows) === 1) {
            await query('UPDATE auto_watch_targets SET last_notification_window_at_ms=GREATEST(COALESCE(last_notification_window_at_ms,0),?) WHERE id=?', [now, delivery.target_id]);
        }
        return Number(result.affectedRows) === 1;
    }
    async function route(kind, delivery, now = Date.now()) {
        const before = await snapshot(queryDB, kind, delivery.target_id);
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
            const target = await snapshot(query, kind, delivery.target_id, true);
            const records = await query(`SELECT status,lease_token,lease_expires_at_ms FROM ${table(kind)}_deliveries WHERE id=? FOR UPDATE`, [delivery.id]);
            const record = records[0];
            if (!record || record.status !== 'pending' || record.lease_token !== delivery.lease_token || Number(record.lease_expires_at_ms) <= clock()) return { state: 'lease_lost' };
            if (!target?.enabled || target.deleted_at_ms) {
                await finishLegacy(query, kind, delivery, 'cancelled', now, 'MONITOR_DISABLED');
                return { state: 'cancelled' };
            }
            if ((!graphEnabled && !evaluation) || target.workflow_id !== before?.workflow_id || target.active_revision !== before?.active_revision || target.monitor_revision !== before?.monitor_revision || target.workflow_id && !target.workflow_enabled) {
                await finishLegacy(query, kind, delivery, 'pending', now, 'RULE_PAUSED_OR_CHANGED');
                return { state: 'pending' };
            }
            const dedupe = hash(`delivery:${kind}:${delivery.id}`);
            const existing = await query('SELECT id FROM automation_runs WHERE dedupe_key=?', [dedupe]);
            if (existing.length) {
                await finishLegacy(query, kind, delivery, 'routed', now);
                return { state: 'routed', runId: existing[0].id };
            }
            const runId = randomUUID(), scope = scopeOf(target);
            if (graphEnabled) {
                if (typeof graph.store?.initializeInTransaction !== 'function') fail('FLOW_STORE_UNAVAILABLE', '新しいルール実行基盤を開始できません。');
                const definition = parse(target.definition_json), event = deliveryEvent(kind, delivery, now);
                const deadlineMs = definition.expiresAfterMinutes ? (event.observedAtMs ?? now) + definition.expiresAfterMinutes * MINUTE : null;
                const flowContext = { ownerUserId: target.user_id, guildId: scope === 'guild' ? target.guild_id : null, scope, workflowId: target.workflow_id, revision: Number(target.active_revision),
                    targetKind: kind, targetId: String(target.id), monitorRevision: Number(target.monitor_revision || 1), targetIdentity: targetIdentity(target),
                    destinationId: target.destination_id || null, bindings, locale: target.source_locale || 'ja',
                    sourceContext: { channelId: target.origin_channel_id || null, nsfw: !!target.origin_channel_nsfw, destinationType: target.destination_type, webhookEndpointId: target.webhook_endpoint_id ? String(target.webhook_endpoint_id) : null } };
                await query('INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,owner_user_id,guild_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    [runId, dedupe, target.workflow_id, target.active_revision, target.user_id, target.guild_id, scope, kind, target.id, JSON.stringify(event), '[]', 'flow_pending', now]);
                await graph.store.initializeInTransaction(query, { runId, context: flowContext, now, unit: { kind: 'event', ancestry: [], members: [{ id: runId, runId, event, display: structuredClone(NODE_TYPES.transform.defaults), schedules: [], dueAtMs: now, deadlineMs,
                    defaultPriceText: kind === 'price' ? delivery.message_text : null, context: flowContext.sourceContext, targetKind: kind }] } });
                await finishLegacy(query, kind, delivery, 'routed', now);
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
                        destinationType: target.destination_type, webhookEndpointId: target.webhook_endpoint_id ? String(target.webhook_endpoint_id) : null },
                    // Preserve the observed price, never refetch current prices
                    // to compose an older scheduled notification.
                    defaultPriceText: kind === 'price' && !transformed ? delivery.message_text : null };
                const destinationKey = destinationId || `${kind}:${target.id}:${target.destination_key}`;
                let due = plan.dueAtMs;
                if (plan.aggregate) due = scheduleDelivery((Math.floor(due / (plan.aggregate.minutes * MINUTE)) + 1) * plan.aggregate.minutes * MINUTE, plan.schedules, plan.deadlineMs ?? Infinity);
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
                            const entry = { jobId, text: plan.text, event: plan.event, display: plan.display, targetKind: kind, defaultPriceText: plan.defaultPriceText };
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
                    if (!parentId) { plan.members = [{ jobId, text: plan.text, event: plan.event, display: plan.display, targetKind: kind, defaultPriceText: plan.defaultPriceText }]; plan.aggregateCount = 1; }
                }
                await query('INSERT INTO automation_jobs (id,run_id,destination_id,group_key,parent_job_id,plan_json,due_at_ms,deadline_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    [jobId, runId, destinationId, key, parentId, JSON.stringify(plan), due, plan.deadlineMs, parentId ? 'aggregated' : 'pending', now, now]);
                plannedJobs++;
            }
            if (!plannedJobs || routingTrace.length !== evaluation.trace.length) await query('UPDATE automation_runs SET state=?,trace_json=? WHERE id=?', [plannedJobs ? 'queued' : 'excluded', JSON.stringify(routingTrace), runId]);
            await finishLegacy(query, kind, delivery, 'routed', now);
            return { state: 'routed', runId };
        });
    }
    async function claim(now = Date.now()) {
        return db.withDatabaseTransaction(async query => {
            // A crashed process may have submitted a message before its DB ACK.
            // Never recycle a sending lease into pending automatically.
            await query("UPDATE automation_jobs SET state=IF(sent_steps>0 OR discord_message_id IS NOT NULL,'partial','failed'),last_error_code='LEGACY_REVIEW_ENDED',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE state='held'", [now]);
            await query("UPDATE automation_jobs SET state='unknown',last_error_code='SEND_LEASE_EXPIRED',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE state='sending' AND lease_until_ms<=?", [now, now]);
            await query("UPDATE automation_jobs child JOIN automation_jobs parent ON child.parent_job_id=parent.id SET child.state=parent.state,child.last_error_code=parent.last_error_code,child.updated_at_ms=? WHERE child.state='aggregated' AND parent.state IN ('unknown','partial','cancelled','sent','failed','expired','excluded')", [now]);
            const rows = await query(`SELECT j.*,r.workflow_id,r.revision,r.target_kind,r.target_id,r.owner_user_id,r.guild_id,r.scope
                FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE
                (j.state='pending' AND j.due_at_ms<=? OR j.state='leased' AND j.lease_until_ms<=?)
                ORDER BY j.due_at_ms,j.id LIMIT 1 FOR UPDATE`, [now, now]);
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
            return { ...job, state: 'leased', lease_token: token, lease_until_ms: now + 120000, plan };
        });
    }
    async function validFlowMembers(query, job, plan, lock = false) {
        const members = Array.isArray(plan.members) ? plan.members : [];
        const accepted = [], missing = [];
        let paused = false;
        for (const member of members) {
            if (!member || !['auto', 'price'].includes(member.targetKind) || !/^\d{1,20}$/.test(String(member.targetId))) { missing.push(member); continue; }
            const target = await snapshot(query, member.targetKind, member.targetId, lock);
            const valid = target?.enabled && !target.deleted_at_ms && Number(target.monitor_revision || 1) === Number(member.monitorRevision)
                && targetIdentity(target) === member.targetIdentity && (job.workflow_id || null) === (target.workflow_id || null);
            if (!valid) { missing.push(member); continue; }
            if (job.workflow_id && !target.workflow_enabled) paused = true;
            accepted.push(member);
        }
        return { accepted, changed: missing.length > 0, paused };
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
            const status = await validFlowMembers(query, job, plan, true);
            if (!status.accepted.length) return { state: 'cancelled', code: 'FLOW_MEMBERS_CANCELLED' };
            if (status.changed) {
                const memberIds = new Set(status.accepted.map(member => member.id));
                plan.members = status.accepted;
                plan.flowV2.members = (plan.flowV2.members || []).filter(member => memberIds.has(member.memberId));
                plan.event = plan.members[0].event; plan.display = plan.members[0].display; plan.text = plan.members[0].text;
                plan.deadlineMs = earliest(plan.members.map(member => member.deadlineMs));
                await query('UPDATE automation_jobs SET plan_json=?,deadline_ms=?,updated_at_ms=? WHERE id=? AND lease_token=?', [JSON.stringify(plan), plan.deadlineMs, now, job.id, job.lease_token]);
            }
            return { state: status.paused ? 'pending' : 'ready', code: status.paused ? 'WORKFLOW_PAUSED' : null, dueAtMs: status.paused ? now + 60000 : null, job: { ...job, plan } };
        });
    }
    async function check(job, now = Date.now(), query = queryDB, lock = false) {
        try { await require('./package-safety').assertPackageSafety(query, job); }
        catch (error) { if (error instanceof require('./safety').SafetyError) return { state: error.decision === 'deny' ? 'excluded' : 'failed', code: error.code }; throw error; }
        if (job.plan?.flowV2) {
            const flow = await validFlowMembers(query, job, job.plan, lock);
            if (!flow.accepted.length) return { state: 'cancelled', code: 'FLOW_MEMBERS_CANCELLED' };
            if (flow.changed) return { state: 'pending', code: 'FLOW_MEMBERSHIP_CHANGED', dueAtMs: now };
            if (flow.paused) return { state: 'pending', code: 'WORKFLOW_PAUSED', dueAtMs: now + 60000 };
            const target = await snapshot(query, flow.accepted[0].targetKind, flow.accepted[0].targetId, lock);
            if (job.deadline_ms != null && now > Number(job.deadline_ms)) return { state: 'expired', code: 'DEADLINE_EXCEEDED' };
            const next = scheduleDelivery(Math.max(Number(job.due_at_ms), now), job.plan.schedules, job.deadline_ms == null ? Infinity : Number(job.deadline_ms));
            if (next === null) return { state: 'expired', code: 'NO_DELIVERY_WINDOW' };
            if (next > now) return { state: 'pending', code: 'WAIT_FOR_WINDOW', dueAtMs: next };
            return checkDestination(query, job, target, now);
        }
        const target = await snapshot(query, job.target_kind, job.target_id, lock);
        if (!target?.enabled || Number(target.monitor_revision || 1) !== job.plan.monitorRevision || targetIdentity(target) !== job.plan.targetIdentity || target.deleted_at_ms || (job.workflow_id || null) !== (target.workflow_id || null)) return { state: 'cancelled', code: 'MONITOR_CHANGED' };
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
            if (dest.scope === 'private' && dest.owner_user_id !== job.owner_user_id || job.scope === 'guild' && (dest.scope !== 'guild' || dest.guild_id !== job.guild_id) || dest.kind === 'dm' && dest.dm_user_id !== job.owner_user_id) return { state: 'cancelled', code: 'DESTINATION_SCOPE_CHANGED' };
            return { state: 'ready', destination: dest, target };
        }
        return { state: 'ready', destination: { kind: target.destination_type, dm_user_id: target.user_id, webhook_endpoint_id: target.webhook_endpoint_id, guild_id: target.guild_id, channel_id: target.origin_channel_id, owner_user_id: target.user_id }, target };
    }
    async function transition(job, state, code = null, dueAtMs = null) {
        return db.withDatabaseTransaction(async query => {
            const result = await query("UPDATE automation_jobs SET state=?,last_error_code=?,due_at_ms=COALESCE(?,due_at_ms),lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE id=? AND lease_token=? AND state IN ('leased','sending')", [state, code, dueAtMs, Date.now(), job.id, job.lease_token]);
            if (Number(result.affectedRows) === 1 && !['pending', 'leased', 'sending', 'held'].includes(state)) await query('UPDATE automation_jobs SET state=?,last_error_code=?,updated_at_ms=? WHERE parent_job_id=? AND state=\'aggregated\'', [state, code, Date.now(), job.id]);
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
            return { state: 'sending' };
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
    return { route, claim, check, refreshFlowJob, beginSend, transition, acknowledgeStep, renewLease };
}
function earliest(a, b) { return a == null ? b ?? null : b == null ? Number(a) : Math.min(Number(a), Number(b)); }
function targetIdentity(target) { return hash(JSON.stringify([String(target.source_id), target.destination_key, target.rule_key || null, target.user_id, target.guild_id])); }
module.exports = { createQueue, deliveryEvent, groupKey, earliest, targetIdentity };
