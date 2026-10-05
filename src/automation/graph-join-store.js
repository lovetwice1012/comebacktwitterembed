'use strict';

const { hash } = require('./service');
const { mergeLineage, propagateClosures } = require('./graph-join');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

// Internal companion to graph-store: shares its namespace transaction and
// immutable unit/step writers. No ingress or transport calls are made here.
function createJoinStore({ db, locked, putUnit, putStep, receipt, readUnit, uuid, encode, fault }) {
    async function synchronize(namespace, plan, runIds, now) {
        const requested = [...new Set(runIds)].sort();
        if (!requested.length) return { changes: 0 };
        if (requested.length > 1000) throw fault('FLOW_SYNC_LIMIT');
        return locked(namespace, async query => {
            const origins = await query('SELECT run_id,revoked_at_ms FROM automation_flow_runs WHERE namespace_key=? AND run_id IN (?)', [namespace, requested]);
            if (origins.length !== requested.length) throw fault('FLOW_MEMBER_NAMESPACE');
            // A temporal continuation is a new immutable unit. Its removed
            // members are terminal for this activation and must not keep a
            // merge open merely because they remain in the original snapshot.
            const rows = await query('SELECT DISTINCT s.id,s.node_id,s.state,s.input_unit_id,s.continuation_unit_id,m.run_id FROM automation_flow_steps s JOIN automation_flow_members m ON m.unit_id=COALESCE(s.continuation_unit_id,s.input_unit_id) WHERE s.namespace_key=? AND m.run_id IN (?)', [namespace, requested]);
            const steps = new Map();
            for (const row of rows) {
                if (!steps.has(row.id)) steps.set(row.id, { id: row.id, nodeId: row.node_id, state: row.state, unitId: row.continuation_unit_id || row.input_unit_id, runIds: [] });
                steps.get(row.id).runIds.push(row.run_id);
            }
            const edges = await query('SELECT run_id AS runId,edge_id AS edgeId,receipt_kind AS kind,unit_id AS unitId FROM automation_flow_edges WHERE namespace_key=? AND run_id IN (?)', [namespace, requested]);
            const decisions = await query('SELECT node_id,run_id,state FROM automation_flow_merge_decisions WHERE namespace_key=? AND run_id IN (?)', [namespace, requested]);
            let changes = 0;
            for (const runId of requested) {
                const actor = rows.find(row => row.run_id === runId);
                const origin = origins.find(row => row.run_id === runId);
                // Revocation is a durable terminal result for every branch of
                // that original event. It must release healthy batch peers;
                // it never changes their shared immutable unit.
                if (origin.revoked_at_ms != null) {
                    for (const node of plan.nodes.filter(item => item.type === 'merge')) {
                        if (decisions.some(row => row.run_id === runId && row.node_id === node.id)) continue;
                        await query('INSERT IGNORE INTO automation_flow_merge_decisions (namespace_key,node_id,run_id,state,anchor_unit_id,signature_key,decision_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [namespace, node.id, runId, 'excluded', null, hash(`revoked:${runId}`), encode({ state: 'excluded', code: 'RUN_REVOKED', matchedEdges: [] }), now, now]);
                        decisions.push({ node_id: node.id, run_id: runId, state: 'excluded' }); changes++;
                    }
                    continue;
                }
                if (!actor) {
                    // This lineage was pruned into a continuation sibling. Its
                    // terminal edge receipts were committed with that pruning;
                    // do not make the remaining members wait on it again.
                    const historical = await query('SELECT s.id FROM automation_flow_steps s JOIN automation_flow_members m ON m.unit_id=s.input_unit_id WHERE s.namespace_key=? AND m.run_id=? LIMIT 1', [namespace, runId]);
                    if (historical.length) continue;
                    throw fault('FLOW_ACTIVATION_MISSING');
                }
                const additions = propagateClosures(plan, { runId, receipts: edges, activations: [...steps.values()], settledMerges: decisions.filter(row => row.run_id === runId && ['emitted', 'excluded'].includes(row.state)).map(row => row.node_id) });
                for (const edge of additions) {
                    await receipt(query, { id: actor.id, namespace_key: namespace }, { ...edge, kind: 'closed', unitId: null }, now);
                    edges.push({ ...edge, kind: 'closed', unitId: null }); changes++;
                }
            }
            const units = new Map();
            const unit = async id => { if (!units.has(id)) units.set(id, await readUnit(query, id, true)); return units.get(id); };
            for (const node of plan.nodes.filter(item => item.type === 'merge')) {
                const incoming = plan.incoming.get(node.id).map(edge => edge.id);
                for (const origin of origins) {
                    if (decisions.some(row => row.run_id === origin.run_id && row.node_id === node.id)) continue;
                    const relevant = edges.filter(edge => edge.runId === origin.run_id && incoming.includes(edge.edgeId));
                    const closed = relevant.filter(edge => edge.kind === 'closed').map(edge => edge.edgeId);
                    if (incoming.some(id => !closed.includes(id))) continue;
                    const arrivals = [];
                    for (const edge of relevant.filter(row => row.kind === 'data')) arrivals.push({ edgeId: edge.edgeId, unit: await unit(edge.unitId) });
                    const decision = mergeLineage({ node, runId: origin.run_id, incomingEdgeIds: incoming, closedEdgeIds: closed, arrivals });
                    if (decision.state === 'waiting') continue;
                    await query('INSERT INTO automation_flow_merge_decisions (namespace_key,node_id,run_id,state,anchor_unit_id,signature_key,decision_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [namespace, node.id, origin.run_id, decision.state === 'accepted' ? 'ready' : 'excluded', decision.anchorUnitId || null, hash(decision.signature || origin.run_id), encode(decision), now, now]);
                    changes++;
                }
                // Page *complete groups*, never arbitrary decision rows. A
                // valid batch may contain more than one thousand members;
                // slicing such a signature would otherwise make it impossible
                // to emit on every retry. Limiting groups preserves fairness.
                const groupHeads = await query("SELECT COALESCE(anchor_unit_id,run_id) AS group_id,anchor_unit_id,signature_key FROM automation_flow_merge_decisions WHERE namespace_key=? AND node_id=? AND state='ready' GROUP BY COALESCE(anchor_unit_id,run_id),anchor_unit_id,signature_key ORDER BY group_id,signature_key LIMIT 100", [namespace, node.id]);
                for (const head of groupHeads) {
                    const group = await query(head.anchor_unit_id == null
                        ? "SELECT * FROM automation_flow_merge_decisions WHERE namespace_key=? AND node_id=? AND state='ready' AND run_id=? AND anchor_unit_id IS NULL AND signature_key=? ORDER BY run_id"
                        : "SELECT * FROM automation_flow_merge_decisions WHERE namespace_key=? AND node_id=? AND state='ready' AND anchor_unit_id=? AND signature_key=? ORDER BY run_id", head.anchor_unit_id == null
                        ? [namespace, node.id, head.group_id, head.signature_key]
                        : [namespace, node.id, head.anchor_unit_id, head.signature_key]);
                    if (!group.length) continue;
                    const groupKey = JSON.stringify([head.group_id, head.signature_key]);
                    const anchor = group[0].anchor_unit_id;
                    // A ready lineage may not be held behind a sibling still
                    // waiting on another branch. This is especially important
                    // for `any`: a published-time gap in A must not postpone
                    // A's already-complete direct path behind B. Ready peers
                    // present in this exact pass stay batched; a later peer is
                    // emitted as its own deterministic fragment.
                    const values = group.map(row => parse(row.decision_json));
                    const groupVersion = hash(group.map(row => row.run_id).sort().join(','));
                    const output = { id: uuid(`merge-output:${namespace}:${node.id}:${groupKey}:${groupVersion}`), kind: anchor ? 'batch' : 'event', members: values.map(value => value.member),
                        ancestry: [...new Map(values.flatMap(value => value.ancestry).map(value => [encode(value), value])).values()], mergeNodeId: node.id,
                        inputUnitIds: [...new Set(values.flatMap(value => value.inputUnitIds))].sort() };
                    await putUnit(query, namespace, output, now);
                    for (const edge of plan.outgoing.get(node.id)) {
                        await putStep(query, namespace, `merge-successor:${output.id}:${edge.id}`, edge.target, output.id, edge.id, now, now);
                        for (const row of group) {
                            const actor = (await query('SELECT s.id FROM automation_flow_steps s JOIN automation_flow_members m ON m.unit_id=COALESCE(s.continuation_unit_id,s.input_unit_id) WHERE s.namespace_key=? AND s.node_id=? AND m.run_id=? LIMIT 1', [namespace, node.id, row.run_id]))[0];
                            if (!actor) throw fault('FLOW_ACTIVATION_MISSING');
                            await receipt(query, { id: actor.id, namespace_key: namespace }, { runId: row.run_id, edgeId: edge.id, kind: 'data', unitId: output.id }, now);
                        }
                    }
                    for (const row of group) await query("UPDATE automation_flow_merge_decisions SET state='emitted',output_unit_id=?,updated_at_ms=? WHERE namespace_key=? AND node_id=? AND run_id=? AND state='ready'", [output.id, now, namespace, node.id, row.run_id]);
                    changes += group.length;
                }
                // Completion is per source lineage. A batch activation closes
                // only after all its members have a terminal merge decision.
                const candidates = await query("SELECT id,input_unit_id,continuation_unit_id FROM automation_flow_steps WHERE namespace_key=? AND node_id=? AND state IN ('pending','leased','joining') ORDER BY id LIMIT 1000", [namespace, node.id]);
                for (const candidate of candidates) {
                    const pending = await query("SELECT m.run_id FROM automation_flow_members m LEFT JOIN automation_flow_merge_decisions d ON d.namespace_key=? AND d.node_id=? AND d.run_id=m.run_id WHERE m.unit_id=? AND (d.state IS NULL OR d.state NOT IN ('emitted','excluded')) LIMIT 1", [namespace, node.id, candidate.continuation_unit_id || candidate.input_unit_id]);
                    if (!pending.length) { await query("UPDATE automation_flow_steps SET state='complete',lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE id=?", [now, candidate.id]); changes++; }
                }
            }
            if (!changes) await query('UPDATE automation_flow_runs SET needs_sync=0 WHERE namespace_key=? AND run_id IN (?)', [namespace, requested]);
            return { changes };
        });
    }
    // Scoped lookup lets a future scheduler resume closure work after a crash.
    async function openRuns(namespace, afterRunId = '', count = 100) {
        return db.queryDatabase('SELECT run_id FROM automation_flow_runs WHERE namespace_key=? AND run_id>? ORDER BY run_id LIMIT ?', [namespace, afterRunId, Math.max(1, Math.min(1000, count))]);
    }
    return { synchronize, openRuns };
}
module.exports = { createJoinStore };
