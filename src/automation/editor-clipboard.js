'use strict';

const { assertWorkflow, NODE_TYPES, LIMITS } = require('./schema');

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const clone = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function invalid(message = 'コピーしたブロックの形式が不正です。') {
    const error = Object.assign(new Error(message), { code: 'AUTOMATION_CLIPBOARD_INVALID' });
    throw error;
}
function keys(value, allowed) {
    if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function jsonTree(value, depth = 0, seen = new Set()) {
    if (depth > 32) invalid('条件の入れ子が深すぎます。');
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !plain(value) || seen.has(value)) invalid();
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
        if (RESERVED.has(key)) invalid();
        jsonTree(item, depth + 1, seen);
    }
    seen.delete(value);
}
function refs(nodes) {
    return {
        destinations: new Set(nodes.filter(n => n.type === 'send' && n.config.destination !== 'default').map(n => n.config.destination)),
        dictionaries: new Set(nodes.filter(n => n.type === 'dictionary').map(n => n.config.dictionary)),
    };
}
function checkBindings(input) {
    keys(input, ['destinations', 'dictionaries']);
    const result = { destinations: {}, dictionaries: {} };
    for (const kind of ['destinations', 'dictionaries']) {
        const entries = input[kind] ?? {};
        if (!plain(entries)) invalid('通知先・辞書の割り当てが不正です。');
        for (const [alias, ref] of Object.entries(entries)) {
            if (!NAME.test(alias) || RESERVED.has(alias)) invalid('通知先・辞書の名前が不正です。');
            if (kind === 'destinations') {
                if (typeof ref !== 'string' || !RESOURCE_ID.test(ref)) invalid('通知先の参照が不正です。');
            } else {
                keys(ref, ['id', 'revision']);
                if (typeof ref.id !== 'string' || !RESOURCE_ID.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) invalid('辞書の参照・版が不正です。');
            }
            result[kind][alias] = clone(ref);
        }
    }
    return result;
}

// A selection is an editable graph fragment. Unlike an executable workflow it
// may have several roots, dangling outputs and no terminal block. Validate each
// node through the shared schema using a tiny complete graph, then validate the
// actual internal edges separately. This does not spend the selection's node or
// edge budget on synthetic validation nodes and never changes its topology.
function validateSelection(input) {
    jsonTree(input);
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > LIMITS.bytes) invalid('コピーするブロックが大きすぎます。');
    keys(input, ['schemaVersion', 'kind', 'nodes', 'edges', 'groups', 'bindings']);
    if (input.schemaVersion !== 1 || input.kind !== 'automation-selection' || !Array.isArray(input.nodes) || !input.nodes.length
        || input.nodes.length >= LIMITS.nodes || !Array.isArray(input.edges) || input.edges.length > LIMITS.edges) invalid();
    const groups = input.groups ?? [];
    if (!Array.isArray(groups) || groups.length > 32) invalid('グループは32個までです。');
    const groupIds = new Set();
    for (const group of groups) {
        keys(group, ['id', 'label', 'collapsed']);
        if (typeof group.id !== 'string' || !NAME.test(group.id) || groupIds.has(group.id) || typeof group.label !== 'string' || !group.label.trim() || group.label.length > 120
            || group.collapsed !== undefined && typeof group.collapsed !== 'boolean') invalid('グループの形式が不正です。');
        groupIds.add(group.id);
    }
    const nodes = new Map();
    for (const node of input.nodes) {
        keys(node, ['id', 'type', 'config', 'position', 'group']);
        if (node.type === 'start') invalid('開始ブロックは複製できません。');
        if (typeof node.id !== 'string' || !NAME.test(node.id) || nodes.has(node.id) || !Object.hasOwn(NODE_TYPES, node.type)) invalid('ブロックの種類・IDが不正です。');
        if (node.type === 'send' && typeof node.config?.destination !== 'string' || node.type === 'dictionary' && typeof node.config?.dictionary !== 'string') invalid('通知先・辞書の名前が不正です。');
        if (node.group !== undefined && !groupIds.has(node.group)) invalid('所属グループが見つかりません。');
        if (node.position !== undefined) keys(node.position, ['x', 'y']);
        if (node.type === 'transform' && node.config?.replacements !== undefined) {
            if (!Array.isArray(node.config.replacements)) invalid();
            for (const replacement of node.config.replacements) keys(replacement, ['from', 'to']);
        }
        nodes.set(node.id, node);
    }
    if (groups.some(group => !input.nodes.some(node => node.group === group.id))) invalid('空のグループはコピーできません。');
    let counter = 0;
    const syntheticId = () => { let id; do { id = `clipboard_validation${counter++}`; } while (nodes.has(id)); return id; };
    const root = syntheticId(), end = syntheticId();
    for (const node of input.nodes) {
        const output = NODE_TYPES[node.type].ports[0];
        const validationNodes = [{ id: root, type: 'start', config: {} }, node];
        const validationEdges = [{ id: 'clipboard_edge1', source: root, target: node.id, port: 'out' }];
        if (output) {
            validationNodes.push({ id: end, type: 'stop', config: { reason: '' } });
            validationEdges.push({ id: 'clipboard_edge2', source: node.id, target: end, port: output });
        }
        assertWorkflow({ schemaVersion: 1, name: '選択したブロック', nodes: validationNodes, edges: validationEdges, layout: { groups } });
    }
    const edgeIds = new Set(), pairs = new Set(), adjacency = new Map(input.nodes.map(node => [node.id, []]));
    for (const edge of input.edges) {
        keys(edge, ['id', 'source', 'target', 'port']);
        const from = nodes.get(edge.source), to = nodes.get(edge.target), pair = `${edge.source}:${edge.port}:${edge.target}`;
        if (typeof edge.id !== 'string' || !NAME.test(edge.id) || edgeIds.has(edge.id) || !from || !to || !NODE_TYPES[from.type].ports.includes(edge.port) || pairs.has(pair)) invalid('接続先・分岐・接続IDが不正です。');
        edgeIds.add(edge.id); pairs.add(pair); adjacency.get(edge.source).push(edge.target);
    }
    const visited = new Set(), visiting = new Set();
    const visit = id => {
        if (visiting.has(id)) invalid('循環する接続は貼り付けられません。');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const next of adjacency.get(id)) visit(next);
        visiting.delete(id); visited.add(id);
    };
    for (const id of nodes.keys()) visit(id);
    if (input.bindings !== undefined) {
        const bindings = checkBindings(input.bindings), used = refs(input.nodes);
        for (const kind of ['destinations', 'dictionaries']) if (Object.keys(bindings[kind]).some(alias => !used[kind].has(alias))) invalid('選択外の通知先・辞書はコピーできません。');
        return { ...clone(input), bindings };
    }
    return clone(input);
}

function copySelection(rule, ids, bindings) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) invalid('コピーするブロックを選んでください。');
    const requested = new Set(ids), nodes = clone(rule.nodes.filter(node => requested.has(node.id) && node.type !== 'start'));
    if (!nodes.length) invalid('開始以外のブロックを選んでください。');
    const selected = new Set(nodes.map(node => node.id)), groupIds = new Set(nodes.map(node => node.group).filter(Boolean));
    const selection = { schemaVersion: 1, kind: 'automation-selection', nodes,
        edges: clone(rule.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target))) };
    if (groupIds.size) selection.groups = clone((rule.layout?.groups || []).filter(group => groupIds.has(group.id)));
    if (bindings !== undefined) {
        const used = refs(nodes), selectedBindings = { destinations: {}, dictionaries: {} };
        keys(bindings, ['destinations', 'dictionaries']);
        for (const kind of ['destinations', 'dictionaries']) for (const alias of used[kind]) {
            if (Object.hasOwn(bindings[kind] || {}, alias)) selectedBindings[kind][alias] = clone(bindings[kind][alias]);
        }
        selection.bindings = selectedBindings;
    }
    return validateSelection(selection);
}

function cutSelection(rule, ids) {
    if (!Array.isArray(ids)) invalid('切り取るブロックを選んでください。');
    const requested = new Set(ids), removed = new Set(rule.nodes.filter(node => requested.has(node.id) && node.type !== 'start').map(node => node.id));
    if (!removed.size) return rule;
    const nodes = rule.nodes.filter(node => !removed.has(node.id)), edges = rule.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
    const touched = new Set(rule.nodes.filter(node => removed.has(node.id)).map(node => node.group).filter(Boolean));
    const layout = rule.layout?.groups ? { ...rule.layout, groups: rule.layout.groups.filter(group => !touched.has(group.id) || nodes.some(node => node.group === group.id)) } : rule.layout;
    return { ...rule, nodes, edges, ...(layout === undefined ? {} : { layout }) };
}

function sameReference(kind, left, right) {
    return kind === 'destinations' ? left === right : left?.id === right?.id && left?.revision === right?.revision;
}
function freeAlias(alias, reserved) {
    for (let number = 1; ; number++) {
        const suffix = number === 1 ? '_copy' : `_copy${number}`, candidate = alias.slice(0, 64 - suffix.length) + suffix;
        if (!reserved.has(candidate)) return candidate;
    }
}
function pasteSelection(rule, input, position, bindings) {
    const selection = validateSelection(input);
    if (rule.nodes.length + selection.nodes.length > LIMITS.nodes || rule.edges.length + selection.edges.length > LIMITS.edges
        || (rule.layout?.groups?.length || 0) + (selection.groups?.length || 0) > 32) invalid('ブロック・接続・グループ数の上限を超えます。');
    if (position !== undefined && (!plain(position) || Object.keys(position).some(key => !['x', 'y'].includes(key))
        || !Number.isFinite(position.x) || !Number.isFinite(position.y))) invalid('貼り付ける位置が不正です。');
    const occupied = new Set([...rule.nodes.map(node => node.id), ...rule.edges.map(edge => edge.id), ...(rule.layout?.groups || []).map(group => group.id)]);
    const makeId = prefix => {
        let id; do { id = `${prefix}${globalThis.crypto.randomUUID().replaceAll('-', '')}`; } while (occupied.has(id));
        occupied.add(id); return id;
    };
    const nodeIds = new Map(selection.nodes.map(node => [node.id, makeId('n')])), groupIds = new Map((selection.groups || []).map(group => [group.id, makeId('g')]));
    const minX = Math.min(...selection.nodes.map(node => node.position?.x ?? 0)), minY = Math.min(...selection.nodes.map(node => node.position?.y ?? 0));
    const anchor = position ?? { x: minX + 40, y: minY + 40 };
    const nodes = selection.nodes.map(node => ({ ...clone(node), id: nodeIds.get(node.id), ...(node.group ? { group: groupIds.get(node.group) } : {}),
        position: { x: (node.position?.x ?? 0) - minX + anchor.x, y: (node.position?.y ?? 0) - minY + anchor.y } }));
    if (nodes.some(node => Math.abs(node.position.x) > 1000000 || Math.abs(node.position.y) > 1000000)) invalid('貼り付ける位置がキャンバスの範囲を超えます。');
    let mergedBindings;
    if (bindings !== undefined || selection.bindings !== undefined) {
        mergedBindings = checkBindings(bindings ?? {});
        const incoming = selection.bindings ?? { destinations: {}, dictionaries: {} }, used = refs(nodes), existingRefs = refs(rule.nodes);
        for (const kind of ['destinations', 'dictionaries']) {
            const reserved = new Set([...Object.keys(mergedBindings[kind]), ...existingRefs[kind], ...used[kind]]), aliases = new Map();
            for (const alias of used[kind]) {
                const hasIncoming = Object.hasOwn(incoming[kind], alias), existing = mergedBindings[kind][alias];
                let target = alias;
                const boundCollision = Object.hasOwn(mergedBindings[kind], alias) && (!hasIncoming || !sameReference(kind, existing, incoming[kind][alias]));
                const unboundCollision = hasIncoming && !Object.hasOwn(mergedBindings[kind], alias) && existingRefs[kind].has(alias);
                if (boundCollision || unboundCollision) {
                    target = hasIncoming ? Object.keys(mergedBindings[kind]).sort().find(key => sameReference(kind, mergedBindings[kind][key], incoming[kind][alias])) : undefined;
                    target ||= freeAlias(alias, reserved);
                }
                reserved.add(target); aliases.set(alias, target);
                if (hasIncoming) mergedBindings[kind][target] = clone(incoming[kind][alias]);
            }
            for (const node of nodes) {
                const field = kind === 'destinations' && node.type === 'send' ? 'destination' : kind === 'dictionaries' && node.type === 'dictionary' ? 'dictionary' : null;
                if (field && aliases.has(node.config[field])) node.config[field] = aliases.get(node.config[field]);
            }
        }
    }
    const edges = selection.edges.map(edge => ({ ...edge, id: makeId('e'), source: nodeIds.get(edge.source), target: nodeIds.get(edge.target) }));
    const groups = (selection.groups || []).map(group => ({ ...group, id: groupIds.get(group.id) }));
    const result = { rule: { ...rule, nodes: [...rule.nodes, ...nodes], edges: [...rule.edges, ...edges],
        ...(groups.length ? { layout: { ...rule.layout, groups: [...rule.layout?.groups || [], ...groups] } } : {}) }, nodeIds: nodes.map(node => node.id), edgeIds: edges.map(edge => edge.id) };
    if (new TextEncoder().encode(JSON.stringify(result.rule)).byteLength > LIMITS.bytes) invalid('貼り付けるとルールのサイズ上限を超えます。');
    if (mergedBindings !== undefined) result.bindings = mergedBindings;
    return result;
}

module.exports = { copySelection, cutSelection, pasteSelection, validateSelection };
