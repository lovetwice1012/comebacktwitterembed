'use strict';

// Counts copies of one event, not the number of send blocks. In particular,
// reconverging ordinary blocks keep every copy; only an explicit merge joins
// them. Ternary decision diagrams retain mutually exclusive yes/no/unknown
// outcomes when those paths meet again or reach different notifications.
// The caller must first validate node IDs, edges, reachability and acyclicity.
function analyzeFanout(workflow, outputLimit) {
    const cap = outputLimit + 1;
    const terminals = Array.from({ length: cap + 1 }, (_, value) => ({ id: value, value, maximum: value, variable: Infinity }));
    const decisions = new Map(), memo = new Map(), thresholdMemo = new Map();
    let nextId = terminals.length, work = 0, conservative = false;
    // A malicious graph must not turn save/validation into exponential work.
    // On exhaustion, replace an expression by its safe upper bound. This may
    // overestimate a very complex rule, but can never admit excessive fanout.
    const workLimit = 50000, decisionLimit = 10000;
    const constant = value => terminals[Math.min(cap, value)];
    const decision = (variable, children) => {
        if (children.every(child => child === children[0])) return children[0];
        const maximum = Math.max(...children.map(child => child.maximum));
        if (work >= workLimit || decisions.size >= decisionLimit) { conservative = true; return constant(maximum); }
        const key = `${variable}:${children.map(child => child.id).join(',')}`;
        let result = decisions.get(key);
        if (!result) { result = { id: nextId++, variable, children, maximum }; decisions.set(key, result); }
        return result;
    };
    const apply = (operation, left, right) => {
        if (operation === 'add' && !left.maximum) return right;
        if (operation === 'add' && !right.maximum) return left;
        if (operation === 'multiply' && (!left.maximum || !right.maximum)) return terminals[0];
        if (operation === 'multiply' && left.value === 1) return right;
        if (operation === 'multiply' && right.value === 1) return left;
        const combine = (a, b) => Math.min(cap, operation === 'add' ? a + b : a * b);
        if (left.value !== undefined && right.value !== undefined) return constant(combine(left.value, right.value));
        if (++work >= workLimit) { conservative = true; return constant(combine(left.maximum, right.maximum)); }
        if (left.id > right.id) [left, right] = [right, left];
        const key = `${operation}:${left.id}:${right.id}`;
        if (memo.has(key)) return memo.get(key);
        const variable = Math.min(left.variable, right.variable);
        const children = [0, 1, 2].map(index => apply(operation,
            left.variable === variable ? left.children[index] : left,
            right.variable === variable ? right.children[index] : right));
        const result = decision(variable, children);
        memo.set(key, result);
        return result;
    };
    const atLeast = (expression, minimum = 1) => {
        if (expression.value !== undefined) return terminals[expression.value >= minimum ? 1 : 0];
        if (++work >= workLimit) { conservative = true; return terminals[expression.maximum >= minimum ? 1 : 0]; }
        const key = `${expression.id}:${minimum}`;
        if (!thresholdMemo.has(key)) thresholdMemo.set(key,
            decision(expression.variable, expression.children.map(child => atLeast(child, minimum))));
        return thresholdMemo.get(key);
    };

    const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
    const incoming = new Map(workflow.nodes.map(node => [node.id, []]));
    const outgoing = new Map(workflow.nodes.map(node => [node.id, []]));
    for (const edge of workflow.edges) { incoming.get(edge.target).push(edge); outgoing.get(edge.source).push(edge); }
    const remaining = new Map(workflow.nodes.map(node => [node.id, incoming.get(node.id).length]));
    const order = workflow.nodes.filter(node => remaining.get(node.id) === 0).map(node => node.id);
    for (let index = 0; index < order.length; index++) for (const edge of outgoing.get(order[index])) {
        remaining.set(edge.target, remaining.get(edge.target) - 1);
        if (!remaining.get(edge.target)) order.push(edge.target);
    }
    const counts = new Map(), edgeCounts = new Map(), sendCounts = new Map();
    const timeDependent = predicate => predicate.field === 'ageMinutes'
        || Array.isArray(predicate.conditions) && predicate.conditions.some(timeDependent);
    let outputCount = terminals[0], variable = 0;
    for (const id of order) {
        const node = nodes.get(id), arrivals = incoming.get(id).map(edge => edgeCounts.get(edge.id));
        let count = node.type === 'start' ? terminals[1] : arrivals.reduce((sum, item) => apply('add', sum, item), terminals[0]);
        if (node.type === 'merge') count = node.config.mode === 'all'
            ? arrivals.reduce((all, item) => apply('multiply', all, atLeast(item)), terminals[1]) : atLeast(count);
        counts.set(id, count.maximum);
        if (node.type === 'send') { sendCounts.set(id, count.maximum); outputCount = apply('add', outputCount, count); }
        if (node.type === 'condition' || node.type === 'dictionary') {
            // The durable executor recalculates age at each arrival. Copies
            // which took different delays can therefore choose different
            // outcomes at the same block. Give each potential copy its own
            // ternary outcome, still allowing exactly one port per active copy.
            if (count.maximum > 1 && node.type === 'condition' && timeDependent(node.config.predicate)) {
                const ports = ['yes', 'no', 'unknown'], portCounts = new Map(ports.map(port => [port, terminals[0]]));
                for (let copy = 1; copy <= count.maximum; copy++) {
                    const active = atLeast(count, copy), copyVariable = variable++;
                    for (let selected = 0; selected < ports.length; selected++) {
                        const mask = decision(copyVariable, [0, 1, 2].map(index => terminals[index === selected ? 1 : 0]));
                        portCounts.set(ports[selected], apply('add', portCounts.get(ports[selected]), apply('multiply', active, mask)));
                    }
                }
                for (const edge of outgoing.get(id)) edgeCounts.set(edge.id, portCounts.get(edge.port));
                continue;
            }
            const branchVariable = variable++;
            const masks = new Map(['yes', 'no', 'unknown'].map((port, selected) => [port,
                decision(branchVariable, [0, 1, 2].map(index => terminals[index === selected ? 1 : 0]))]));
            for (const edge of outgoing.get(id)) edgeCounts.set(edge.id, apply('multiply', count, masks.get(edge.port)));
        } else for (const edge of outgoing.get(id)) edgeCounts.set(edge.id, count);
    }
    return { maximumOutputs: outputCount.maximum, nodeCounts: counts, sendCounts, conservative };
}

module.exports = { analyzeFanout };
