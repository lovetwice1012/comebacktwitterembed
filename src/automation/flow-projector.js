'use strict';

const { hash } = require('./service');
const { outputText } = require('./text-transform');
const { scheduleDelivery } = require('./schedule');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const uuid = value => { const digest = hash(value); return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`; };
const invalid = code => Object.assign(new Error(code), { code });
const memberDeadline = member => Math.min(member.deadlineMs ?? Infinity, member.scheduleDeadlineMs ?? Infinity);
// A job remains useful while any member is within its own frozen deadline.
// refreshFlowJob removes expired members before rendering or reserving quota.
const jobDeadline = members => { const deadline = Math.max(...members.map(memberDeadline)); return Number.isFinite(deadline) ? deadline : null; };
const uniqueSchedules = members => [...new Map(members.flatMap(member => member.schedules || []).map(value => [JSON.stringify(value), value])).values()];
function flowDeliveryWindow(members, earliest) {
    // A requested due time is a lower bound. Members that cannot survive until
    // it never constrain a later healthy peer's delivery window.
    const eligible = members.filter(member => earliest <= memberDeadline(member));
    if (!eligible.length) return null;
    const deadlineMs = jobDeadline(eligible), schedules = uniqueSchedules(eligible);
    const due = scheduleDelivery(earliest, schedules, deadlineMs ?? Infinity);
    const firstExpiry = Math.min(...eligible.map(memberDeadline));
    // Conflicting member schedules can become compatible when the earliest
    // member expires. Wake once at that immutable boundary, then prune only
    // expired members; do not extend their horizons or truncate the batch.
    const pruneAt = firstExpiry < (deadlineMs ?? Infinity) ? firstExpiry + 1 : Infinity;
    const dueAtMs = Math.min(due ?? Infinity, pruneAt);
    return Number.isFinite(dueAtMs) ? { dueAtMs, deadlineMs, schedules } : null;
}

function safeUnit(row) {
    if (!row || hash(row.payload_json) !== row.checksum) throw invalid('FLOW_UNIT_CORRUPT');
    const unit = parse(row.payload_json);
    if (!unit || !Array.isArray(unit.members) || !unit.members.length) throw invalid('FLOW_UNIT_INVALID');
    return unit;
}
function createFlowProjector(db) {
    async function projectOne(now = Date.now()) {
        return db.withDatabaseTransaction(async query => {
            const pending = await query("SELECT * FROM automation_flow_sends WHERE state='unprojected' ORDER BY created_at_ms,id LIMIT 1");
            if (!pending.length) return null;
            await query('INSERT INTO automation_flow_locks (namespace_key) VALUES (?) ON DUPLICATE KEY UPDATE namespace_key=VALUES(namespace_key)', [pending[0].namespace_key]);
            const sends = await query("SELECT * FROM automation_flow_sends WHERE id=? AND state='unprojected' FOR UPDATE", [pending[0].id]);
            if (!sends.length) return null;
            const send = sends[0];
            let unit;
            try { unit = safeUnit((await query('SELECT * FROM automation_flow_units WHERE id=? FOR UPDATE', [send.unit_id]))[0]); }
            catch (error) {
                if (!['FLOW_UNIT_CORRUPT','FLOW_UNIT_INVALID'].includes(error.code)) throw error;
                await query("UPDATE automation_flow_sends SET state='failed' WHERE id=?", [send.id]);
                const origins = await query('SELECT DISTINCT run_id FROM automation_flow_members WHERE unit_id=?', [send.unit_id]);
                await require('./flow-history').refreshFlowHistory(query, origins.map(row => row.run_id));
                return { state: 'failed', code: error.code, id: send.id };
            }
            const runIds = [...new Set(unit.members.map(member => member.runId))];
            await require('./recovery-origin').currentRunIds(query, runIds, { revoke: true, now });
            const flowRuns = await query('SELECT run_id,context_json,revoked_at_ms FROM automation_flow_runs WHERE run_id IN (?) FOR UPDATE', [runIds]);
            if (flowRuns.length !== runIds.length) throw invalid('FLOW_MEMBER_NAMESPACE');
            const contexts = new Map(flowRuns.map(row => [row.run_id, { ...parse(row.context_json), revokedAtMs: row.revoked_at_ms == null ? null : Number(row.revoked_at_ms) }]));
            const partitions = new Map(); let invalidDestination = false; const removed = [];
            for (const source of unit.members) {
                const context = contexts.get(source.runId);
                if (!context || context.revokedAtMs != null) { removed.push({ memberId: source.id, runId: source.runId, outcome: 'excluded', reason: 'ALL_MEMBERS_REVOKED' }); continue; }
                if (now > memberDeadline(source)) { removed.push({ memberId: source.id, runId: source.runId, outcome: 'expired', reason: 'DEADLINE_EXCEEDED' }); continue; }
                const destinationId = send.destination_alias === 'default' ? context.destinationId : context.bindings?.destinations?.[send.destination_alias];
                const legacy = send.destination_alias === 'default' && destinationId == null && (context.sourceContext?.destinationType === 'dm' || context.sourceContext?.destinationType === 'webhook' && context.sourceContext?.webhookEndpointId);
                if (!legacy && !/^[0-9a-f-]{36}$/i.test(destinationId || '')) { invalidDestination = true; removed.push({ memberId: source.id, runId: source.runId, outcome: 'excluded', reason: 'FLOW_DESTINATION_MISSING' }); continue; }
                // Legacy registrations have no Dashboard destination row. Keep
                // distinct webhook endpoints apart while sharing an owner's DM.
                const partitionKey = destinationId || JSON.stringify([context.ownerUserId, context.guildId, context.sourceContext.destinationType, context.sourceContext.webhookEndpointId]);
                if (!partitions.has(partitionKey)) partitions.set(partitionKey, { destinationId, members: [] });
                const member = { ...source, targetKind: context.targetKind, targetId: String(context.targetId), monitorRevision: context.monitorRevision, targetIdentity: context.targetIdentity,
                    context: { userId: context.ownerUserId, guildId: context.guildId, locale: context.locale || 'ja', ...context.sourceContext },
                    text: outputText(source.display, source.event) };
                partitions.get(partitionKey).members.push(member);
            }
            if (removed.length) {
                const activation = (await query('SELECT node_id,decision_json FROM automation_flow_steps WHERE id=? FOR UPDATE', [send.activation_id]))[0];
                if (activation) {
                    const decision = parse(activation.decision_json) || {};
                    decision.trace = [...(decision.trace || []), ...removed.map(member => ({ nodeId: activation.node_id, ...member }))];
                    await query('UPDATE automation_flow_steps SET decision_json=? WHERE id=?', [JSON.stringify(decision), send.activation_id]);
                }
            }
            if (!partitions.size) {
                const state = invalidDestination ? 'failed' : removed.some(member => member.outcome === 'expired') ? 'expired' : 'cancelled';
                await query('UPDATE automation_flow_sends SET state=? WHERE id=?', [state, send.id]);
                await require('./flow-history').refreshFlowHistory(query, runIds);
                return { state, ...(invalidDestination ? { code: 'FLOW_DESTINATION_MISSING' } : {}), id: send.id };
            }
            const jobs = [];
            for (const [partitionKey, { destinationId, members }] of partitions) {
                const schedules = uniqueSchedules(members), rawDue = Math.max(now, ...members.map(member => Number(member.dueAtMs) || now)), deadlineMs = jobDeadline(members);
                const window = flowDeliveryWindow(members, rawDue);
                if (!window) continue;
                const dueAtMs = window.dueAtMs;
                const first = members[0], firstContext = first.context;
                const plan = { flowV2: { sendId: send.id, originalDueAtMs: rawDue, members: members.map(member => ({ memberId: member.id, runId: member.runId, targetKind: member.targetKind, targetId: member.targetId, monitorRevision: member.monitorRevision, targetIdentity: member.targetIdentity })) },
                    members, aggregateSnapshot: unit.kind !== 'event' || !!unit.ancestry?.some(stage => stage.batchId), event: first.event, display: first.display, text: first.text, defaultPriceText: first.defaultPriceText || null, schedules, deadlineMs, context: firstContext, dictionaryRefs: contexts.get(first.runId).bindings?.dictionaries || {} };
                const id = uuid(`flow-job:${send.id}:${partitionKey}`), runId = members[0].runId;
                await query('INSERT IGNORE INTO automation_jobs (id,run_id,destination_id,execution_version,plan_json,due_at_ms,deadline_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, runId, destinationId, 2, JSON.stringify(plan), dueAtMs, deadlineMs, 'pending', now, now]);
                await require('./flow-history').recordJobFlowMembers(query, { id, run_id: runId, execution_version: 2, plan_json: plan, created_at_ms: now });
                jobs.push(id);
            }
            await query("UPDATE automation_flow_sends SET state=? WHERE id=?", [jobs.length ? 'projected' : 'expired', send.id]);
            await require('./flow-history').refreshFlowHistory(query, runIds);
            return { state: jobs.length ? 'projected' : 'expired', id: send.id, jobs };
        });
    }
    return { projectOne };
}
module.exports = { createFlowProjector, safeUnit, uniqueSchedules, memberDeadline, jobDeadline, flowDeliveryWindow };
