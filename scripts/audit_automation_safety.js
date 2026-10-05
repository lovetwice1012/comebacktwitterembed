'use strict';

// Read-only application audit. All transport/DB calls are local stubs. The
// marker is benign; no illegal or offensive material is fetched or generated.
const fs = require('node:fs');
const path = require('node:path');
const { DictionaryMatcher } = require('../src/automation/dictionary');
const { newWorkflow, NODE_TYPES, LIMITS } = require('../src/automation/schema');
const { evaluateWorkflow } = require('../src/automation/engine');
const { createMarketplace } = require('../src/automation/marketplace');
const { createTransport } = require('../src/automation/transport');
const marker = 'AUDIT_SENTINEL';
const matcher = new DictionaryMatcher({ schemaVersion: 1, name: 'Benign audit marker', entries: [marker] });
const output = { auditedAt: new Date().toISOString(), node: process.version, fixtureOnly: true, externalRequests: 0, probes: [] };
const hit = value => matcher.match(value).length > 0;

function transformed(config) {
    const rule = newWorkflow('無害な監査用ルール');
    rule.nodes.splice(1, 0, { id: 'format', type: 'transform', config: { ...structuredClone(NODE_TYPES.transform.defaults), format: 'text', ...config } });
    rule.edges = [{ id: 'one', source: 'start', target: 'format', port: 'out' }, { id: 'two', source: 'format', target: 'send', port: 'out' }];
    return rule;
}
async function submission(rule, extra = {}) {
    const examined = [], writes = [];
    const query = async (sql, args) => { writes.push({ sql, args }); return { affectedRows: 1 }; };
    const market = createMarketplace({ queryDatabase: query, withDatabaseTransaction: work => work(query) }, { moderationMatcher: { match: async text => { examined.push(text); return matcher.match(text); } } });
    try {
        const result = await market.save({ userId: '123' }, { title: '監査用の中立的な名称', description: '挙動確認', category: 'general', visibility: 'public', rightsConfirmed: true,
            bundle: { schemaVersion: 1, kind: 'workflow', workflow: rule, dictionaries: {}, license: 'CC0-1.0' }, ...extra });
        return { acceptedAsPending: result.status === 'pending', screenedMarker: examined.some(hit), writes: writes.length };
    } catch (error) { return { acceptedAsPending: false, screenedMarker: examined.some(hit), errorCode: error.code, writes: writes.length }; }
}
async function main() {
    output.probes.push({ id: 'baseline', control: 'literal marker is detected', detected: hit(marker) });
    output.probes.push({ id: 'nfkc', control: 'full-width compatibility form is detected', detected: hit('ＡＵＤＩＴ＿ＳＥＮＴＩＮＥＬ') });
    for (const [id, value] of [['zero_width', 'AUDIT_\u200bSENTINEL'], ['confusable', '\u0410UDIT_SENTINEL'], ['bidi_isolate', 'AUDIT_\u2066SENTINEL\u2069']]) {
        output.probes.push({ id, observation: 'same-looking marker is not consistently normalized', detected: hit(value), gapObserved: !hit(value) });
    }
    const replacement = transformed({ template: 'neutral', replacements: [{ from: 'neutral', to: marker }] });
    const split = transformed({ template: 'AUDIT_', suffix: 'SENTINEL' });
    const groupLabel = newWorkflow('監査用'); groupLabel.layout = { groups: [{ id: 'label', label: marker }] }; groupLabel.nodes[1].group = 'label';
    for (const [id, rule] of [['replacement_output', replacement], ['concatenated_output', split], ['group_label', groupLabel]]) {
        const result = await submission(rule);
        const finalOutputContainsMarker = evaluateWorkflow(rule, { title: 'neutral', url: 'https://example.invalid/' }, { now: 1000 }).outputs.some(p => hit(p.text));
        output.probes.push({ id, ...result, finalOutputContainsMarker, gapObserved: result.acceptedAsPending && !result.screenedMarker });
    }
    const categoryResult = await submission(newWorkflow('監査用'), { category: marker });
    output.probes.push({ id: 'category_metadata', ...categoryResult, gapObserved: categoryResult.acceptedAsPending && !categoryResult.screenedMarker });

    const plan = evaluateWorkflow(replacement, { title: 'neutral', url: 'https://example.invalid/' }, { now: 1000 }).outputs[0];
    let submittedBody;
    const rest = { post: async (route, options) => {
        if (route === '/users/@me/channels') return { id: '333333333333333333' };
        submittedBody = options.body; return { id: '444444444444444444', channel_id: '333333333333333333' };
    } };
    const transport = createTransport({}, {}, { options: { jsonTransformer: v => v } }, { rest });
    const job = { id: 'fixture', owner_user_id: '222222222222222222', target_kind: 'auto', plan: { ...plan, context: {}, event: {} } };
    const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: job.owner_user_id });
    await transport.sendStep(prepared, job, 0);
    output.probes.push({ id: 'final_transport_gate', mockSubmissionContainsMarker: hit(submittedBody?.content || ''), gapObserved: hit(submittedBody?.content || ''), realMessagesSent: 0 });

    const reconverge = newWorkflow('合流の監査');
    reconverge.nodes.push({ id: 'left', type: 'condition', config: { predicate: { field: 'title', op: 'exists' } } }, { id: 'right', type: 'condition', config: { predicate: { field: 'title', op: 'exists' } } }, { id: 'common', type: 'transform', config: { ...structuredClone(NODE_TYPES.transform.defaults), format: 'text' } });
    reconverge.edges = [['a', 'start', 'left', 'out'], ['b', 'start', 'right', 'out'], ['c', 'left', 'common', 'yes'], ['d', 'right', 'common', 'yes'], ['e', 'common', 'send', 'out']].map(([id, source, target, port]) => ({ id, source, target, port }));
    const converged = evaluateWorkflow(reconverge, { title: 'neutral', url: 'https://example.invalid/' }, { now: 1000 });
    output.probes.push({ id: 'reconverging_paths', explicitMergeBlock: Object.hasOwn(NODE_TYPES, 'merge'), outputsForOneEvent: converged.outputs.length, gapObserved: converged.outputs.length > 1 });

    output.facts = { supportedBlockTypes: Object.keys(NODE_TYPES), limits: LIMITS,
        datasetInventoryPerformedByThisScript: false, moderationAccuracyMeasuredByThisScript: false,
        note: 'These targeted marker probes show implementation gaps. Their failure frequency is not a production false-negative or false-positive rate.' };
    const filename = path.resolve(__dirname, '../docs/audits/automation-self-audit-probes.json');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
