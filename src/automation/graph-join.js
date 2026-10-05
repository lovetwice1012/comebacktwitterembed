'use strict';

const { hash } = require('./service');
const { isDeepStrictEqual } = require('node:util');
const { NODE_TYPES } = require('./schema');
const { normalizeEvent } = require('./engine');
const { copyData, kernelError } = require('./graph-plan');
const TERMINAL = new Set(['complete', 'excluded', 'expired', 'cancelled', 'failed']);
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const minimum = values => { const finite = values.filter(value => value != null); return finite.length ? Math.min(...finite) : null; };

// Closure is distinct from a data receipt: a matched edge can carry several
// units before it closes. A queued/deferred branch must never count as absent.
function propagateClosures(plan, { runId, receipts, activations, settledMerges = [] }) {
    const closed = new Set(receipts.filter(row => row.runId === runId && row.kind === 'closed').map(row => row.edgeId));
    const data = new Set(receipts.filter(row => row.runId === runId && row.kind === 'data').map(row => row.edgeId));
    const merges = new Set(settledMerges), additions = [];
    for (const id of plan.topologicalOrder) {
        const node = plan.byId.get(id), incoming = plan.incoming.get(id);
        if (incoming.some(edge => !closed.has(edge.id))) continue;
        const steps = activations.filter(step => step.nodeId === id && step.runIds.includes(runId));
        // The initial activation is created atomically with the source unit.
        // Missing activation data must not falsely close the entire workflow.
        if (node.type === 'start' && !steps.length) continue;
        if (node.type === 'merge' && incoming.some(edge => data.has(edge.id))) {
            if (!merges.has(id)) continue;
        } else if (steps.some(step => !TERMINAL.has(step.state)) || incoming.some(edge => data.has(edge.id)) && !steps.length) continue;
        for (const edge of plan.outgoing.get(id)) if (!closed.has(edge.id)) {
            closed.add(edge.id); additions.push({ runId, edgeId: edge.id });
        }
    }
    return additions;
}

// Decide one original event's explicit join, not a Cartesian join of batches.
// The store waits for every member of an anchor unit before emitting the groups
// with that anchor/signature. This pure helper does not invent global closure.
function mergeLineage(input) {
    const { node, runId, incomingEdgeIds, closedEdgeIds, arrivals } = copyData(input);
    if (node.type !== 'merge' || !['any', 'all'].includes(node.config.mode) || !['stop', 'reset'].includes(node.config.displayConflict)) throw kernelError('GRAPH_MERGE_INVALID', 'An explicit merge node is required');
    const expected = new Set(incomingEdgeIds), closed = new Set(closedEdgeIds);
    if (!expected.size || expected.size !== incomingEdgeIds.length || arrivals.some(arrival => !expected.has(arrival.edgeId))) throw kernelError('GRAPH_MERGE_INVALID', 'Invalid merge edge receipts');
    if (incomingEdgeIds.some(id => !closed.has(id))) return { state: 'waiting', openEdges: incomingEdgeIds.filter(id => !closed.has(id)) };
    const candidates = arrivals.flatMap(arrival => arrival.unit.members.filter(member => member.runId === runId).map(member => ({ ...arrival, member })));
    const present = new Set(candidates.map(item => item.edgeId));
    if (!candidates.length || node.config.mode === 'all' && incomingEdgeIds.some(id => !present.has(id))) return { state: 'excluded', code: 'MERGE_MISSING_PATH', matchedEdges: [...present] };
    const first = candidates[0].member;
    if (candidates.some(item => JSON.stringify(normalizeEvent(item.member.event)) !== JSON.stringify(normalizeEvent(first.event)))) throw kernelError('GRAPH_LINEAGE_CONFLICT', 'The same source event has contradictory immutable observations');
    const displayConflict = candidates.some(item => !isDeepStrictEqual(item.member.display, first.display) || (item.member.defaultPriceText || null) !== (first.defaultPriceText || null));
    if (displayConflict && node.config.displayConflict === 'stop') return { state: 'excluded', code: 'MERGE_DISPLAY_CONFLICT', matchedEdges: [...present] };
    const member = { ...first, id: hash(JSON.stringify(['merge-member', node.id, runId])), lineageId: first.lineageId || first.id,
        dueAtMs: Math.max(...candidates.map(item => item.member.dueAtMs)),
        deadlineMs: minimum(candidates.map(item => item.member.deadlineMs)),
        scheduleDeadlineMs: minimum(candidates.map(item => item.member.scheduleDeadlineMs)),
        schedules: unique(candidates.flatMap(item => item.member.schedules)),
        display: displayConflict ? { ...NODE_TYPES.transform.defaults } : first.display,
        defaultPriceText: displayConflict ? null : first.defaultPriceText,
    };
    const batchUnits = [...new Set(candidates.filter(item => item.unit.kind === 'batch' || item.unit.ancestry?.some(stage => stage.batchId)).map(item => item.unit.id))].sort();
    return { state: 'accepted', member, matchedEdges: [...present].sort(), inputUnitIds: [...new Set(candidates.map(item => item.unit.id))].sort(),
        signature: JSON.stringify(batchUnits), anchorUnitId: batchUnits[0] || null,
        ancestry: unique(candidates.flatMap(item => item.unit.ancestry || [])) };
}
module.exports = { propagateClosures, mergeLineage };
