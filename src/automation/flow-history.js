'use strict';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
// Public run history is a projection of durable graph decisions, never a second
// evaluator. It survives process restarts and retains each lineage's reasons.
async function refreshFlowHistory(query, runIds) {
    const requested = [...new Set(runIds)];
    if (!requested.length) return;
    const origins = await query('SELECT run_id,revoked_at_ms,revocation_code FROM automation_flow_runs WHERE run_id IN (?)', [requested]);
    if (!origins.length) return;
    const ids = origins.map(row => row.run_id);
    // Batch reads keep history projection proportional to the work already
    // synchronized, rather than performing a full queue scan per lineage.
    const allSteps = await query(`SELECT DISTINCT m.run_id,s.id,s.node_id,s.state,s.decision_json,s.wake_at_ms,s.created_at_ms FROM automation_flow_steps s
        JOIN automation_flow_members m ON m.unit_id=s.input_unit_id WHERE m.run_id IN (?) ORDER BY s.created_at_ms,s.id`, [ids]);
    const allBatches = await query(`SELECT DISTINCT m.run_id,b.node_id,b.outcome_json FROM automation_flow_batches b JOIN automation_flow_batch_inputs i ON i.batch_id=b.id
        JOIN automation_flow_members m ON m.unit_id=i.input_unit_id WHERE m.run_id IN (?) AND b.state<>'open'`, [ids]);
    const allSends = await query(`SELECT DISTINCT m.run_id,s.id,s.state,s.activation_id,s.unit_id FROM automation_flow_sends s JOIN automation_flow_members m ON m.unit_id=s.unit_id WHERE m.run_id IN (?)`, [ids]);
    const unitIds = [...new Set(allSends.map(row => row.unit_id))];
    const anchors = unitIds.length ? await query('SELECT DISTINCT run_id FROM automation_flow_members WHERE unit_id IN (?)', [unitIds]) : [];
    const sendIds = new Set(allSends.map(row => row.id));
    // Jobs have an indexed originating run. Resolve the possible anchors of
    // these exact send units first; do not scan every historical plan JSON for
    // each ordinary graph transition.
    const allJobs = anchors.length ? (await query('SELECT state,plan_json FROM automation_jobs WHERE execution_version=2 AND run_id IN (?)', [anchors.map(row => row.run_id)]))
        .flatMap(row => { try { const plan = parse(row.plan_json); return sendIds.has(plan.flowV2?.sendId) ? [{ ...row, plan }] : []; } catch { return []; } }) : [];
    for (const origin of origins) {
        const runId = origin.run_id, steps = allSteps.filter(row => row.run_id === runId);
        const trace = [];
        for (const step of steps) {
            const decision = parse(step.decision_json) || {};
            const entries = (decision.trace || []).filter(item => !item.runId || item.runId === runId);
            trace.push(...entries);
            if (!entries.length && (decision.code || ['pending','leased','joining','aggregating'].includes(step.state))) trace.push({ nodeId: step.node_id,
                outcome: ['pending','leased','joining','aggregating'].includes(step.state) ? 'wait' : 'excluded', reason: decision.code || 'FLOW_WAITING', wakeAtMs: Number(step.wake_at_ms) });
        }
        const batches = allBatches.filter(row => row.run_id === runId);
        for (const batch of batches) for (const excluded of parse(batch.outcome_json)?.excluded || []) if (excluded.runId === runId) trace.push({ nodeId: batch.node_id, outcome: excluded.code === 'DEADLINE_EXCEEDED' ? 'expired' : 'excluded', reason: excluded.code });
        const sends = allSends.filter(row => row.run_id === runId), lineageJobs = allJobs.filter(row => [...(row.plan.flowV2.members || []), ...(row.plan.flowV2.excludedMembers || [])].some(member => member.runId === runId));
        for (const job of lineageJobs) for (const excluded of job.plan.flowV2?.excludedMembers || []) if (excluded.runId === runId) trace.push({ nodeId: 'send', outcome: excluded.code === 'DEADLINE_EXCEEDED' ? 'expired' : 'excluded', reason: excluded.code });
        const jobs = lineageJobs.filter(job => job.plan.flowV2?.members?.some(member => member.runId === runId));
        let state;
        if (origin.revoked_at_ms != null) { state = 'excluded'; trace.push({ nodeId: steps[0]?.node_id || 'start', outcome: 'excluded', reason: origin.revocation_code || 'RUN_REVOKED' }); }
        else if (steps.some(step => ['pending','leased','joining','aggregating'].includes(step.state))) state = 'waiting';
        else if (jobs.length) state = jobs.every(job => job.state === 'sent') ? 'sent' : jobs.some(job => ['pending','leased','sending'].includes(job.state)) ? 'queued' : jobs[0].state;
        else if (sends.some(send => send.state === 'unprojected')) state = 'flow_pending';
        else if (sends.some(send => send.state === 'failed')) state = 'failed';
        else state = trace.some(entry => ['GRAPH_INPUT_LIMIT','FLOW_SNAPSHOT_LIMIT'].includes(entry.reason)) ? 'failed' : trace.some(entry => entry.outcome === 'expired') ? 'expired' : 'excluded';
        for (const send of sends.filter(item => ['failed','cancelled','expired'].includes(item.state))) trace.push({ nodeId: steps.find(step => step.id === send.activation_id)?.node_id || 'send', outcome: send.state === 'expired' ? 'expired' : 'excluded', reason: send.state === 'failed' ? 'FLOW_DESTINATION_MISSING' : send.state === 'expired' ? 'DEADLINE_EXCEEDED' : 'ALL_MEMBERS_REVOKED' });
        await query('UPDATE automation_runs SET state=?,trace_json=? WHERE id=?', [state, JSON.stringify(trace), runId]);
    }
}
module.exports = { refreshFlowHistory };
