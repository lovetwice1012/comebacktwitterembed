'use strict';

const { assertWorkflow, LIMITS, FIELDS } = require('./schema');
const { MINUTE, DAY, scheduleDelivery } = require('./schedule');
const UNKNOWN = 'unknown';

function evaluatePredicate(predicate, event) {
    if (['all', 'any', 'not'].includes(predicate.op)) {
        const results = predicate.conditions.map(p => evaluatePredicate(p, event));
        if (predicate.op === 'not') return results[0] === UNKNOWN ? UNKNOWN : !results[0];
        if (predicate.op === 'all') return results.includes(false) ? false : results.includes(UNKNOWN) ? UNKNOWN : true;
        return results.includes(true) ? true : results.includes(UNKNOWN) ? UNKNOWN : false;
    }
    const actual = event[predicate.field];
    const missing = actual === null || actual === undefined;
    if (predicate.op === 'exists') return !missing;
    if (missing) return UNKNOWN;
    const normalize = v => typeof v === 'string' ? (predicate.ignoreCase ? v.normalize('NFKC').toLowerCase() : v.normalize('NFC')) : v;
    const a = normalize(actual), b = normalize(predicate.value);
    const textMatch = fn => Array.isArray(actual) ? actual.some(v => typeof v === 'string' && fn(normalize(v))) : typeof a === 'string' ? fn(a) : UNKNOWN;
    switch (predicate.op) {
        case 'eq': return a === b;
        case 'ne': return a !== b;
        case 'contains': return textMatch(v => v.includes(b));
        case 'notContains': { const result = textMatch(v => v.includes(b)); return result === UNKNOWN ? UNKNOWN : !result; }
        case 'startsWith': return textMatch(v => v.startsWith(b));
        case 'endsWith': return textMatch(v => v.endsWith(b));
        case 'in': return Array.isArray(actual) ? actual.some(v => predicate.value.map(normalize).includes(normalize(v))) : predicate.value.map(normalize).includes(a);
        case 'gt': return typeof a === 'number' ? a > b : UNKNOWN;
        case 'gte': return typeof a === 'number' ? a >= b : UNKNOWN;
        case 'lt': return typeof a === 'number' ? a < b : UNKNOWN;
        case 'lte': return typeof a === 'number' ? a <= b : UNKNOWN;
        default: return UNKNOWN;
    }
}

function normalizeEvent(input) {
    if (!input || typeof input !== 'object') throw new Error('Event object required');
    const event = {};
    for (const [field, type] of Object.entries(FIELDS)) {
        const value = input[field];
        if (value === undefined || value === null) continue;
        if (type === 'array' && Array.isArray(value)) event[field] = value.slice(0, 1000).filter(v => typeof v === 'string').map(v => v.slice(0, 500));
        else if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) event[field] = value;
        else if (type === 'boolean' && typeof value === 'boolean') event[field] = value;
        else if (type === 'string' && typeof value === 'string') event[field] = value.slice(0, field === 'body' ? 65536 : 4096);
    }
    return event;
}
const { templateText, outputText } = require('./text-transform');
function graphRanks(workflow) {
    const rank = new Map();
    const predecessors = new Map(workflow.nodes.map(n => [n.id, []]));
    for (const edge of workflow.edges) predecessors.get(edge.target).push(edge.source);
    const depth = id => {
        if (!rank.has(id)) rank.set(id, Math.max(0, ...predecessors.get(id).map(parent => depth(parent) + 1)));
        return rank.get(id);
    };
    for (const node of workflow.nodes) depth(node.id);
    return rank;
}

// Pure evaluation: no network, DB, timer, or Discord calls. Stateful rate gates
// and aggregation are returned as intents for transactional queue admission.
function evaluateWorkflow(workflow, input, options = {}) {
    assertWorkflow(workflow);
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now)) throw new Error('Invalid evaluation time');
    const event = normalizeEvent(input);
    if (event.publishedAtMs !== undefined) event.ageMinutes = Math.max(0, (now - event.publishedAtMs) / MINUTE);
    const nodes = new Map(workflow.nodes.map(n => [n.id, n]));
    const start = workflow.nodes.find(n => n.type === 'start');
    const queue = [{ nodeId: start.id, dueAtMs: now, schedules: [], limits: [], aggregate: null,
        display: { format: 'expanded', template: '{title}\n{url}', maxLength: 1900, media: 'inherit', mentions: 'none' }, path: [] }];
    const outputs = [], trace = [];
    const ranks = workflow.nodes.some(n => n.type === 'merge') ? graphRanks(workflow) : null;
    const baseTime = event.observedAtMs ?? now;
    const deadline = workflow.expiresAfterMinutes ? baseTime + workflow.expiresAfterMinutes * MINUTE : Infinity;
    let visited = 0;
    while (queue.length) {
        if (++visited > LIMITS.paths || outputs.length >= LIMITS.outputs) throw new Error('AUTOMATION_EVALUATION_LIMIT');
        // Topological processing guarantees all matched incoming paths have
        // arrived before an explicit merge is evaluated, even at unequal depth.
        if (ranks) queue.sort((a, b) => ranks.get(a.nodeId) - ranks.get(b.nodeId));
        let branch = queue.shift();
        const node = nodes.get(branch.nodeId), c = node.config;
        if (node.type === 'merge') {
            const arrivals = [branch];
            for (let i = queue.length - 1; i >= 0; i--) if (queue[i].nodeId === node.id) arrivals.push(...queue.splice(i, 1));
            const arrivedEdges = new Set(arrivals.map(item => item.viaEdgeId));
            const expected = workflow.edges.filter(edge => edge.target === node.id);
            if (c.mode === 'all' && expected.some(edge => !arrivedEdges.has(edge.id))) {
                trace.push({ nodeId: node.id, outcome: 'excluded', reason: '合流に必要な経路がすべて一致していません', arrived: arrivedEdges.size, expected: expected.length }); continue;
            }
            const displayConflict = arrivals.some(item => JSON.stringify(item.display) !== JSON.stringify(branch.display));
            const aggregateConflict = arrivals.some(item => JSON.stringify(item.aggregate) !== JSON.stringify(branch.aggregate));
            if (aggregateConflict || displayConflict && c.displayConflict === 'stop') {
                trace.push({ nodeId: node.id, outcome: 'unknown', reason: aggregateConflict ? 'まとめ通知は合流の後に配置してください' : '合流前の表示設定が異なります。合流の後で表示を指定してください' }); continue;
            }
            const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
            branch = { ...branch, dueAtMs: Math.max(...arrivals.map(item => item.dueAtMs)),
                schedules: unique(arrivals.flatMap(item => item.schedules)), limits: unique(arrivals.flatMap(item => item.limits)),
                path: [...new Set(arrivals.flatMap(item => item.path))],
                display: displayConflict ? { format: 'expanded', template: '{title}\n{url}', maxLength: 1900, media: 'inherit', mentions: 'none' } : branch.display };
            trace.push({ nodeId: node.id, outcome: 'merged', arrivals: arrivals.length, reason: '同じイベントを1件に合流し、一致した全経路の時間・件数制限を保持しました' });
        }
        branch.path.push(node.id);
        let port = 'out', detail = null;
        if (node.type === 'start' && ((c.providers?.length && !c.providers.includes(event.providerId)) || (c.kinds?.length && !c.kinds.includes(event.kind)))) {
            trace.push({ nodeId: node.id, outcome: 'excluded', reason: '対象外のイベント' }); continue;
        }
        if (node.type === 'condition') { const result = evaluatePredicate(c.predicate, event); port = result === UNKNOWN ? UNKNOWN : result ? 'yes' : 'no'; }
        if (node.type === 'dictionary') {
            const values = c.fields.map(f => event[f]);
            const matcher = options.dictionaries?.[c.dictionary];
            if (!matcher || values.every(v => v === null || v === undefined)) port = UNKNOWN;
            else {
                const samples = values.filter(v => v != null).map(v => Array.isArray(v) ? v.join('\n') : String(v));
                const matches = samples.flatMap(text => matcher.match(text, 8));
                // An absent body/tag may contain a match, so a negative result is
                // unknown unless every requested field was actually observed.
                port = matches.length ? 'yes' : values.some(v => v == null) ? UNKNOWN : 'no';
                detail = matches.slice(0, 8).map(m => ({ term: m.term, start: m.start, end: m.end, category: m.category || null }));
            }
        }
        if (node.type === 'delay') {
            if (c.anchor === 'published' && event.publishedAtMs === undefined) { trace.push({ nodeId: node.id, outcome: 'unknown', reason: '公開日時を取得できません' }); continue; }
            const anchor = c.anchor === 'published' ? event.publishedAtMs : baseTime;
            branch.dueAtMs = Math.max(branch.dueAtMs, anchor + c.minutes * MINUTE);
        }
        if (node.type === 'schedule') branch.schedules.push(c);
        if (node.type === 'transform') branch.display = structuredClone(c);
        if (node.type === 'limit') branch.limits.push({ nodeId: node.id, ...c, group: c.key === 'all' ? 'all' : String(event[c.key] ?? 'unknown') });
        if (node.type === 'aggregate') branch.aggregate = { nodeId: node.id, ...c, group: c.key === 'all' ? 'all' : String(event[c.key] ?? 'unknown') };
        if (node.type === 'stop') { trace.push({ nodeId: node.id, outcome: 'excluded', reason: c.reason }); continue; }
        if (node.type === 'send') {
            // Freeze the schedule search horizon in the delivery plan. Retries
            // must not turn a 14-day maximum wait into a rolling deadline.
            const deliveryDeadline = Math.min(deadline, ...branch.schedules.map(schedule => branch.dueAtMs + schedule.maxWaitDays * DAY));
            const due = scheduleDelivery(branch.dueAtMs, branch.schedules, deliveryDeadline);
            if (due === null) { trace.push({ nodeId: node.id, outcome: 'expired', reason: '期限内に通知可能な時刻がありません' }); continue; }
            const text = outputText(branch.display, event);
            outputs.push({ destination: c.destination, dueAtMs: due, deadlineMs: Number.isFinite(deliveryDeadline) ? deliveryDeadline : null,
                display: branch.display, text, limits: branch.limits, aggregate: branch.aggregate, schedules: branch.schedules, path: branch.path });
            trace.push({ nodeId: node.id, outcome: 'scheduled', dueAtMs: due, destination: c.destination }); continue;
        }
        const edges = workflow.edges.filter(e => e.source === node.id && e.port === port);
        trace.push({ nodeId: node.id, outcome: port, detail, ...(edges.length ? {} : { reason: 'この分岐の接続がないため通知しません' }) });
        for (const edge of edges) queue.push({ ...structuredClone(branch), nodeId: edge.target, viaEdgeId: edge.id });
    }
    return { event, outputs, trace };
}
module.exports = { evaluateWorkflow, evaluatePredicate, normalizeEvent, templateText, outputText, UNKNOWN };
