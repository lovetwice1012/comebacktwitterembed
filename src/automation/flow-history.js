'use strict';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const activeJobs = new Set(['pending', 'held', 'leased', 'sending', 'aggregated']);
const jobPrefix = id => digest(JSON.stringify(['flow-job-members', id])).slice(0, 32);
function readJobFlowPlan(value) {
    try {
        const plan = parse(value), flow = plan?.flowV2, member = value => value && typeof value.memberId === 'string' && /^[0-9a-f-]{36}$/i.test(value.runId || '');
        return flow && /^[0-9a-f-]{36}$/i.test(flow.sendId || '') && Array.isArray(flow.members) && flow.members.every(member)
            && (flow.excludedMembers === undefined || Array.isArray(flow.excludedMembers) && flow.excludedMembers.every(member)) ? plan : null;
    } catch { return null; }
}
async function jobFlowLinks(query, jobs) {
    const links = [];
    for (let at = 0; at < jobs.length; at += 100) {
        const page = jobs.slice(at, at + 100);
        links.push(...await query(`SELECT e.edge_id,e.run_id,
            MAX(e.receipt_kind='job_member' AND NOT EXISTS (SELECT 1 FROM automation_flow_edges x WHERE x.receipt_key=CONCAT(LEFT(e.receipt_key,62),'01') AND x.receipt_kind='job_excluded' AND x.edge_id=e.edge_id AND x.run_id=e.run_id)) AS active
            FROM automation_flow_edges e FORCE INDEX (PRIMARY) WHERE (${page.map(() => '(e.receipt_key BETWEEN ? AND ? AND e.edge_id=?)').join(' OR ')})
            AND e.receipt_kind IN ('job_member','job_excluded') GROUP BY e.edge_id,e.run_id`,
        page.flatMap(job => { const prefix = jobPrefix(job.id); return [prefix + '0'.repeat(32), prefix + 'f'.repeat(32), job.id]; })));
    }
    return links;
}

// A summary describes every delivery branch. Never let SQL row order hide a
// failed sibling or turn an uncertain delivery into a complete success.
function deliveryState(states) {
    if (states.some(state => activeJobs.has(state))) return 'queued';
    if (states.includes('unprojected')) return 'flow_pending';
    if (states.length && states.every(state => state === 'sent')) return 'sent';
    if (states.some(state => state === 'sent' || state === 'partial')) return 'partial';
    for (const state of ['unknown', 'failed', 'expired', 'cancelled', 'excluded']) if (states.includes(state)) return state;
    return null;
}

// Reuse the graph's durable receipt store for delivery membership. These kinds
// are not evaluator data/closed edges. The original membership survives a bad
// plan snapshot, and removals are retained as separate immutable receipts.
async function recordJobFlowMembers(query, job) {
    if (Number(job.execution_version) !== 2) return;
    const plan = readJobFlowPlan(job.plan_json);
    if (!plan) return;
    for (const [kind, members] of [['job_member', plan.flowV2.members], ['job_excluded', plan.flowV2.excludedMembers]]) {
        const pairs = (Array.isArray(members) ? members : []).filter(member => typeof member?.runId === 'string' && typeof member.memberId === 'string').map(member => [member.memberId, member.runId]);
        if (!pairs.length) continue;
        await query(`INSERT IGNORE INTO automation_flow_edges (receipt_key,namespace_key,run_id,edge_id,activation_id,receipt_kind,unit_id,created_at_ms)
            SELECT CONCAT(?,LEFT(SHA2(CONCAT(m.run_id,':',m.member_id),256),30),?),s.namespace_key,m.run_id,?,s.activation_id,?,s.unit_id,?
            FROM automation_flow_sends s JOIN automation_flow_members m ON m.unit_id=s.unit_id
            JOIN automation_flow_runs f ON f.run_id=m.run_id AND f.namespace_key=s.namespace_key WHERE s.id=?
            AND (m.member_id,m.run_id) IN (?)
            AND EXISTS (SELECT 1 FROM automation_flow_members a JOIN automation_flow_runs r ON r.run_id=a.run_id
                WHERE a.unit_id=s.unit_id AND a.run_id=? AND r.namespace_key=s.namespace_key)`,
        [jobPrefix(job.id), kind === 'job_member' ? '00' : '01', job.id, kind, Number(job.created_at_ms) || 0, plan.flowV2.sendId, pairs, job.run_id]);
    }
}
async function lockJobFlowHistory(query, jobs) {
    const children = jobs.length ? await query("SELECT run_id,execution_version FROM automation_jobs WHERE parent_job_id IN (?) AND state='aggregated'", [jobs.map(job => job.id)]) : [];
    const rows = [...jobs, ...children].filter(job => Number(job.execution_version) === 2);
    if (!rows.length) return;
    const origins = await query('SELECT DISTINCT namespace_key FROM automation_flow_runs WHERE run_id IN (?)', [[...new Set(rows.map(job => job.run_id))]]);
    const namespaces = origins.map(row => row.namespace_key).sort();
    // Graph evaluation uses this same namespace mutex. Take it before locking
    // individual jobs so simultaneous sibling ACKs cannot deadlock on the run
    // projection or overwrite one another with a repeatable-read snapshot.
    for (const namespace of namespaces) {
        await query('INSERT INTO automation_flow_locks (namespace_key) VALUES (?) ON DUPLICATE KEY UPDATE namespace_key=VALUES(namespace_key)', [namespace]);
    }
}
async function refreshJobFlowHistory(query, jobs) {
    const rows = jobs.filter(job => Number(job.execution_version) === 2);
    if (!rows.length) return;
    const ids = new Set(rows.map(job => job.run_id));
    for (const job of rows) {
        await recordJobFlowMembers(query, job);
    }
    const links = await jobFlowLinks(query, rows);
    for (const link of links) ids.add(link.run_id);
    const runIds = [...ids];
    for (let at = 0; at < runIds.length; at += 500) await refreshFlowHistory(query, runIds.slice(at, at + 500));
}
// Public run history is a projection of durable graph decisions, never a second
// evaluator. It survives process restarts and retains each lineage's reasons.
async function refreshFlowHistory(query, runIds) {
    const transactionQuery = query;
    // Callers may have opened a repeatable-read snapshot while locating a job
    // before its namespace mutex. Projection must see the latest committed
    // sibling and graph decisions after that mutex has been acquired.
    query = (sql, params) => transactionQuery(/^SELECT\b/i.test(sql) && !/FOR UPDATE\s*$/i.test(sql) ? `${sql} LOCK IN SHARE MODE` : sql, params);
    const requested = [...new Set(runIds)];
    if (!requested.length) return;
    const origins = await query('SELECT run_id,revoked_at_ms,revocation_code FROM automation_flow_runs WHERE run_id IN (?) ORDER BY run_id FOR UPDATE', [requested]);
    if (!origins.length) return;
    const ids = origins.map(row => row.run_id);
    // Batch reads keep history projection proportional to the work already
    // synchronized, rather than performing a full queue scan per lineage.
    // Deduplicate the narrow membership keys before reading a potentially
    // large immutable decision. DISTINCT over the joined JSON would otherwise
    // materialize thousands of copies for one run with repeated occurrences.
    const stepLinks = await query(`SELECT DISTINCT m.run_id,s.id FROM automation_flow_steps s JOIN automation_flow_members m ON m.unit_id=s.input_unit_id WHERE m.run_id IN (?)`, [ids]);
    const stepRows = await query(`SELECT s.id,s.node_id,s.state,s.decision_json,s.wake_at_ms,s.created_at_ms FROM automation_flow_steps s
        WHERE EXISTS (SELECT 1 FROM automation_flow_members m WHERE m.unit_id=s.input_unit_id AND m.run_id IN (?)) ORDER BY s.created_at_ms,s.id`, [ids]);
    const stepsById = new Map(stepRows.map(row => [row.id, { ...row, decision: parse(row.decision_json) || {} }]));
    const memberships = new Map(); for (const link of stepLinks) { if (!memberships.has(link.run_id)) memberships.set(link.run_id, new Set()); memberships.get(link.run_id).add(link.id); }
    const batchLinks = await query(`SELECT DISTINCT i.batch_id,m.run_id FROM automation_flow_batch_inputs i JOIN automation_flow_members m ON m.unit_id=i.input_unit_id WHERE m.run_id IN (?)`, [ids]);
    const batchRows = await query(`SELECT b.id,b.node_id,b.outcome_json FROM automation_flow_batches b WHERE b.state<>'open'
        AND EXISTS (SELECT 1 FROM automation_flow_batch_inputs i JOIN automation_flow_members m ON m.unit_id=i.input_unit_id WHERE i.batch_id=b.id AND m.run_id IN (?)) ORDER BY b.created_at_ms,b.id`, [ids]);
    const batchById = new Map(batchRows.map(row => [row.id, { ...row, outcome: parse(row.outcome_json) || {} }]));
    const allBatches = batchLinks.flatMap(link => batchById.has(link.batch_id) ? [{ ...batchById.get(link.batch_id), run_id: link.run_id }] : []);
    // The receipt key is the exact compact JSON tuple written by graph-store.
    // Every component is a canonical hex/UUID identifier or fixed receipt kind.
    // Point lookups keep current locking reads linear even for 51,000 members;
    // a run/unit join otherwise multiplies each member by all peer receipts.
    const batchExclusions = await query(`SELECT DISTINCT m.run_id,b.node_id,e.receipt_kind,JSON_UNQUOTE(JSON_EXTRACT(b.outcome_json,'$.code')) AS code FROM automation_flow_batch_inputs i
        STRAIGHT_JOIN automation_flow_batches b ON b.id=i.batch_id STRAIGHT_JOIN automation_flow_members m ON m.unit_id=i.input_unit_id
        STRAIGHT_JOIN (SELECT 'batch_changed' AS kind UNION ALL SELECT 'batch_expired' UNION ALL SELECT 'batch_failed') kinds
        STRAIGHT_JOIN automation_flow_edges e FORCE INDEX (PRIMARY) ON e.receipt_key=SHA2(CONCAT('["',b.namespace_key,'","',m.run_id,'","',SHA2(CONCAT(b.id,':',m.member_id),256),'","',kinds.kind,'","',i.input_unit_id,'"]'),256)
            AND e.activation_id=i.activation_id AND e.unit_id=i.input_unit_id AND e.run_id=m.run_id
            AND e.edge_id=SHA2(CONCAT(b.id,':',m.member_id),256)
        WHERE m.run_id IN (?) AND b.state<>'open' AND e.receipt_kind IN ('batch_changed','batch_expired','batch_failed')`, [ids]);
    const failedSteps = await query(`SELECT DISTINCT e.run_id,s.node_id,e.edge_id FROM automation_flow_edges e JOIN automation_flow_steps s ON s.id=e.activation_id
        WHERE e.run_id IN (?) AND e.receipt_kind='step_failed' AND EXISTS (SELECT 1 FROM automation_flow_members m WHERE m.unit_id=e.unit_id AND m.run_id=e.run_id)`, [ids]);
    const failedMerges = await query(`SELECT run_id,node_id,JSON_UNQUOTE(JSON_EXTRACT(decision_json,'$.code')) AS code FROM automation_flow_merge_decisions
        WHERE run_id IN (?) AND state='excluded' AND JSON_UNQUOTE(JSON_EXTRACT(decision_json,'$.terminalFailure'))='true'`, [ids]);
    const allSends = await query(`SELECT DISTINCT m.run_id,s.id,s.state,s.activation_id,s.unit_id FROM automation_flow_sends s JOIN automation_flow_members m ON m.unit_id=s.unit_id WHERE m.run_id IN (?)`, [ids]);
    const unitIds = [...new Set(allSends.map(row => row.unit_id))];
    const anchors = unitIds.length ? await query('SELECT DISTINCT run_id FROM automation_flow_members WHERE unit_id IN (?)', [unitIds]) : [];
    const sendIds = new Set(allSends.map(row => row.id));
    // Jobs have an indexed originating run. Resolve the possible anchors of
    // these exact send units first; do not scan every historical plan JSON for
    // each ordinary graph transition.
    const jobRows = anchors.length ? await query(`SELECT id,run_id,state,plan_json,execution_version,created_at_ms FROM automation_jobs j WHERE execution_version=2
        AND (run_id IN (?) OR EXISTS (SELECT 1 FROM automation_flow_edges e WHERE e.edge_id=j.id AND e.run_id IN (?) AND e.receipt_kind IN ('job_member','job_excluded'))) ORDER BY id FOR UPDATE`, [anchors.map(row => row.run_id), ids]) : [];
    for (const job of jobRows) await recordJobFlowMembers(query, job);
    const jobLinks = await jobFlowLinks(query, jobRows);
    const allJobs = jobRows.flatMap(row => {
        const plan = readJobFlowPlan(row.plan_json);
        return plan ? sendIds.has(plan.flowV2.sendId) ? [{ ...row, plan }] : [] : [{ ...row, plan: null }];
    });
    for (const origin of origins) {
        const runId = origin.run_id, steps = stepRows.filter(row => memberships.get(runId)?.has(row.id)).map(row => stepsById.get(row.id));
        const trace = require('./flow-trace').traceProjection();
        for (const step of steps) {
            const decision = step.decision;
            const entries = (decision.trace || []).filter(item => !item.runId || item.runId === runId);
            trace.push(...entries);
            if (!entries.length && !decision.terminalFailure && (decision.code || ['pending','leased','joining','aggregating'].includes(step.state))) trace.push({ nodeId: step.node_id,
                outcome: ['pending','leased','joining','aggregating'].includes(step.state) ? 'wait' : 'excluded', reason: decision.code || 'FLOW_WAITING', wakeAtMs: Number(step.wake_at_ms) });
        }
        const batches = allBatches.filter(row => row.run_id === runId);
        for (const batch of batches) for (const excluded of batch.outcome.excluded || []) if (excluded.runId === runId) trace.push({ nodeId: batch.node_id, outcome: excluded.code === 'DEADLINE_EXCEEDED' ? 'expired' : 'excluded', reason: excluded.code });
        for (const batch of batchExclusions.filter(row => row.run_id === runId)) trace.push({ nodeId: batch.node_id,
            outcome: batch.receipt_kind === 'batch_expired' ? 'expired' : 'excluded', reason: batch.receipt_kind === 'batch_expired' ? 'DEADLINE_EXCEEDED'
                : batch.receipt_kind === 'batch_changed' ? 'MONITOR_CHANGED' : batch.code || 'FLOW_UNIT_INVALID' });
        for (const failed of failedSteps.filter(row => row.run_id === runId)) trace.push({ nodeId: failed.node_id, outcome: 'excluded', reason: failed.edge_id.slice(37) });
        for (const failed of failedMerges.filter(row => row.run_id === runId)) trace.push({ nodeId: failed.node_id, outcome: 'excluded', reason: failed.code });
        const sends = allSends.filter(row => row.run_id === runId), lineageJobs = allJobs.filter(row => row.plan
            ? [...(row.plan.flowV2.members || []), ...(row.plan.flowV2.excludedMembers || [])].some(member => member.runId === runId)
            : row.run_id === runId || jobLinks.some(link => link.edge_id === row.id && link.run_id === runId));
        for (const job of lineageJobs) for (const excluded of job.plan?.flowV2?.excludedMembers || []) if (excluded.runId === runId) trace.push({ nodeId: 'send', outcome: excluded.code === 'DEADLINE_EXCEEDED' ? 'expired' : 'excluded', reason: excluded.code });
        const jobs = lineageJobs.filter(job => job.plan ? job.plan.flowV2?.members?.some(member => member.runId === runId)
            : jobLinks.some(link => link.edge_id === job.id && link.run_id === runId && Number(link.active) === 1)
                || job.run_id === runId && !jobLinks.some(link => link.edge_id === job.id && link.run_id === runId));
        const branches = [...jobs.map(job => job.state), ...sends.filter(send => ['unprojected','failed','cancelled','expired'].includes(send.state)).map(send => send.state)];
        // Permanent graph failures may precede a send intent, so include those
        // durable branches alongside projected deliveries as well.
        if (trace.permanent) branches.push('failed');
        if (trace.expired) branches.push('expired');
        let state;
        if (origin.revoked_at_ms != null) { state = 'excluded'; trace.push({ nodeId: steps[0]?.node_id || 'start', outcome: 'excluded', reason: origin.revocation_code || 'RUN_REVOKED' }); }
        else if (steps.some(step => ['pending','leased','joining','aggregating'].includes(step.state))) state = 'waiting';
        else state = deliveryState(branches) || 'excluded';
        for (const send of sends.filter(item => ['failed','cancelled','expired'].includes(item.state))) trace.push({ nodeId: steps.find(step => step.id === send.activation_id)?.node_id || 'send', outcome: send.state === 'expired' ? 'expired' : 'excluded', reason: send.state === 'failed' ? 'FLOW_DESTINATION_MISSING' : send.state === 'expired' ? 'DEADLINE_EXCEEDED' : 'ALL_MEMBERS_REVOKED' });
        await query('UPDATE automation_runs SET state=?,trace_json=? WHERE id=?', [state, JSON.stringify(trace.result()), runId]);
    }
}
module.exports = { refreshFlowHistory, refreshJobFlowHistory, recordJobFlowMembers, lockJobFlowHistory, readJobFlowPlan, deliveryState };
