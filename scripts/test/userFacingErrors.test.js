'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { failureReason } = require('../../src/userFacingErrors');
const { buildFailureResponse } = require('../../src/providers/_output_controls');

test('failure messages classify supported failures in Japanese and English without raw secrets', () => {
    const samples = [[{ status: 429 }, /利用制限/, /rate limited/], [{ status: 403 }, /アクセスが拒否/, /denied access/],
        [{ status: 404 }, /見つかりません/, /could not be found/], [{ status: 503 }, /一時的/, /temporarily/],
        [{ name: 'AbortError' }, /一時的/, /temporarily/], [{ code: 'ETIMEDOUT' }, /一時的/, /temporarily/], [{}, /取得・解析/, /retrieved or parsed/]];
    for (const [fields, ja, en] of samples) {
        const error = Object.assign(new Error('private-secret https://example.test/?token=secret'), fields);
        assert.match(failureReason(error, 'ja'), ja);
        assert.match(failureReason(error, 'en-US'), en);
        assert.doesNotMatch(failureReason(error, 'ja'), /private-secret|token=|example.test/);
    }
});

test('failure notices preserve silent policy and localize Japanese source-link controls', () => {
    const url = 'https://example.test/post';
    assert.equal(buildFailureResponse('test', url, { failure_display_policy: 'silent' }, new Error('secret')), null);
    const [link] = buildFailureResponse('test', url, { defaultLanguage: 'ja', failure_display_policy: 'source_link' });
    assert.equal(link.content, '元のリンクをご確認ください。');
    assert.equal(link.components[0].components[0].data.label, '元のリンクを開く');
    assert.equal(link.components[0].components[0].data.url, url);
    const [failure] = buildFailureResponse('test', url, { defaultLanguage: 'ja', failure_display_policy: 'error_summary' }, { status: 429 });
    assert.match(failure.content, /利用制限/);
    assert.equal(failure.outputRole, 'failure_notice');
});
