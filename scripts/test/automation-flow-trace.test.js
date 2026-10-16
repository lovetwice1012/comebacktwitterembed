'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { traceProjection, indexedTrace, MAX_PROJECTION_BYTES } = require('../../src/automation/flow-trace');
test('small history projections retain ordinary arrays and every original field', () => {
    const records = [{ nodeId: 'start', outcome: 'yes', source: { user: true }, detail: [{ term: '雪', start: 0, end: 1 }] }], trace = traceProjection(); trace.push(...records);
    assert.deepEqual(trace.result(), records); assert.equal(trace.permanent, false); assert.equal(trace.expired, false); assert.equal(indexedTrace(records), false);
});
test('large history projections store a bounded array index while counting and hashing every later record', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ nodeId: `step${i}`, outcome: 'yes', detail: 'x'.repeat(500000) }));
    records.push({ nodeId: 'failed', outcome: 'excluded', reason: 'GRAPH_INPUT_LIMIT' }, { nodeId: 'late', outcome: 'expired', reason: 'DEADLINE_EXCEEDED' });
    const trace = traceProjection(); for (const record of records) trace.push(record);
    const result = trace.result(), digest = createHash('sha256'); for (const record of records) digest.update(JSON.stringify(record)).update('\n');
    assert.equal(indexedTrace(result), true); assert.equal(result[0].traceIndex.projectedEntries, records.length); assert.equal(result[0].traceIndex.digest, digest.digest('hex'));
    assert(Buffer.byteLength(JSON.stringify(result)) < MAX_PROJECTION_BYTES); assert.equal(trace.permanent, true); assert.equal(trace.expired, true);
});
