'use strict';

const { assertWorkflow, NODE_TYPES, VERSION } = require('./schema');
const { evaluatePredicate, normalizeEvent, UNKNOWN } = require('./engine');
const { MINUTE, DAY, scheduleDelivery } = require('./schedule');
const { copyData, KERNEL_LIMITS, kernelError } = require('./graph-plan');

/**
 * @typedef {object} GraphMember
 * @property {string} id
 * @property {string} runId
 * @property {Record<string, any>} event Original observation, never rewritten.
 * @property {Record<string, any>} display
 * @property {Array<Record<string, any>>} schedules
 * @property {number} dueAtMs
 * @property {number|null} deadlineMs Absolute workflow deadline; never modified.
 * @property {string|null} defaultPriceText
 * @property {number} [baseTimeMs] Frozen fallback for missing observedAtMs.
 * @property {number|null} [scheduleDeadlineMs] Frozen, non-increasing schedule horizon.
 * @property {Record<string, any>} [context]
 * @property {string} [targetKind]
 * @property {string} [targetId]
 */
/**
 * @typedef {object} GraphUnit
 * @property {string} id Input identity; durable caller assigns output identities.
 * @property {'event'|'batch'|'fragment'} kind
 * @property {GraphMember[]} members
 * @property {any[]} ancestry Opaque bounded plain-data lineage, copied unchanged.
 */
/** @typedef {{field: string, type: 'all'|'missing'|'string', value?: string}} GroupKey */
/**
 * @typedef {object} StepResult
 * @property {'complete'|'wait'|'limit'|'aggregate'|'send'|'merge'} state
 * @property {Array<{port: string, unit: GraphUnit}>} emissions
 * @property {Array<Record<string, any>>} trace
 * @property {GraphUnit} [continuation] Wait/intent input; never an outgoing edge.
 * @property {number} [wakeAtMs]
 * @property {Array<{key: GroupKey, keyId: string, unit: GraphUnit}>} [groups]
 * @property {string} [destination]
 * @property {{nodeId: string, type: string, config: Record<string, any>}} [intent]
 */

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
const optionalTime = value => value === undefined || value === null || timestamp(value);
const effectiveDeadline = member => Math.min(member.deadlineMs ?? Infinity, member.scheduleDeadlineMs ?? Infinity);

// Reuse schema validation without inventing a second node-config schema. Layout
// metadata is validated by compileWorkflow and has no execution meaning here.
function validateNode(node) {
    if (!plain(node) || !Object.hasOwn(NODE_TYPES, node.type)) throw kernelError('GRAPH_NODE_INVALID', 'Unknown graph node');
    const entry = { id: node.id, type: node.type, config: node.config };
    const start = { id: node.id === 'kernelStart' ? 'kernelStart2' : 'kernelStart', type: 'start', config: {} };
    const stop = { id: node.id === 'kernelStop' ? 'kernelStop2' : 'kernelStop', type: 'stop', config: { reason: '' } };
    const ports = NODE_TYPES[node.type].ports;
    const nodes = node.type === 'start' ? [entry, stop] : ports.length ? [start, entry, stop] : [start, entry];
    const edges = [];
    if (node.type !== 'start') edges.push({ id: 'kernelIn', source: start.id, target: node.id, port: 'out' });
    if (ports.length) edges.push({ id: 'kernelOut', source: node.id, target: stop.id, port: ports[0] });
    assertWorkflow({ schemaVersion: VERSION, name: 'Pure graph node', nodes, edges });
}

function validateUnit(unit) {
    if (!plain(unit) || typeof unit.id !== 'string' || !unit.id || !['event', 'batch', 'fragment'].includes(unit.kind)
        || !Array.isArray(unit.members) || !Array.isArray(unit.ancestry)) throw kernelError('GRAPH_UNIT_INVALID', 'Invalid graph unit');
    if (unit.members.length > KERNEL_LIMITS.members || unit.ancestry.length > KERNEL_LIMITS.ancestry) throw kernelError('GRAPH_INPUT_LIMIT', 'Graph unit membership/ancestry budget exceeded');
    if (unit.kind === 'event' && unit.members.length > 1) throw kernelError('GRAPH_UNIT_INVALID', 'An event unit contains at most one member');
    const ids = new Set(), schedules = new Set();
    for (const member of unit.members) {
        if (!plain(member) || typeof member.id !== 'string' || !member.id || ids.has(member.id) || typeof member.runId !== 'string' || !member.runId
            || !plain(member.event) || !plain(member.display) || !Array.isArray(member.schedules) || !timestamp(member.dueAtMs)
            || !optionalTime(member.deadlineMs) || !optionalTime(member.scheduleDeadlineMs) || !optionalTime(member.baseTimeMs)
            || member.defaultPriceText != null && typeof member.defaultPriceText !== 'string') throw kernelError('GRAPH_UNIT_INVALID', 'Invalid graph member');
        if (member.schedules.length > KERNEL_LIMITS.schedules) throw kernelError('GRAPH_INPUT_LIMIT', 'Graph schedule budget exceeded');
        ids.add(member.id);
        for (const schedule of member.schedules) {
            const key = JSON.stringify(schedule);
            if (!schedules.has(key)) { validateNode({ id: 'memberSchedule', type: 'schedule', config: schedule }); schedules.add(key); }
            if (schedules.size > KERNEL_LIMITS.schedules) throw kernelError('GRAPH_INPUT_LIMIT', 'Combined schedule budget exceeded');
        }
    }
}

function eventAt(member, now) {
    const event = normalizeEvent(member.event);
    if (event.publishedAtMs !== undefined) event.ageMinutes = Math.max(0, (now - event.publishedAtMs) / MINUTE);
    return event;
}

/** A stable typed key; neither missing nor all can collide with literal text. */
function groupKey(field, event) {
    if (field === 'all') return { field, type: 'all' };
    if (event[field] === undefined || event[field] === null) return { field, type: 'missing' };
    return { field, type: 'string', value: event[field] };
}

/**
 * Pure single-node transition. now is mandatory; no implicit wall clock, DB,
 * leases, aggregate selection, joins, rendering, or outgoing-edge traversal.
 * @param {{id: string, type: string, config: Record<string, any>}} inputNode
 * @param {GraphUnit} inputUnit
 * @param {{now: number, dictionaries?: Record<string, {match: Function}>}} options
 * @returns {StepResult}
 */
function stepNode(inputNode, inputUnit, options) {
    if (!options || !timestamp(options.now)) throw kernelError('GRAPH_TIME_INVALID', 'A finite safe execution timestamp is required');
    const now = options.now, node = copyData(inputNode), unit = copyData(inputUnit);
    validateNode(node); validateUnit(unit);
    const c = node.config;
    /** @type {StepResult} */
    const result = { state: 'complete', emissions: [], trace: [] };
    const record = (member, outcome, detail = {}) => result.trace.push({ nodeId: node.id, memberId: member.id, runId: member.runId, outcome, ...detail });
    const originalCount = unit.members.length;
    const view = members => ({ ...unit, kind: /** @type {GraphUnit['kind']} */ (members.length < originalCount && unit.kind !== 'event' ? 'fragment' : unit.kind), members });
    const intent = state => ({ ...result, state, intent: { nodeId: node.id, type: node.type, config: copyData(c) } });

    unit.members = unit.members.filter(member => {
        if (now > effectiveDeadline(member)) { record(member, 'expired', { reason: 'DEADLINE_EXCEEDED' }); return false; }
        if (member.baseTimeMs == null) member.baseTimeMs = normalizeEvent(member.event).observedAtMs ?? now;
        // Fresh externally supplied units may already carry schedules. Freeze
        // their initial horizon once as well; a resumed continuation has it.
        if (member.scheduleDeadlineMs == null && member.schedules.length) {
            const horizon = now + Math.min(...member.schedules.map(schedule => schedule.maxWaitDays)) * DAY;
            if (!timestamp(horizon)) throw kernelError('GRAPH_TIME_INVALID', 'Schedule exceeds the supported timestamp range');
            member.scheduleDeadlineMs = horizon;
        }
        return true;
    });
    if (!unit.members.length) return result;

    if (node.type === 'condition' || node.type === 'dictionary' || node.type === 'start') {
        const partitions = new Map();
        for (const member of unit.members) {
            const event = eventAt(member, now);
            let port = 'out', detail = null;
            if (node.type === 'start') {
                if (c.providers?.length && !c.providers.includes(event.providerId) || c.kinds?.length && !c.kinds.includes(event.kind)) {
                    record(member, 'excluded', { reason: 'EVENT_NOT_SELECTED' }); continue;
                }
            } else if (node.type === 'condition') {
                const decision = evaluatePredicate(c.predicate, event);
                port = decision === UNKNOWN ? UNKNOWN : decision ? 'yes' : 'no';
            } else {
                const values = c.fields.map(field => event[field]);
                const matcher = options.dictionaries && Object.hasOwn(options.dictionaries, c.dictionary) ? options.dictionaries[c.dictionary] : null;
                if (!matcher || typeof matcher.match !== 'function' || values.every(value => value == null)) port = UNKNOWN;
                else {
                    const matches = [];
                    for (const value of values.filter(value => value != null)) {
                        const found = matcher.match(Array.isArray(value) ? value.join('\n') : String(value), 8);
                        if (!Array.isArray(found) || found.length > 8) throw kernelError('GRAPH_MATCHER_INVALID', 'Dictionary match must synchronously return at most eight matches');
                        const copied = copyData(found);
                        if (copied.some(match => !plain(match) || typeof match.term !== 'string' || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end)
                            || match.start < 0 || match.end < match.start || match.category != null && typeof match.category !== 'string')) throw kernelError('GRAPH_MATCHER_INVALID', 'Invalid dictionary match');
                        matches.push(...copied);
                    }
                    port = matches.length ? 'yes' : values.some(value => value == null) ? UNKNOWN : 'no';
                    detail = matches.slice(0, 8).map(match => ({ term: match.term, start: match.start, end: match.end, category: match.category || null }));
                }
            }
            record(member, port, { detail });
            if (!partitions.has(port)) partitions.set(port, []);
            partitions.get(port).push(member);
        }
        for (const port of ['out', 'yes', 'no', 'unknown']) if (partitions.has(port)) result.emissions.push({ port, unit: copyData(view(partitions.get(port))) });
        return result;
    }

    if (node.type === 'stop') {
        for (const member of unit.members) record(member, 'excluded', { reason: c.reason });
        return result;
    }
    if (node.type === 'delay' || node.type === 'schedule') {
        const configs = new Map();
        unit.members = unit.members.filter(member => {
            if (node.type === 'delay') {
                const event = eventAt(member, now);
                const anchor = c.anchor === 'published' ? event.publishedAtMs : event.observedAtMs ?? member.baseTimeMs;
                if (anchor === undefined) { record(member, UNKNOWN, { reason: 'PUBLISHED_AT_MISSING' }); return false; }
                const due = Math.max(member.dueAtMs, anchor + c.minutes * MINUTE);
                if (!timestamp(due)) throw kernelError('GRAPH_TIME_INVALID', 'Delay exceeds the supported timestamp range');
                member.dueAtMs = due;
            } else {
                const horizon = now + c.maxWaitDays * DAY;
                if (!timestamp(horizon)) throw kernelError('GRAPH_TIME_INVALID', 'Schedule exceeds the supported timestamp range');
                member.scheduleDeadlineMs = Math.min(member.scheduleDeadlineMs ?? Infinity, horizon);
                const key = JSON.stringify(c);
                if (!member.schedules.some(schedule => JSON.stringify(schedule) === key)) {
                    if (member.schedules.length >= KERNEL_LIMITS.schedules) throw kernelError('GRAPH_INPUT_LIMIT', 'Graph schedule budget exceeded');
                    member.schedules.push(copyData(c));
                }
            }
            if (member.dueAtMs > effectiveDeadline(member)) { record(member, 'expired', { reason: 'DELAY_EXCEEDS_DEADLINE' }); return false; }
            return true;
        });
        if (!unit.members.length) return result;
        // One unit stays intact: all retained temporal restrictions must hold at
        // the same instant. Earlier member expiry wakes us to prune/reconsider.
        for (const member of unit.members) for (const schedule of member.schedules) configs.set(JSON.stringify(schedule), schedule);
        if (configs.size > KERNEL_LIMITS.schedules) throw kernelError('GRAPH_INPUT_LIMIT', 'Combined schedule budget exceeded');
        const earliest = Math.max(now, ...unit.members.map(member => member.dueAtMs));
        const deadline = Math.min(...unit.members.map(effectiveDeadline));
        const due = scheduleDelivery(earliest, [...configs.values()], deadline);
        if (due === null || due > now) {
            // A conflicting batch must not expire its healthy members just
            // because another member has the earliest deadline. Reconsider
            // after that member expires, retaining the original unit context.
            const wake = Math.min(due ?? Infinity, Number.isFinite(deadline) ? deadline + 1 : Infinity);
            if (!timestamp(wake)) throw kernelError('GRAPH_TIME_INVALID', 'Temporal wait has no finite supported wake time');
            result.state = 'wait'; result.wakeAtMs = wake; result.continuation = copyData(view(unit.members));
            for (const member of unit.members) record(member, 'wait', { wakeAtMs: wake });
            return result;
        }
        for (const member of unit.members) { member.dueAtMs = Math.max(member.dueAtMs, due); record(member, 'out', { dueAtMs: due }); }
    } else if (node.type === 'transform') {
        for (const member of unit.members) { member.display = copyData(c); member.defaultPriceText = null; record(member, 'out'); }
    } else if (node.type === 'limit' || node.type === 'aggregate') {
        const grouped = new Map();
        for (const member of unit.members) {
            const key = groupKey(c.key, eventAt(member, now)), keyId = JSON.stringify(key);
            if (!grouped.has(keyId)) grouped.set(keyId, { key, keyId, members: [] });
            grouped.get(keyId).members.push(member);
            record(member, node.type, { key: copyData(key) });
        }
        return { ...intent(node.type), groups: [...grouped.values()].map(group => ({ key: group.key, keyId: group.keyId, unit: copyData(view(group.members)) })) };
    } else if (node.type === 'merge' || node.type === 'send') {
        for (const member of unit.members) record(member, node.type);
        return { ...intent(node.type), continuation: copyData(view(unit.members)), ...(node.type === 'send' ? { destination: c.destination } : {}) };
    }
    result.emissions.push({ port: 'out', unit: copyData(view(unit.members)) });
    return result;
}

module.exports = { stepNode };
