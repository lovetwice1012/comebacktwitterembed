'use strict';

const { assertWorkflow } = require('./schema');

// Materialization limits, not restrictions on accepted DAG shapes. The durable
// executor must report/backpressure oversized inputs rather than truncate them.
const KERNEL_LIMITS = Object.freeze({ members: 10000, ancestry: 512, schedules: 128,
    depth: 32, values: 200000, bytes: 8 * 1024 * 1024 });

function kernelError(code, message) { return Object.assign(new Error(message), { code }); }

/** Copy bounded plain data without invoking accessors or retaining input aliases. */
function copyData(input) {
    let values = 0, bytes = 0;
    const ancestors = new Set();
    const charge = amount => {
        bytes += amount;
        if (bytes > KERNEL_LIMITS.bytes) throw kernelError('GRAPH_INPUT_LIMIT', 'Graph input byte budget exceeded');
    };
    const visit = (value, depth) => {
        if (++values > KERNEL_LIMITS.values || depth > KERNEL_LIMITS.depth) throw kernelError('GRAPH_INPUT_LIMIT', 'Graph input structure budget exceeded');
        if (value === null || value === undefined || typeof value === 'boolean') { charge(5); return value; }
        if (typeof value === 'string') { charge(Buffer.byteLength(value, 'utf8') + 2); return value; }
        if (typeof value === 'number' && Number.isFinite(value)) { charge(24); return value; }
        if (!value || typeof value !== 'object' || ancestors.has(value)) throw kernelError('GRAPH_INPUT_INVALID', 'Graph input must be finite acyclic plain data');
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if (!array && prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) throw kernelError('GRAPH_INPUT_INVALID', 'Graph input must be plain data');
        if (array && value.length > KERNEL_LIMITS.values) throw kernelError('GRAPH_INPUT_LIMIT', 'Graph input array budget exceeded');
        const keys = Object.keys(value);
        if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) throw kernelError('GRAPH_INPUT_INVALID', 'Graph arrays must be dense and have no extra properties');
        const result = array ? [] : Object.create(prototype);
        ancestors.add(value);
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || ['__proto__', 'prototype', 'constructor'].includes(key)) throw kernelError('GRAPH_INPUT_INVALID', 'Graph input contains an accessor or reserved property');
            charge(Buffer.byteLength(key, 'utf8') + 3);
            result[key] = visit(descriptor.value, depth + 1);
        }
        ancestors.delete(value);
        return result;
    };
    return visit(input, 0);
}

/**
 * Compile the complete schema DAG without expanding paths or moving nodes.
 * All maps/arrays belong to the returned plan, never to the supplied workflow.
 */
function compileWorkflow(workflow) {
    const definition = copyData(workflow);
    assertWorkflow(definition);
    const { nodes, edges } = definition;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const incoming = new Map(nodes.map(node => [node.id, []]));
    const outgoing = new Map(nodes.map(node => [node.id, []]));
    for (const edge of edges) { incoming.get(edge.target).push(edge); outgoing.get(edge.source).push(edge); }
    const remaining = new Map(nodes.map(node => [node.id, incoming.get(node.id).length]));
    const ranks = new Map(nodes.map(node => [node.id, 0]));
    const topologicalOrder = nodes.filter(node => remaining.get(node.id) === 0).map(node => node.id);
    for (let index = 0; index < topologicalOrder.length; index++) {
        const id = topologicalOrder[index];
        for (const edge of outgoing.get(id)) {
            ranks.set(edge.target, Math.max(ranks.get(edge.target), ranks.get(id) + 1));
            remaining.set(edge.target, remaining.get(edge.target) - 1);
            if (remaining.get(edge.target) === 0) topologicalOrder.push(edge.target);
        }
    }
    return { ...definition, byId, ranks, incoming, outgoing, topologicalOrder,
        startId: nodes.find(node => node.type === 'start').id };
}

module.exports = { compileWorkflow, KERNEL_LIMITS, copyData, kernelError };
