'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeBatchDue } = require('../../experiments/chrome-push/packaged-cadence-fixture.cjs');

const id = '33333333-3333-4333-8333-333333333333';
const fixtureSchema = 'cbte_automation_test_0123456789abcdefabcd';

test('packaged cadence helper refuses non-fixture databases and malformed identities before SQL', async () => {
    let calls = 0;
    for (const [schema, subscriptionId, now] of [
        ['ComebackTwitterEmbed', id, 400000],
        [fixtureSchema, 'invalid', 400000],
        [fixtureSchema, id, 300999],
        [fixtureSchema, id, NaN],
    ]) {
        await assert.rejects(makeBatchDue({ schema, queryDatabase: async () => { calls++; } }, subscriptionId, now), /FIXTURE_CADENCE_INVALID/);
    }
    assert.equal(calls, 0);
});

test('packaged cadence helper refuses to treat a missing receiver as success', async () => {
    await assert.rejects(makeBatchDue({ schema: fixtureSchema, queryDatabase: async () => ({ affectedRows: 0 }) }, id, 400000), /FIXTURE_CADENCE_RECEIVER_MISSING/);
});
