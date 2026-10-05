'use strict';

const { compileWorkflow } = require('./graph-plan');
const { stepNode } = require('./graph-step');
const { normalizeEvent } = require('./engine');
const { createGraphDriver } = require('./graph-driver');
const { createFlowProjector } = require('./flow-projector');

// Resolves only immutable workflow revisions and dictionary revisions already
// authorized at source admission. It has no provider or Discord dependency.
function createFlowRuntime(db, evaluator, store, options = {}) {
    const assertEnabled = options.assertEnabled || (() => {});
    const plans = new Map(), contexts = new Map();
    async function context(namespace) {
        if (!contexts.has(namespace)) {
            const row = (await db.queryDatabase('SELECT context_json FROM automation_flow_runs WHERE namespace_key=? ORDER BY run_id LIMIT 1', [namespace]))[0];
            if (!row) throw Object.assign(new Error('FLOW_CONTEXT_MISSING'), { code: 'FLOW_CONTEXT_MISSING' });
            contexts.set(namespace, JSON.parse(row.context_json));
        }
        return contexts.get(namespace);
    }
    async function loadPlan(namespace) {
        if (plans.has(namespace)) return plans.get(namespace);
        const flow = await context(namespace);
        const rows = await db.queryDatabase('SELECT definition_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [flow.workflowId, flow.revision]);
        if (!rows.length) throw Object.assign(new Error('FLOW_REVISION_MISSING'), { code: 'FLOW_REVISION_MISSING' });
        const plan = compileWorkflow(JSON.parse(rows[0].definition_json));
        plans.set(namespace, plan); return plan;
    }
    async function evaluateStep(node, unit, now, namespace) {
        if (node.type !== 'dictionary') return stepNode(node, unit, { now });
        if (!namespace) throw Object.assign(new Error('FLOW_MEMBER_CONTEXT_MISSING'), { code: 'FLOW_MEMBER_CONTEXT_MISSING' });
        const flow = await context(namespace), ref = flow.bindings?.dictionaries?.[node.config.dictionary];
        if (!ref) return stepNode(node, unit, { now, dictionaries: {} });
        const texts = new Set();
        for (const member of unit.members) {
            const event = normalizeEvent(member.event);
            for (const field of node.config.fields) if (event[field] != null) texts.add(Array.isArray(event[field]) ? event[field].join('\n') : String(event[field]));
        }
        const matches = new Map();
        for (const text of texts) matches.set(text, await evaluator.match(ref, text));
        return stepNode(node, unit, { now, dictionaries: { [node.config.dictionary]: { match: text => matches.get(text) || [] } } });
    }
    const driver = createGraphDriver(store, {
        assertEnabled,
        loadPlan,
        evaluateStep,
    });
    async function tick(now = Date.now()) {
        const result = await driver.tick(now);
        const projected = await createFlowProjector(db).projectOne(now);
        return { ...result, projected };
    }
    return { tick, loadPlan, context, clear: () => { plans.clear(); contexts.clear(); } };
}
module.exports = { createFlowRuntime };
