'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseMetrics, createPoolRegistry } = require('../../src/adminSupport/databaseMetrics');

test('database timing uses bounded aggregate buckets without query contents', () => {
    const metric = createDatabaseMetrics();
    assert.equal(metric.snapshot().p95UpperMs, null);
    for (let i = 0; i < 19; i++) metric.record(4);
    metric.record(2000, true); metric.record(-1); metric.record(NaN);
    const result = metric.snapshot();
    assert.equal(result.count, 20); assert.equal(result.failures, 1);
    assert.equal(result.p95UpperMs, 5); assert.equal(result.maximumMs, 2000);
    assert.equal(result.buckets.reduce((a, b) => a + b, 0), 20);
    assert.equal(JSON.stringify(result).includes('SELECT'), false);
    result.buckets.fill(0); assert.equal(metric.snapshot().count, 20);
});

test('overflow durations remain bounded and do not imply a precise p95', () => {
    const metric = createDatabaseMetrics(); metric.record(900000, true);
    const result = metric.snapshot(); assert.equal(result.maximumMs, 300000);
    assert.equal(result.overLastBucket, 1); assert.equal(result.p95UpperMs, null);
});

test('a duration beyond the metric cap remains in the overflow bucket', () => {
    const metric = createDatabaseMetrics({ bounds: [1000, 86400000], capMs: 86400000 });
    metric.record(86400001);
    const result = metric.snapshot();
    assert.equal(result.maximumMs, 86400000); assert.equal(result.overLastBucket, 1); assert.equal(result.p95UpperMs, null);
});

test('connection counts are aggregate snapshots and unavailable for unknown pool implementations', () => {
    const registry = createPoolRegistry(); registry.register({}, 8);
    assert.equal(registry.snapshot().available, false);
    const pool = { _allConnections: [{}, {}, {}], _freeConnections: [{}], _connectionQueue: [{}] };
    registry.register(pool, 8);
    assert.deepEqual(registry.snapshot(), { available: true, total: 3, busy: 2, waiting: 1, limit: 8 });
    pool._freeConnections.push({}); assert.equal(registry.snapshot().busy, 1);
});

test('performance endpoint is admin-only and exposes fixed aggregate categories', async () => {
    const { dispatch } = require('../../src/automation/api');
    await assert.rejects(dispatch({ method: 'GET', path: ['performance'] }, { userId: '123456789012345678', isAdmin: false }, {}), { code: 'AUTOMATION_FORBIDDEN' });
    const result = await dispatch({ method: 'GET', path: ['performance'] }, { userId: '234567890123456789', isAdmin: true }, {});
    assert.equal(result.scope, 'current_process');
    assert.deepEqual(Object.keys(result.api).sort(), ['billing', 'history', 'monitors', 'other', 'plans', 'x']);
    assert.doesNotMatch(JSON.stringify(result), /123456789012345678|234567890123456789|SELECT|private-value/);
});
