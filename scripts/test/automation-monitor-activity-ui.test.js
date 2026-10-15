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
