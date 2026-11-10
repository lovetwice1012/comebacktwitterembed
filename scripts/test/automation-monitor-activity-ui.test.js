'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const page = (items = [], activity = { lastSentAtMs: null, nextDueAtMs: null }) => ({ items, activity, nextCursor: null });
async function fixture(api) {
    const f = await reactFixture('export { MonitorDeliveryActivity } from "./components/automation/monitor-delivery-activity";');
    f.calls = []; f.props = { kind: 'x', targetId: '3', api: async route => { f.calls.push(route); return api(route); } };
    f.paint = () => f.render(f.React.createElement(f.exports.MonitorDeliveryActivity, f.props));
    await f.paint();
    f.open = async () => { await f.act(async () => { const details = f.container.querySelector('details'); details.open = true; details.dispatchEvent(new f.dom.window.Event('toggle', { bubbles: true })); }); await f.settle(); };
    return f;
}
test('monitor activity reads only after explicit expansion and distinguishes send proof from pending work', async () => {
    const f = await fixture(() => page([{ id: 'a', state: 'unknown', title: '新しい投稿', createdAtMs: 1000 }], { lastSentAtMs: null, nextDueAtMs: 9000 }));
    try {
        assert.deepEqual(f.calls, []); await f.open();
        assert.equal(f.calls[0], 'jobs?targetKind=x&targetId=3');
        assert.match(f.container.textContent, /最終送信確認送信確認はまだありません/);
        assert.match(f.container.textContent, /送信待ちの予定時刻/); assert.match(f.container.textContent, /送信結果不明/);
        assert(!f.container.textContent.includes('接続済み'));
    } finally { await f.close(); }
});
test('excluded deliveries show known reasons without guessing unknown codes or exposing a resend action', async () => {
    const items = [
        { id: 'a', state: 'excluded', title: '枠', createdAtMs: 1000, errorCode: 'AUTOMATION_SLOT_LIMIT' },
        { id: 'b', state: 'excluded', title: '安全', createdAtMs: 1000, errorCode: 'SAFETY_CONTENT_DENIED' },
        { id: 'c', state: 'unknown', title: '確認中', createdAtMs: 1000, errorCode: 'UNRECOGNIZED_REASON' },
    ];
    const f = await fixture(route => route.includes('targetKind') ? page(items) : { ...items.find(row => route.endsWith(row.id)), sentSteps: 0, preview: '内容' });
    try {
        await f.open();
        assert.match(f.container.textContent, /現在のプランで利用できる通知枠/);
        assert.match(f.container.textContent, /安全設定により送信対象外/);
        assert.match(f.container.textContent, /処理記録を確認してください/);
        assert(!f.container.textContent.includes('UNRECOGNIZED_REASON'));
        await f.act(async () => [...f.container.querySelectorAll('button')].find(node => node.textContent.includes('枠')).click()); await f.settle();
        assert(f.container.querySelector('a[href="/dashboard/automation/plans"]'));
        await f.act(async () => [...f.container.querySelectorAll('button')].find(node => node.textContent === '配信内容を閉じる').click());
        await f.act(async () => [...f.container.querySelectorAll('button')].find(node => node.textContent.includes('確認中')).click()); await f.settle();
        assert.match(f.container.textContent, /Discordで送信結果を確認/);
        assert(![...f.container.querySelectorAll('button')].some(node => /再送|再試行/.test(node.textContent)));
    } finally { await f.close(); }
});

test('partial rate-limit outcome never claims another attempt is scheduled', async () => {
    const f = await fixture(() => page([{ id: 'partial', state: 'partial', title: '一部送信', createdAtMs: 1000, errorCode: 'AUTOMATION_RATE_LIMIT_UNAVAILABLE' }]));
    try {
        await f.open(); assert.match(f.container.textContent, /送信上限を確認できませんでした/);
        assert.doesNotMatch(f.container.textContent, /自動で再確認|時刻を待っています/);
    } finally { await f.close(); }
});

test('excluded rule history shows a supported reason and does not invent one from an unrelated merge', async () => {
    const f = await fixture(() => ({ ...page(), ruleRuns: [
        { id: 'known', state: 'excluded', event: { title: '条件' }, created_at_ms: 1000, trace: [{ outcome: 'excluded', reason: 'EVENT_NOT_SELECTED' }] },
        { id: 'other', state: 'excluded', event: { title: '記録待ち' }, created_at_ms: 1000, trace: [{ outcome: 'merged', reason: '合流済み' }], traceHistory: { runId: 'other', indexed: true, firstPage: false, totalEntries: null } },
        { id: 'legacy', state: 'excluded', event: { title: '旧記録' }, created_at_ms: 1000, trace: [{ reason: '確認処理に進みました' }] },
    ] }));
    try {
        await f.open(); const runs = f.container.querySelector('[aria-label="ルールの処理履歴"]');
        assert.match(runs.textContent, /この投稿は通知条件の対象外です/);
        assert(!runs.querySelectorAll('li')[1].textContent.includes('合流済み'));
        assert(![...runs.querySelectorAll('li')[2].children].some(child => child.tagName === 'P' && child.textContent.includes('確認処理に進みました')));
    } finally { await f.close(); }
});
test('grouped notification detail stays in the monitor card and never invents delivery success', async () => {
    const f = await fixture(route => route.includes('targetKind') ? page([{ id: 'a', state: 'partial', title: '投稿A', createdAtMs: 1000 }]) : { id: 'a', state: 'partial', aggregateItems: 2, preview: '配信した内容', sentSteps: 1 });
    try {
        await f.open(); await f.act(async () => [...f.container.querySelectorAll('button')].find(node => node.textContent.includes('投稿A')).click()); await f.settle();
        assert.equal(f.calls.at(-1), 'jobs/a'); assert.match(f.container.textContent, /一部送信済み（まとめ通知）/);
        assert.match(f.container.textContent, /Discordで送信結果を確認/); assert.match(f.container.textContent, /配信した内容/);
        assert(!f.container.textContent.includes('送信に成功'));
    } finally { await f.close(); }
});
test('a response for the previous monitor cannot replace the selected monitor activity', async () => {
    let resolveOld;
    const f = await fixture(route => route.includes('targetId=3') ? new Promise(resolve => { resolveOld = resolve; }) : page([{ id: 'new', state: 'pending', title: '新しい対象の通知', createdAtMs: 1000 }]));
    try {
        await f.open(); f.props.targetId = '4'; await f.paint(); await f.settle();
        await f.act(async () => resolveOld(page([{ id: 'old', state: 'sent', title: '古い対象の通知', createdAtMs: 1000 }], { lastSentAtMs: 1000, nextDueAtMs: null }))); await f.settle();
        assert.match(f.container.textContent, /新しい対象の通知/); assert(!f.container.textContent.includes('古い対象'));
    } finally { await f.close(); }
});
test('expired graph origin remains visible without inventing a grouped delivery for that monitor', async () => {
    const f = await fixture(() => ({ ...page(), ruleRuns: [{ id: 'expired-run', state: 'expired', event: { title: '期限切れになった投稿' }, created_at_ms: 1000, trace: [{ reason: 'DEADLINE_EXCEEDED' }] }], ruleRunsNextCursor: null }));
    try {
        await f.open(); const runs = f.container.querySelector('section[aria-label="ルールの処理履歴"]'); assert(runs);
        assert.match(runs.textContent, /期限切れになった投稿/); assert.match(runs.textContent, /配信期限を過ぎました/);
        assert.equal(runs.querySelectorAll('li').length, 1); assert.equal(f.container.querySelector('ul[aria-label="配信予定・履歴"]').children.length, 0);
        assert(!f.container.textContent.includes('配信履歴は0件')); assert.match(f.container.textContent, /送信確認はまだありません/);
    } finally { await f.close(); }
});
test('job pagination retains rule history and a late rule-history page cannot cross monitor selection', async () => {
    let resolveOld;
    const run = title => ({ id: title, state: 'excluded', event: { title }, created_at_ms: 1000, trace: [{ reason: '利用者が指定した条件' }] });
    const f = await fixture(route => {
        if (route.startsWith('excluded?')) return new Promise(resolve => { resolveOld = resolve; });
        if (route.includes('targetId=4')) return { ...page(), ruleRuns: [run('新しい対象の処理履歴')], ruleRunsNextCursor: null };
        return { ...page([{ id: route.includes('cursor=') ? 'second' : 'first', title: route.includes('cursor=') ? '次の配信' : '最初の配信', state: 'pending', createdAtMs: 1000 }]), nextCursor: route.includes('cursor=') ? null : 'job-page', ruleRuns: route.includes('cursor=') ? [] : [run('最初の処理履歴')], ruleRunsNextCursor: route.includes('cursor=') ? null : 'run-page' };
    });
    try {
        await f.open(); await f.act(async () => [...f.container.querySelectorAll('button')].find(button => button.textContent === '履歴をさらに表示').click()); await f.settle();
        assert.match(f.container.textContent, /最初の処理履歴/); assert.match(f.container.textContent, /次の配信/);
        await f.act(async () => [...f.container.querySelectorAll('button')].find(button => button.textContent === 'ルールの処理履歴をさらに表示').click()); await f.settle();
        assert.equal(f.calls.at(-1), 'excluded?targetKind=x&targetId=3&afterId=run-page');
        f.props.targetId = '4'; await f.paint(); await f.settle();
        await f.act(async () => resolveOld({ items: [run('遅れて届いた古い処理履歴')], nextCursor: null })); await f.settle();
        assert.match(f.container.textContent, /新しい対象の処理履歴/); assert(!f.container.textContent.includes('遅れて届いた')); assert(!f.container.textContent.includes('最初の処理履歴'));
    } finally { await f.close(); }
});
