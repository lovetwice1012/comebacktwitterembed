'use strict';

const { NODE_TYPES, assertWorkflow, LIMITS } = require('./schema');
const copy = value => structuredClone(value);
const newId = prefix => `${prefix}${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
function predicateMode(predicate, op) {
    if (op === predicate.op || op === 'compare' && !['all', 'any', 'not'].includes(predicate.op)) return predicate;
    if (op === 'compare') {
        let leaf = predicate;
        while (['all', 'any', 'not'].includes(leaf.op)) {
            if (leaf.conditions.length !== 1) throw new Error('複数の条件があります。条件を削除するか、子の条件を編集してください。');
            leaf = leaf.conditions[0];
        }
        return copy(leaf);
    }
    if (!['all', 'any', 'not'].includes(op)) throw new Error('条件の組み立てを選択してください。');
    return { op, conditions: ['all', 'any'].includes(op) && ['all', 'any'].includes(predicate.op) ? copy(predicate.conditions) : [copy(predicate)] };
}
function comparisonMode(predicate, op, type) {
    if (op === predicate.op) return predicate;
    const fallback = type === 'number' ? 0 : type === 'boolean' ? false : '';
    const compatible = value => typeof value === (type === 'array' ? 'string' : type);
    const values = (Array.isArray(predicate.value) ? predicate.value : [predicate.value]).filter(compatible);
    return { ...predicate, op, value: op === 'in' ? values.length ? values : [fallback] : values[0] ?? fallback };
}
function connect(rule, source, target, port, id = newId('e')) {
    const from = rule.nodes.find(n => n.id === source), to = rule.nodes.find(n => n.id === target);
    if (!from || !to || to.type === 'start' || !NODE_TYPES[from.type]?.ports.includes(port)) throw new Error('接続元・接続先・分岐を確認してください。');
    if (source === target) throw new Error('同じブロックには接続できません。');
    if (rule.edges.some(e => e.source === source && e.target === target && e.port === port)) return rule;
    const seen = new Set(), stack = [target];
    while (stack.length) {
        const next = stack.pop();
        if (next === source) throw new Error('循環する接続は作れません。');
        if (seen.has(next)) continue;
        seen.add(next);
        for (const edge of rule.edges) if (edge.source === next) stack.push(edge.target);
    }
    if (rule.edges.length >= LIMITS.edges) throw new Error('接続数の上限です。');
    return { ...rule, edges: [...rule.edges, { id, source, target, port }] };
}
function removeNodes(rule, ids) {
    const removed = new Set(ids.filter(id => rule.nodes.find(n => n.id === id)?.type !== 'start'));
    return { ...rule, nodes: rule.nodes.filter(n => !removed.has(n.id)), edges: rule.edges.filter(e => !removed.has(e.source) && !removed.has(e.target)) };
}
function insertNode(rule, type, selectedId, port = 'out', loose = false, makeId = newId) {
    const spec = NODE_TYPES[type], selected = rule.nodes.find(n => n.id === selectedId);
    if (!spec || type === 'start' || rule.nodes.length >= LIMITS.nodes) throw new Error('追加するブロック・個数を確認してください。');
    const id = makeId('n'), node = { id, type, config: copy(spec.defaults), position: { x: (selected?.position?.x || 0) + 260, y: selected?.position?.y || 80 } };
    if (loose || !selected) return { ...rule, nodes: [...rule.nodes, node] };
    const output = spec.ports.includes('yes') ? 'yes' : spec.ports[0];
    let edges;
    if (!NODE_TYPES[selected.type].ports.length) {
        if (!output) throw new Error('通知・停止の前に別の終端は追加できません。分岐を選ぶか「自由に置く」を選択してください。');
        edges = rule.edges.map(edge => edge.target === selected.id ? { ...edge, target: id } : edge);
        edges.push({ id: makeId('e'), source: id, target: selected.id, port: output });
        node.position = { x: (selected.position?.x || 0) - 260, y: selected.position?.y || 80 };
    } else {
        if (!NODE_TYPES[selected.type].ports.includes(port)) throw new Error('追加する経路を選択してください。');
        const outgoing = rule.edges.filter(edge => edge.source === selected.id && edge.port === port);
        if (!output && outgoing.length) throw new Error('この経路は接続済みです。別の分岐を選ぶか「自由に置く」を選択してください。');
        edges = rule.edges.map(edge => outgoing.includes(edge) ? { ...edge, source: id, port: output } : edge);
        edges.push({ id: makeId('e'), source: selected.id, target: id, port });
    }
    if (edges.length > LIMITS.edges) throw new Error('接続数の上限です。');
    return autoLayout({ ...rule, nodes: [...rule.nodes, node], edges });
}
function addGroup(rule, name, nodeIds = [], id = newId('g')) {
    if (!name.trim() || name.length > 120 || (rule.layout?.groups?.length || 0) >= 32) throw new Error('グループ名・個数を確認してください。');
    return { ...rule, layout: { ...rule.layout, groups: [...rule.layout?.groups || [], { id, label: name, collapsed: false }] }, nodes: rule.nodes.map(n => nodeIds.includes(n.id) ? { ...n, group: id } : n) };
}
function removeGroup(rule, id) {
    return { ...rule, layout: { ...rule.layout, groups: (rule.layout?.groups || []).filter(g => g.id !== id) }, nodes: rule.nodes.map(n => { if (n.group !== id) return n; const { group: _group, ...rest } = n; return rest; }) };
}
function validateFragment(fragment) {
    if (!fragment || fragment.schemaVersion !== 1 || fragment.kind !== 'block-fragment' || typeof fragment.name !== 'string' || !fragment.name.trim() || fragment.name.length > 120 || Object.keys(fragment).some(k => !['schemaVersion', 'kind', 'name', 'nodes', 'edges'].includes(k)) || !Array.isArray(fragment.nodes) || !fragment.nodes.length || fragment.nodes.length > 100 || !Array.isArray(fragment.edges)) throw new Error('ブロック部品の形式が不正です。');
    if (fragment.nodes.some(n => n.type === 'start' || n.group)) throw new Error('開始ブロックや別のグループを部品に含めることはできません。');
    const ids = new Set(fragment.nodes.map(n => n.id));
    if (fragment.edges.some(e => !ids.has(e.source) || !ids.has(e.target))) throw new Error('部品の外部への接続は含められません。');
    let root = 'fragment_start', end = 'fragment_end';
    while (ids.has(root)) root += '_';
    while (ids.has(end)) end += '_';
    const nodes = [...copy(fragment.nodes), { id: root, type: 'start', config: {} }], edges = copy(fragment.edges);
    const edgeIds = new Set(edges.map(e => e.id));
    const edgeId = () => { let id = `fragment_e${edgeIds.size}`; while (edgeIds.has(id)) id += '_'; edgeIds.add(id); return id; };
    for (const node of fragment.nodes) {
        if (!edges.some(e => e.target === node.id)) edges.push({ id: edgeId(), source: root, target: node.id, port: 'out' });
        if (NODE_TYPES[node.type]?.ports.length && !edges.some(e => e.source === node.id)) {
            if (!nodes.some(n => n.id === end)) nodes.push({ id: end, type: 'stop', config: { reason: '部品の外側' } });
            edges.push({ id: edgeId(), source: node.id, target: end, port: NODE_TYPES[node.type].ports[0] });
        }
    }
    assertWorkflow({ schemaVersion: 1, name: fragment.name, nodes, edges });
    return fragment;
}
function exportGroup(rule, id) {
    const group = rule.layout?.groups?.find(g => g.id === id);
    if (!group) throw new Error('グループを選んでください。');
    const nodes = rule.nodes.filter(n => n.group === id).map(({ group: _group, ...n }) => copy(n)), ids = new Set(nodes.map(n => n.id));
    return validateFragment({ schemaVersion: 1, kind: 'block-fragment', name: group.label, nodes, edges: copy(rule.edges.filter(e => ids.has(e.source) && ids.has(e.target))) });
}
function importGroup(rule, fragment, makeId = newId) {
    validateFragment(fragment);
    if (rule.nodes.length + fragment.nodes.length > LIMITS.nodes || rule.edges.length + fragment.edges.length > LIMITS.edges) throw new Error('ブロック・接続数の上限を超えます。');
    const groupId = makeId('g'), ids = new Map(fragment.nodes.map(n => [n.id, makeId('n')]));
    const grouped = addGroup(rule, fragment.name, [], groupId);
    const minX = Math.min(...fragment.nodes.map(n => n.position?.x || 0)), minY = Math.min(...fragment.nodes.map(n => n.position?.y || 0));
    const offsetX = Math.max(0, ...rule.nodes.map(n => n.position?.x || 0)) + 300;
    return { ...grouped, nodes: [...rule.nodes, ...fragment.nodes.map(n => ({ ...copy(n), id: ids.get(n.id), group: groupId, position: { x: (n.position?.x || 0) - minX + offsetX, y: (n.position?.y || 0) - minY + 80 } }))],
        edges: [...rule.edges, ...fragment.edges.map(e => ({ ...e, id: makeId('e'), source: ids.get(e.source), target: ids.get(e.target) }))] };
}
function autoLayout(rule) {
    const depth = new Map(), queue = rule.nodes.filter(n => n.type === 'start').map(n => n.id);
    for (const id of queue) depth.set(id, 0);
    for (let visits = 0; queue.length && visits < LIMITS.paths; visits++) {
        const id = queue.shift();
        for (const edge of rule.edges.filter(e => e.source === id)) {
            const next = Math.min(LIMITS.nodes, (depth.get(id) || 0) + 1);
            if (!depth.has(edge.target) || depth.get(edge.target) < next) { depth.set(edge.target, next); queue.push(edge.target); }
        }
    }
    const lanes = new Map();
    return { ...rule, nodes: rule.nodes.map((n, i) => {
        const column = depth.get(n.id) ?? 0, lane = lanes.get(column) || 0;
        lanes.set(column, lane + 1);
        return { ...n, position: { x: column * 270 + 40, y: lane * 190 + (depth.has(n.id) ? 60 : 600 + i * 10) } };
    }) };
}
module.exports = { predicateMode, comparisonMode, connect, removeNodes, insertNode, addGroup, removeGroup, validateFragment, exportGroup, importGroup, autoLayout };
