'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refreshFlowHistory } = require('../../src/automation/flow-history');

test('history projection keeps ordered shared steps and per-run traces with unordered membership links', async () => {
    const origins = [{ run_id: 'run-a', revoked_at_ms: null }, { run_id: 'run-b', revoked_at_ms: null }];
    const steps = [
        { id: 'first', node_id: 'first', state: 'done', decision_json: JSON.stringify({ trace: [{ nodeId: 'first', outcome: 'yes' }] }) },
        { id: 'shared', node_id: 'shared', state: 'done', decision_json: JSON.stringify({ trace: [
            { nodeId: 'common', outcome: 'yes' }, { nodeId: 'only-a', outcome: 'yes', runId: 'run-a' },
            { nodeId: 'only-b', outcome: 'yes', runId: 'run-b' },
        ] }) },
        { id: 'last', node_id: 'last', state: 'pending', decision_json: '{}' },
    ];
    const links = [
        { run_id: 'run-b', id: 'last' }, { run_id: 'run-a', id: 'shared' },
        { run_id: 'run-a', id: 'missing' }, { run_id: 'run-a', id: 'first' },
        { run_id: 'run-b', id: 'shared' }, { run_id: 'run-a', id: 'first' },
    ];
    const updates = new Map();
    const query = async (sql, params = []) => {
        if (sql.startsWith('SELECT run_id,revoked_at_ms')) return origins;
        if (sql.startsWith('SELECT DISTINCT m.run_id,s.id')) return links;
        if (sql.startsWith('SELECT s.id,s.node_id,s.state')) return steps;
        if (sql.startsWith('UPDATE automation_runs')) { updates.set(params[2], { state: params[0], trace: JSON.parse(params[1]) }); return { affectedRows: 1 }; }
        return [];
    };
    await refreshFlowHistory(query, ['run-a', 'run-b']);
    assert.deepEqual(updates.get('run-a').trace.map(item => item.nodeId), ['first', 'common', 'only-a']);
    assert.deepEqual(updates.get('run-b').trace.map(item => item.nodeId), ['common', 'only-b', 'last']);
    assert.equal(updates.get('run-a').state, 'excluded');
    assert.equal(updates.get('run-b').state, 'waiting');
});
