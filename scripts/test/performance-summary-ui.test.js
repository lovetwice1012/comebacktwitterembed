'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

test('admin can inspect aggregate timing without automatic requests or false browser timing', async () => {
    const f = await reactFixture('export { PerformanceSummary } from "./components/admin/performance-summary";');
    const calls = [];
    const api = async path => { calls.push(path); const empty = { count: 0, failures: 0, p95UpperMs: null, overLastBucket: 0 }; return { scope: 'current_process', uptimeSeconds: 10, database: { count: 4, failures: 1, p95UpperMs: 50, overLastBucket: 0 },
        api: { monitors: { count: 2, failures: 0, p95UpperMs: 100, overLastBucket: 0 }, x: empty, billing: empty, plans: empty, history: empty, other: empty } }; };
    try {
        await f.render(f.React.createElement(f.exports.PerformanceSummary, { api }));
        assert.deepEqual(calls, []); await f.click('数値を確認');
        assert.deepEqual(calls, ['performance']); assert.match(f.container.textContent, /DB問い合わせ/);
        assert.match(f.container.textContent, /50ms以下/); assert.match(f.container.textContent, /ブラウザーでの表示時間は含みません/);
    } finally { await f.close(); }
});

test('invalid aggregate data is reported without rendering invented values', async () => {
    const f = await reactFixture('export { PerformanceSummary } from "./components/admin/performance-summary";');
    try {
        await f.render(f.React.createElement(f.exports.PerformanceSummary, { api: async () => ({ scope: 'current_process', database: {} }) }));
        await f.click('数値を確認'); assert.match(f.container.textContent, /運用状況を取得できませんでした/);
        assert.doesNotMatch(f.container.textContent, /DB問い合わせ/);
    } finally { await f.close(); }
});

test('rapid clicks share one read and late results are discarded after the API context changes', async () => {
    const f = await reactFixture('export { PerformanceSummary } from "./components/admin/performance-summary";');
    let calls = 0, resolveOld;
    const oldApi = () => { calls++; return new Promise(resolve => { resolveOld = resolve; }); };
    try {
        await f.render(f.React.createElement(f.exports.PerformanceSummary, { api: oldApi }));
        await f.act(async () => { const button = f.container.querySelector('button'); button.click(); button.click(); });
        assert.equal(calls, 1);
        await f.render(f.React.createElement(f.exports.PerformanceSummary, { api: async () => ({}) }));
        const empty = { count: 0, failures: 0, p95UpperMs: null, overLastBucket: 0 };
        await f.act(async () => resolveOld({ scope: 'current_process', uptimeSeconds: 1, database: empty,
            api: { monitors: empty, x: empty, billing: empty, plans: empty, history: empty, other: empty } }));
        assert.doesNotMatch(f.container.textContent, /DB問い合わせ/);
        assert.equal(f.container.querySelector('button').disabled, false);
    } finally { await f.close(); }
});
