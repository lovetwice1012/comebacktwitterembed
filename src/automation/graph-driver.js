'use strict';

const { stepNode } = require('./graph-step');
// Disconnected execution-v2 coordinator. The explicit enable callback is a
// construction requirement; no Bot startup path imports/creates this driver.
// Send nodes create an unprojected intent, never an automation_jobs row or I/O.
function createGraphDriver(store, options) {
    if (typeof options?.assertEnabled !== 'function' || typeof options?.loadPlan !== 'function') throw new Error('FLOW_DRIVER_DEPENDENCIES_REQUIRED');
    const evaluate = options.evaluateStep || (async (node, unit, now) => {
        if (node.type === 'dictionary') throw new Error('FLOW_DICTIONARY_EVALUATOR_REQUIRED');
        return stepNode(node, unit, { now });
    });
    async function sync(namespace, plan, runIds, now) {
        const ids = [...new Set(runIds)];
        for (let at = 0; at < ids.length; at += 1000) await store.synchronize(namespace, plan, ids.slice(at, at + 1000), now);
    }
    function closedEdges(plan, node, source, outputs) {
        const sent = new Set();
        for (const output of outputs || []) for (const edge of output.edges || []) for (const member of output.unit.members) sent.add(`${member.runId}:${edge.id}`);
        return [...new Set(source.members.map(member => member.runId))].flatMap(runId => plan.outgoing.get(node.id)
            .filter(edge => !sent.has(`${runId}:${edge.id}`)).map(edge => ({ runId, edgeId: edge.id })));
    }
    async function tick(now) {
        if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) throw new Error('FLOW_TIME_INVALID');
        await options.assertEnabled();
        const batch = await store.dueBatch(now);
        if (batch) {
            const plan = await options.loadPlan(batch.namespace_key);
            const result = await store.closeBatch(batch, plan.outgoing.get(batch.node_id), now);
            await sync(batch.namespace_key, plan, result.outcome?.runIds || [], now);
            return { kind: 'batch', ...result };
        }
        const step = await store.claim(now);
        if (!step) {
            const work = await store.synchronizationBatch();
            if (!work) return { state: 'idle' };
            const plan = await options.loadPlan(work.namespace);
            return { state: 'synchronized', ...await store.synchronize(work.namespace, plan, work.runIds, now) };
        }
        const plan = await options.loadPlan(step.namespace_key), node = plan.byId.get(step.node_id);
        if (!node) throw new Error('FLOW_NODE_MISSING');
        const original = await store.readUnit(step.input_unit_id);
        // Freeze predicates across lease recovery. Actual-time temporal and
        // quota decisions must observe the current execution attempt instead.
        const at = ['condition', 'dictionary'].includes(node.type) ? Number(step.evaluation_at_ms) : now;
        const transition = await evaluate(node, step.unit, at, step.namespace_key);
        const outgoing = port => plan.outgoing.get(node.id).filter(edge => edge.port === port);
        let result;
        if (transition.state === 'wait') {
            const continued = new Set((transition.continuation?.members || []).map(member => member.id));
            const removedMembers = step.unit.members.filter(member => !continued.has(member.id));
            // Receipts are run-scoped, but a run can legitimately have more
            // than one occurrence in a batch. Close only when none remains.
            const retainedRuns = new Set(step.unit.members.filter(member => continued.has(member.id)).map(member => member.runId));
            const removed = { members: removedMembers.filter(member => !retainedRuns.has(member.runId)) };
            result = await store.settle(step, { ...transition, closedEdges: closedEdges(plan, node, removed, []), decision: { trace: transition.trace } }, now);
        }
        else if (transition.state === 'aggregate') result = await store.admitBatch(step, transition.intent.config, transition.groups, now);
        else if (transition.state === 'merge') result = await store.parkMerge(step, now);
        else if (transition.state === 'send') result = await store.recordSend(step, transition.continuation, transition.destination, now);
        else if (transition.state === 'limit') {
            if (transition.groups.length > 1) result = await store.settle(step, { decision: { trace: transition.trace, partitioned: true }, outputs: transition.groups.map(group => ({ unit: group.unit, resumeNodeId: node.id })) }, now);
            else {
                const group = transition.groups[0];
                const outputs = [{ unit: group.unit, edges: outgoing('out') }];
                result = await store.settle(step, { gate: { ...transition.intent.config, key: group.key }, decision: { trace: transition.trace }, outputs, closedEdges: closedEdges(plan, node, step.unit, outputs) }, now);
            }
        } else if (transition.state === 'complete') {
            const outputs = transition.emissions.map(emission => ({ unit: emission.unit, edges: outgoing(emission.port) }));
            result = await store.settle(step, { decision: { trace: transition.trace }, outputs, closedEdges: closedEdges(plan, node, step.unit, outputs) }, now);
        }
        else throw new Error('FLOW_TRANSITION_UNSUPPORTED');
        await sync(step.namespace_key, plan, original.members.map(member => member.runId), now);
        return { kind: 'step', nodeId: node.id, ...result };
    }
    return { tick };
}
module.exports = { createGraphDriver };
