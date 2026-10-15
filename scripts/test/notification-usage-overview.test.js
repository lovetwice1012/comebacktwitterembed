'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const normal = changes => ({ plan: { id: 'supporter', name: '支援者', baseSlotLimit: 5, slotLimit: 8, dayLimit: 48, minuteLimit: 7 },
    slots: { used: 5, max: 8, available: 3 }, usage: { entries: [{ targetKind: 'auto' }, { targetKind: 'x' }, { targetKind: 'price' }] }, ...changes });
const quota = changes => ({ featureEnabled: true, currentPlan: { planId: 'supporter', label: '支援者', tier: 'supporter', priority: 0, baseSlotLimit: 5, minuteLimit: 7, dayLimit: 48, intervalMinutes: 5 },
    personal: { totalLimit: 8, registeredCount: 3, used: 5, available: 3, supporterExtraSlots: 3 },
    x: { used: 1, available: 3, reasonCode: null, reason: null, specialLimit: 4, specialUsed: 2 },
    pools: { free: { limit: 50, used: 49, available: 1 }, supporter: { limit: 100, used: 2, available: 98 } }, ...changes });
const processing = changes => ({ planLabel: '支援者', effectiveMode: 'batch', requestedMode: 'batch', configured: true, realtimeAllowed: false,
    intervalMinutes: 5, rollout: { eligible: true }, ...changes });
const defaults = () => ({ entitlements: normal(), 'x-monitor-quota': quota(), 'x-processing-settings': processing() });
const article = (f, text) => [...f.container.querySelectorAll('article')].find(node => node.textContent.includes(text));
const fact = (root, name) => [...root.querySelectorAll('dt')].find(node => node.textContent === name)?.nextElementSibling?.textContent;
async function fixture(responses = defaults()) {
    const f = await reactFixture('export { NotificationUsageOverview, notificationUsageAPI } from "./components/automation/notification-usage-overview";');
    f.calls = [];
    f.api = async route => { f.calls.push(route); const value = responses[route]; return typeof value === 'function' ? value() : structuredClone(value); };
    await f.render(f.React.createElement(f.exports.NotificationUsageOverview, { api: f.api })); await f.settle();
    return f;
}

test('usage displays one notification plan for native and X and counts registrations, boosts and permanent additions', async () => {
    const f = await fixture();
    try {
        const slots = article(f, '通知の登録枠'), native = article(f, '通知プラン'), x = article(f, 'X通知の設定を開く');
        assert.equal(fact(slots, '新しく使える枠'), '3枠'); assert.equal(fact(slots, '登録している通知'), '3件');
        assert.equal(fact(slots, '通知方法に使う追加枠'), '2枠'); assert.equal(fact(slots, '支援による恒久追加'), '3枠');
        assert.match(native.textContent, /支援者.*1日48通・1分7通/);
        assert.match(x.textContent, /5分ごとにまとめて通知/); assert.match(native.textContent, /通常通知とX通知に同じプランを適用/); assert.doesNotMatch(f.container.textContent, /Xの処理プラン/);
        assert.equal(x.querySelector('.notification-plan-name').textContent, '1件登録');
        assert.equal(x.querySelector('details').open, false);
        assert.match(slots.textContent, /月額プランの解約後も引き継ぎ/);
        assert.equal(fact(f.container, '共用無料枠の空き'), '1 / 50枠');
        assert.equal(fact(f.container, '支援者優先枠の全体空き'), '98 / 100枠');
        assert.equal(fact(f.container, 'プランの特殊枠の残り'), '2 / 4枠');
        assert.deepEqual(f.calls.sort(), ['entitlements', 'x-monitor-quota', 'x-processing-settings']);
    } finally { await f.close(); }
});

test('paid plan names do not imply realtime or replace server-provided special capacities', async () => {
    const data = defaults();
    data['x-monitor-quota'] = quota({ currentPlan: { ...quota().currentPlan, label: 'ベーシック＋', planId: 'basic_plus', tier: 'paid' }, x: { ...quota().x, specialLimit: 17, specialUsed: 5 } });
    data['x-processing-settings'] = processing({ planLabel: 'ベーシック＋', realtimeAllowed: false, requestedMode: 'realtime' });
    const f = await fixture(data);
    try {
        const x = article(f, 'X通知の設定を開く');
        assert.match(x.textContent, /5分ごとにまとめて通知/); assert.match(x.querySelector('details').textContent, /リアルタイムの希望は保存済み/);
        assert(!x.textContent.includes('リアルタイムも選べます'));
        assert.equal(fact(f.container, 'プランの特殊枠の残り'), '12 / 17枠');
    } finally { await f.close(); }
});

test('a legacy realtime default is kept in details without asserting every monitor uses it', async () => {
    const data = defaults(); data['x-processing-settings'] = processing({ effectiveMode: 'realtime', requestedMode: 'realtime', realtimeAllowed: true, intervalMinutes: null });
    const f = await fixture(data);
    try { const x = article(f, 'X通知の設定を開く'); assert.match(x.querySelector('details').textContent, /個別設定のない既存監視の初期設定リアルタイム/); assert.equal(x.querySelector('.notification-plan-name').textContent, '1件登録'); assert(!x.textContent.includes('null分')); }
    finally { await f.close(); }
});

test('a missing default interval is disclosed without showing an account-wide configuration block', async () => {
    const data = defaults(); data['x-processing-settings'] = processing({ configured: false, intervalMinutes: null });
    const f = await fixture(data);
    try {
        const x = article(f, 'X通知の設定を開く');
        assert.match(x.querySelector('details').textContent, /管理者の間隔設定待ち/);
        assert.equal(x.querySelector('.notification-plan-name').textContent, '1件登録');
        assert.equal(f.container.querySelector('.notification-next-step'), null);
        assert(!x.textContent.includes('購入'));
    } finally { await f.close(); }
});

test('missing batch defaults retain the route to actual per-monitor settings without inferring realtime eligibility', async () => {
    const data = defaults(); data['x-processing-settings'] = processing({ configured: false, intervalMinutes: null, realtimeAllowed: true });
    const f = await fixture(data);
    try {
        const x = article(f, 'X通知の設定を開く');
        assert.equal(x.querySelector('a').getAttribute('href'), '/dashboard/automation#x-notifications');
        assert.equal(f.container.querySelector('.notification-next-step'), null);
        assert(!x.textContent.includes('購入'));
    } finally { await f.close(); }
});

test('personal capacity, shared capacity and beta eligibility offer distinct next actions', async () => {
    for (const [reason, expected] of [['X_MONITOR_PERSONAL_LIMIT', '個人の登録枠'], ['X_MONITOR_POOL_FULL', '全体枠'], ['X_ROLLOUT_SUPPORTERS_ONLY', '参加資格']]) {
        const data = defaults(); data['x-monitor-quota'] = quota({ x: { ...quota().x, reasonCode: reason, available: 0 } });
        const f = await fixture(data);
        try { assert.match(f.container.querySelector('.notification-next-step').textContent, new RegExp(expected)); assert(!f.container.querySelector('.notification-next-step').textContent.includes('寄付する')); }
        finally { await f.close(); }
    }
});

test('partial failed reads preserve verified data and show unknown capacities instead of invented zero', async () => {
    const data = defaults(); data['x-monitor-quota'] = async () => { throw new Error('private-upstream-webhook-token'); };
    const f = await fixture(data);
    try {
        assert.match(f.container.textContent, /一部の利用状況は確認待ち/);
        assert.equal(fact(article(f, '通知の登録枠'), '登録している通知'), '3件');
        assert.equal(fact(article(f, '通知の登録枠'), '通知方法に使う追加枠'), '2枠');
        assert.equal(fact(f.container, '共用無料枠の空き'), '確認待ち'); assert.equal(fact(f.container, 'プランの特殊枠の残り'), '確認待ち');
        assert(!f.container.textContent.includes('private-upstream'));
    } finally { await f.close(); }
});

test('all failed or malformed reads remain recoverable and never present a made-up free plan', async () => {
    const data = { entitlements: null, 'x-monitor-quota': { private: 'must-not-render' }, 'x-processing-settings': { effectiveMode: 'realtime', realtimeAllowed: false } };
    const f = await fixture(data);
    try {
        assert.equal(fact(f.container, '新しく使える枠'), '確認待ち'); assert.equal(fact(f.container, '登録している通知'), '確認待ち');
        assert.match(article(f, '通知プラン').textContent, /確認待ち/); assert(!f.container.textContent.includes('must-not-render'));
        Object.assign(data, defaults()); await f.click('利用状況を更新'); await f.settle();
        assert.equal(fact(f.container, '新しく使える枠'), '3枠'); assert.equal(f.calls.length, 6);
    } finally { await f.close(); }
});

test('status updates refresh the overview and a late original read cannot overwrite the latest allowance', async () => {
    let finishOld, reads = 0;
    const data = defaults(); data.entitlements = () => ++reads === 1 ? new Promise(resolve => { finishOld = resolve; }) : normal({ plan: { ...normal().plan, name: '更新されたプラン' }, slots: { used: 5, max: 11, available: 6 } });
    const f = await fixture(data);
    try {
        await f.act(async () => f.dom.window.dispatchEvent(new f.dom.window.Event('notification:usage-changed'))); await f.settle();
        assert.match(article(f, '通知プラン').textContent, /更新されたプラン/); assert.equal(fact(f.container, '新しく使える枠'), '6枠');
        await f.act(async () => finishOld(normal())); await f.settle();
        assert.match(article(f, '通知プラン').textContent, /更新されたプラン/); assert.equal(fact(f.container, '新しく使える枠'), '6枠');
    } finally { await f.close(); }
});

test('the real usage API sends only authenticated private GETs and never reads failed response details', async () => {
    const f = await reactFixture('export { notificationUsageAPI } from "./components/automation/notification-usage-overview";');
    const calls = []; let failed = false;
    try {
        f.set('fetch', async (address, init) => { calls.push([address, init]); return failed ? { ok: false, json: () => { throw new Error('must not parse private error payload'); } } : new Response(JSON.stringify({ safe: true }), { status: 200 }); });
        assert.deepEqual(await f.exports.notificationUsageAPI('entitlements'), { safe: true });
        assert.deepEqual(calls[0], ['/api/automation/entitlements', { method: 'GET', credentials: 'same-origin', cache: 'no-store' }]);
        failed = true;
        await assert.rejects(f.exports.notificationUsageAPI('x-monitor-quota'), { message: 'Unavailable account usage' });
    } finally { await f.close(); }
});
