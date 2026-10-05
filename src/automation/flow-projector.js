'use strict';

const { hash } = require('./service');
const { outputText } = require('./text-transform');
const { scheduleDelivery } = require('./schedule');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const uuid = value => { const digest = hash(value); return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`; };
const invalid = code => Object.assign(new Error(code), { code });
const earliest = values => { const usable = values.filter(value => value != null); return usable.length ? Math.min(...usable) : null; };
const uniqueSchedules = members => [...new Map(members.flatMap(member => member.schedules || []).map(value => [JSON.stringify(value), value])).values()];
function safeUnit(row) {
    if (!row || hash(row.payload_json) !== row.checksum) throw invalid('FLOW_UNIT_CORRUPT');
    const unit = parse(row.payload_json);
    if (!unit || !Array.isArray(unit.members) || !unit.members.length) throw invalid('FLOW_UNIT_INVALID');
    return unit;
}
function createFlowProjector(db) {
    async function projectOne(now = Date.now()) {
        return db.withDatabaseTransaction(async query => {
            const sends = await query("SELECT * FROM automation_flow_sends WHERE state='unprojected' ORDER BY created_at_ms,id LIMIT 1 FOR UPDATE");
            if (!sends.length) return null;
            const send = sends[0], unit = safeUnit((await query('SELECT * FROM automation_flow_units WHERE id=? FOR UPDATE', [send.unit_id]))[0]);
            const runIds = [...new Set(unit.members.map(member => member.runId))];
            const flowRuns = await query('SELECT run_id,context_json,revoked_at_ms FROM automation_flow_runs WHERE run_id IN (?) FOR UPDATE', [runIds]);
            if (flowRuns.length !== runIds.length) throw invalid('FLOW_MEMBER_NAMESPACE');
            const contexts = new Map(flowRuns.map(row => [row.run_id, { ...parse(row.context_json), revokedAtMs: row.revoked_at_ms == null ? null : Number(row.revoked_at_ms) }]));
            const partitions = new Map();
            for (const source of unit.members) {
                const context = contexts.get(source.runId);
                if (!context || context.revokedAtMs != null) continue;
                const destinationId = send.destination_alias === 'default' ? context.destinationId : context.bindings?.destinations?.[send.destination_alias];
                if (!/^[0-9a-f-]{36}$/i.test(destinationId || '')) throw invalid('FLOW_DESTINATION_MISSING');
                if (!partitions.has(destinationId)) partitions.set(destinationId, []);
                const member = { ...source, targetKind: context.targetKind, targetId: String(context.targetId), monitorRevision: context.monitorRevision, targetIdentity: context.targetIdentity,
                    context: { userId: context.ownerUserId, guildId: context.guildId, locale: context.locale || 'ja', ...context.sourceContext },
                    text: outputText(source.display, source.event) };
                partitions.get(destinationId).push(member);
            }
            if (!partitions.size) {
                await query("UPDATE automation_flow_sends SET state='cancelled' WHERE id=?", [send.id]);
                return { state: 'cancelled', id: send.id };
            }
            const jobs = [];
            for (const [destinationId, members] of partitions) {
                const schedules = uniqueSchedules(members), rawDue = Math.max(...members.map(member => Number(member.dueAtMs) || now)), deadlineMs = earliest(members.map(member => member.deadlineMs));
                const dueAtMs = scheduleDelivery(rawDue, schedules, deadlineMs == null ? Infinity : deadlineMs);
                if (dueAtMs === null) continue;
                const first = members[0], firstContext = first.context;
                const plan = { flowV2: { sendId: send.id, members: members.map(member => ({ memberId: member.id, runId: member.runId, targetKind: member.targetKind, targetId: member.targetId, monitorRevision: member.monitorRevision, targetIdentity: member.targetIdentity })) },
                    members, event: first.event, display: first.display, text: first.text, schedules, deadlineMs, context: firstContext, dictionaryRefs: {} };
                const id = uuid(`flow-job:${send.id}:${destinationId}`), runId = members[0].runId;
                await query('INSERT IGNORE INTO automation_jobs (id,run_id,destination_id,execution_version,plan_json,due_at_ms,deadline_ms,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, runId, destinationId, 2, JSON.stringify(plan), dueAtMs, deadlineMs, 'pending', now, now]);
                jobs.push(id);
            }
            await query("UPDATE automation_flow_sends SET state=? WHERE id=?", [jobs.length ? 'projected' : 'expired', send.id]);
            return { state: jobs.length ? 'projected' : 'expired', id: send.id, jobs };
        });
    }
    return { projectOne };
}
module.exports = { createFlowProjector, safeUnit, uniqueSchedules };
