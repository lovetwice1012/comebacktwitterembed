'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canRetryHistory, groupHistory } = require('../../src/expansionRetryPolicy');

const now = 1000000;
const failed = overrides => ({ state: 'failed', outcome: 'extract_failed', has_output: 0, has_delivery: 0,
    provider_id: 'twitter', raw_url: 'https://x.com/u/status/1', updated_at_ms: now - 30000, ...overrides });

test('retry requires recorded, completed pre-send failures and a cooldown', () => {
    assert.equal(canRetryHistory([], now), false);
    for (const outcome of ['extract_failed', 'extract_exception', 'queue_rejected']) {
        assert.equal(canRetryHistory([failed({ outcome })], now), true);
    }
    assert.equal(canRetryHistory([failed({ updated_at_ms: now - 29999 })], now), false);
    assert.equal(canRetryHistory([failed({ updated_at_ms: NaN })], now), false);
    assert.equal(canRetryHistory([failed({ updated_at_ms: now + 1000 })], now), false);
    assert.equal(canRetryHistory([failed({ has_output: undefined })], now), false);
});

test('a success, generated payload, attempted delivery or uncertain older attempt prevents blanket resend', () => {
    for (const row of [
        failed({ state: 'completed', outcome: 'F' }), failed({ state: 'queued' }), failed({ state: 'processing' }),
        failed({ state: 'sending' }), failed({ state: 'interrupted' }), failed({ state: 'skipped' }),
        failed({ outcome: 'request_exception' }), failed({ outcome: 'failure_notice' }), failed({ outcome: 'unknown' }),
        failed({ has_output: 1 }), failed({ has_delivery: 1 }),
    ]) assert.equal(canRetryHistory([failed(), row], now), false, JSON.stringify(row));
});

test('history shares X aliases but separates providers and media selections', () => {
    const rows = [failed(), failed({ raw_url: 'https://twitter.com/old/status/1/?s=20' }),
        failed({ raw_url: 'https://x.com/u/status/1/photo/2' }), failed({ provider_id: 'other' })];
    const groups = [...groupHistory(rows).values()];
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0], rows.slice(0, 2));
});
