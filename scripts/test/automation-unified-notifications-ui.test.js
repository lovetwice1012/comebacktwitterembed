'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { openNotification } = require('./helpers/notification-registration-fixture.cjs');

const rollout = { mode: 'supporters', eligible: true, reasonCode: null, reason: null };
const quality = { planId: 'basic', priority: 2, minuteLimit: 5, dayLimit: 24, intervalMinutes: 5 };
const quota = { featureEnabled: true, currentPlan: { ...quality, label: 'ベーシック', tier: 'paid', baseSlotLimit: 10 },
    personal: { totalLimit: 10, registeredCount: 3, used: 3, available: 7, supporterExtraSlots: 0 },
    x: { used: 1, available: 7, specialLimit: 3, specialUsed: 0, reasonCode: null, reason: null },
    pools: { free: { limit: 50, used: 1, available: 49 }, supporter: { limit: 100, used: 0, available: 100 } } };
const normalRow = (kind, id = '1', changes = {}) => ({ id, kind, scope: 'private', name: kind === 'auto' ? '新着サンプル' : '価格サンプル', revision: 1,
    providerId: kind === 'auto' ? 'github' : 'steam', source: kind === 'auto' ? 'https://github.com/example' : 'https://store.steampowered.com/app/730',
    locale: 'ja', enabled: true, destinationId: 'dm-one', workflowId: '', intervalMinutes: 30, mode: 'change', maxPriceAmount: null, minDiscountPercent: null, ...changes });
const xRow = (changes = {}) => ({ id: '1', accountId: '12345', accountHandle: 'example_x', name: 'Xサンプル', enabled: true, state: 'ready', poolKind: 'free',
    notificationSettings: {}, workflowStatus: null, destinationStatus: null, subscriptionState: 'unconfigured', revision: 1, quality, ...changes });
const setup = { available: true, receiverEnabled: true, chromeEnabled: true, braveEnabled: true, rollout,
    download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) }, subscriptions: [], maxFileBytes: 32768, nextCursor: null };
const processing = { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'basic', planLabel: 'ベーシック', intervalMinutes: 5, configured: true, reasonCode: null, rollout };

async function fixture({ initial, fail = [], scope = 'private', canEdit = true, guildId, response } = {}) {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    f.set('confirm', () => true);
    f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    const rows = { auto: [normalRow('auto')], price: [normalRow('price')], x: [xRow()], ...initial };
    f.rows = rows; f.calls = [];
    const api = async (raw, method = 'GET', body) => {
        const url = new URL(raw, 'http://fixture/'), path = url.pathname.slice(1);
        f.calls.push({ path, method, body, query: url.searchParams.get('query'), state: url.searchParams.get('state'), afterId: url.searchParams.get('afterId') });
        if (response) { const value = await response({ path, method, body, url, f }); if (value !== undefined) return value; }
        if (fail.includes(path)) throw Object.assign(new Error('fixture read failed'), { status: 503 });
        if (path === 'providers') return { auto: [{ id: 'github' }, { id: 'youtube' }], price: [{ id: 'steam' }], autoRegistration: { eligible: true } };
        if (path === 'entitlements') return { plan: { name: 'ベーシック', priority: 2, dayLimit: 24, minuteLimit: 5 }, slots: { used: 3, max: 10, available: 7 }, usage: { entries: [] } };
        if (path === 'x-monitor-quota') return quota;
        if (path === 'x-setup') return setup;
        if (path === 'x-processing-settings') return processing;
        if (path === 'x-monitors' && method === 'GET') return { items: rows.x.map(row => ({ ...row })), quota };
        if (path === 'monitors/auto' || path === 'monitors/price') {
            const kind = path.split('/')[1], needle = (url.searchParams.get('query') || '').trim().toLowerCase(), state = url.searchParams.get('state') || 'all';
            const filtered = rows[kind].filter(row => (!needle || [row.name, row.providerId, row.source].some(s => String(s).toLowerCase().includes(needle)))
                && (state === 'all' || state === 'paused' && !row.enabled || state === 'active' && row.enabled && !row.errorCode || state === 'attention' && row.enabled && row.errorCode));
            const after = url.searchParams.get('afterId'), start = after ? filtered.findIndex(row => row.id === after) + 1 : 0;
            const page = filtered.slice(start, start + 2); return { items: page.map(row => ({ ...row })), nextCursor: filtered.length > start + 2 ? page.at(-1).id : null };
        }
        const match = path.match(/^monitors\/(auto|price)\/([^/]+)$/);
        if (match && method === 'PATCH') { const row = rows[match[1]].find(item => item.id === match[2]); assert(row); assert.equal(body.expectedRevision, row.revision); Object.assign(row, body, { revision: row.revision + 1 }); return { id: row.id, revision: row.revision }; }
        if (match && method === 'DELETE') { const index = rows[match[1]].findIndex(item => item.id === match[2]); assert(index >= 0); rows[match[1]].splice(index, 1); return { deleted: true }; }
        const xMatch = path.match(/^x-monitors\/([^/]+)$/);
        if (xMatch && method === 'PATCH') { const row = rows.x.find(item => item.id === xMatch[1]); assert(row); assert.equal(body.expectedRevision, row.revision); Object.assign(row, body, { revision: row.revision + 1 }); return { ...row }; }
        if (xMatch && method === 'DELETE') { const index = rows.x.findIndex(item => item.id === xMatch[1]); assert(index >= 0); assert.equal(body.expectedRevision, rows.x[index].revision); rows.x.splice(index, 1); return { deleted: true }; }
        if (path === 'channels') return { items: [] };
        if (path.startsWith('jobs')) return { items: [], nextCursor: null };
        throw new Error(`Unexpected fixture request: ${method} ${path}`);
    };
    f.api = api;
    await f.render(f.React.createElement(f.exports.MonitorManager, { api, scope, canEdit, guildId,
        destinations: [{ id: 'dm-one', name: '個人DM', kind: 'dm', enabled: true, scope: 'private', revision: 1 }], rules: [], refresh: async () => {} }));
    await f.settle(); await f.act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    return f;
}
function list(f) { const node = f.container.querySelector('.monitor-list[aria-label="登録した通知"]'); assert(node, 'unified notification list'); return node; }
function article(f, name) { const node = [...list(f).querySelectorAll('article')].find(item => item.textContent.includes(name)); assert(node, `missing card ${name}`); return node; }
async function buttonWithin(f, node, label) {
    const button = [...node.querySelectorAll('button')].find(item => item.textContent.trim() === label);
    assert(button, `missing button ${label}`); await f.act(async () => button.click()); await f.settle();
}
async function settleSearch(f) { await f.act(async () => new Promise(resolve => setTimeout(resolve, 350))); await f.settle(); }

test('one list displays normal, price and X with colliding IDs and sends each stop to the right API', async () => {
    const f = await fixture();
    try {
        const container = list(f);
        assert.equal(container.querySelectorAll('article').length, 3);
        for (const name of ['新着サンプル', '価格サンプル', 'Xサンプル']) article(f, name);
        await buttonWithin(f, article(f, '新着サンプル'), '停止');
        await buttonWithin(f, article(f, '価格サンプル'), '停止');
        await buttonWithin(f, article(f, 'Xサンプル'), '停止');
        assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').map(call => [call.path, call.body.expectedRevision, call.body.enabled]), [
            ['monitors/auto/1', 1, false], ['monitors/price/1', 1, false], ['x-monitors/1', 1, false],
        ]);
    } finally { await f.close(); }
});

test('editing and deleting X with colliding IDs never modifies the other services', async () => {
    const f = await fixture();
    try {
        await buttonWithin(f, article(f, 'Xサンプル'), '設定を変更');
        await f.fill(f.field('監視の表示名'), 'Xの名前を変更');
        await f.act(async () => f.container.querySelector('form[aria-label="X監視の登録設定"]').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
        await f.settle(); assert.match(list(f).textContent, /Xの名前を変更/);
        assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').map(call => [call.path, call.body.expectedRevision]), [['x-monitors/1', 1]]);
        await buttonWithin(f, article(f, 'Xの名前を変更'), '削除'); await f.click('このX監視を削除'); await f.settle();
        assert.equal(f.calls.filter(call => call.method === 'DELETE')[0].path, 'x-monitors/1');
        assert.match(list(f).textContent, /新着サンプル/); assert.match(list(f).textContent, /価格サンプル/);
    } finally { await f.close(); }
});

test('the default list is combined and the kind filter narrows it without refetching X', async () => {
    const f = await fixture();
    try {
        const picker = f.container.querySelector('select[aria-label="通知の種類"]'); assert(picker);
        assert.equal(picker.value, 'all'); assert.equal(list(f).querySelectorAll('article').length, 3);
        const xReads = f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length;
        assert.equal(xReads, 1, 'initial combined list performs only one X reconciliation');
        for (const [kind, name] of [['auto', '新着サンプル'], ['price', '価格サンプル'], ['x', 'Xサンプル']]) {
            await f.fill(picker, kind); await f.settle();
            assert.equal(list(f).querySelectorAll('article').length, 1); assert.match(list(f).textContent, new RegExp(name));
        }
        await f.fill(picker, 'all'); await f.settle(); assert.equal(list(f).querySelectorAll('article').length, 3);
        assert.equal(f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length, xReads);
    } finally { await f.close(); }
});

test('cadence update only changes the auto monitor when a price monitor has the same ID', async () => {
    const initial = { auto: [normalRow('auto', '1', { canAllocateCadence: true, baseIntervalMinutes: 30, slotCost: 1, effectiveSlotCost: 1, cadenceUpdatedAtMs: null })],
        price: [normalRow('price', '1')], x: [] };
    const f = await fixture({ initial, response: ({ path, method, body, f: state }) => {
        if (path === 'monitors/auto/1' && method === 'POST' && body.action === 'cadence') {
            assert.equal(body.expectedRevision, 1); assert.equal(body.expectedUpdatedAtMs, null);
            Object.assign(state.rows.auto[0], { revision: 2, slotCost: body.slotCost, effectiveSlotCost: body.slotCost, cadenceUpdatedAtMs: 2000, intervalMinutes: 15 });
            return { id: '1', slotCost: body.slotCost, effectiveSlotCost: body.slotCost, intervalMs: 900000, updatedAtMs: 2000 };
        }
    } });
    try {
        await buttonWithin(f, article(f, '新着サンプル'), '設定を変更');
        await f.click('確認間隔・使用枠'); await f.fill(f.field('この通知で使う枠数'), '2');
        await f.click('枠配分の変更を確認'); await f.click('この枠配分で保存'); await f.settle();
        assert.equal(f.rows.auto[0].slotCost, 2); assert.equal(f.rows.price[0].revision, 1);
        assert.equal(f.calls.filter(call => call.method !== 'GET' && call.path.startsWith('monitors/price')).length, 0);
        assert.match(list(f).textContent, /価格サンプル/);
        await f.click('キャンセル'); await buttonWithin(f, article(f, '価格サンプル'), '設定を変更');
        assert(f.field('商品URL')); assert.equal(f.field('商品URL').value, 'https://store.steampowered.com/app/730');
    } finally { await f.close(); }
});

test('a failed source stays visible as an error without hiding the other kinds or claiming an empty list', async () => {
    for (const kind of ['monitors/auto', 'monitors/price', 'x-monitors']) {
        const f = await fixture({ fail: [kind] });
        try {
            const content = list(f).textContent;
            if (kind !== 'monitors/auto') assert.match(content, /新着サンプル/);
            if (kind !== 'monitors/price') assert.match(content, /価格サンプル/);
            if (kind !== 'x-monitors') assert.match(content, /Xサンプル/);
            assert(f.container.querySelector('[role="alert"], [role="status"]'));
            assert.doesNotMatch(content, /登録した通知は0件/);
        } finally { await f.close(); }
    }
});

test('an unrelated slow or failed source does not hide the X empty result but reappears in all', async () => {
    let failPrice;
    const f = await fixture({ initial: { auto: [], price: [], x: [] }, response: ({ path, method }) => {
        if (path === 'monitors/price' && method === 'GET') return new Promise((_resolve, reject) => { failPrice = () => reject(Object.assign(new Error('fixture price unavailable'), { status: 503 })); });
    } });
    try {
        assert.equal(typeof failPrice, 'function');
        await f.fill(f.container.querySelector('select[aria-label="通知の種類"]'), 'x'); await f.settle();
        assert.match(f.container.textContent, /検索結果は0件です/); assert(!f.container.querySelector('[role="alert"]'));
        await f.act(async () => failPrice()); await f.settle();
        assert.match(f.container.textContent, /検索結果は0件です/); assert(!f.container.querySelector('[role="alert"]'));
        await f.fill(f.container.querySelector('select[aria-label="通知の種類"]'), 'all'); await f.settle();
        assert.match(f.container.querySelector('[role="alert"]').textContent, /価格通知/);
    } finally { await f.close(); }
});

test('normal cursors advance independently and X is not fetched again while loading normal pages', async () => {
    const initial = { auto: ['1', '2', '3'].map(id => normalRow('auto', id, { name: `新着${id}` })), price: ['1', '2', '3'].map(id => normalRow('price', id, { name: `価格${id}` })), x: [xRow()] };
    const f = await fixture({ initial });
    try {
        assert(!list(f).textContent.includes('新着3')); assert(!list(f).textContent.includes('価格3'));
        const xReads = f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length;
        await f.click('新着通知をさらに表示'); await f.settle(); assert.match(list(f).textContent, /新着3/); assert.doesNotMatch(list(f).textContent, /価格3/);
        await f.click('価格通知をさらに表示'); await f.settle(); assert.match(list(f).textContent, /価格3/);
        assert(f.calls.some(call => call.path === 'monitors/auto' && call.afterId === '2'));
        assert(f.calls.some(call => call.path === 'monitors/price' && call.afterId === '2'));
        assert.equal(f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length, xReads);
    } finally { await f.close(); }
});

test('a repeated normal cursor stops paging and keeps the other sources visible', async () => {
    const initial = { auto: ['1', '2', '3'].map(id => normalRow('auto', id, { name: `新着${id}` })), price: [normalRow('price')], x: [xRow()] };
    const f = await fixture({ initial, response: ({ path, url }) => {
        if (path === 'monitors/auto' && url.searchParams.get('afterId') === '2')
            return { items: [normalRow('auto', '3', { name: '新着3' })], nextCursor: '2' };
    } });
    try {
        await f.click('新着通知をさらに表示'); await f.settle();
        assert.match(list(f).textContent, /価格サンプル/); assert.match(list(f).textContent, /Xサンプル/);
        assert(f.container.querySelector('[role="alert"]'), 'the invalid page is reported');
        await f.act(async () => new Promise(resolve => setTimeout(resolve, 80)));
        assert.equal(f.calls.filter(call => call.path === 'monitors/auto' && call.afterId === '2').length, 1, 'no repeated cursor loop');
    } finally { await f.close(); }
});

test('one search covers the X handle and both normal sources without refetching X on every keystroke', async () => {
    const f = await fixture();
    try {
        const search = f.field('通知を検索'); assert(search);
        const before = f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length;
        await f.fill(search, 'example_x'); await settleSearch(f);
        assert.match(list(f).textContent, /Xサンプル/); assert.doesNotMatch(list(f).textContent, /新着サンプル|価格サンプル/);
        await f.fill(search, 'github'); await settleSearch(f);
        assert.match(list(f).textContent, /新着サンプル/); assert.doesNotMatch(list(f).textContent, /価格サンプル|Xサンプル/);
        await f.fill(search, 'steam'); await settleSearch(f);
        assert.match(list(f).textContent, /価格サンプル/); assert.doesNotMatch(list(f).textContent, /新着サンプル|Xサンプル/);
        assert.equal(f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length, before);
    } finally { await f.close(); }
});

test('status filters cover paused and attention states across X and other services', async () => {
    const initial = { auto: [normalRow('auto', '1', { name: '停止した新着', enabled: false }), normalRow('auto', '2', { name: '取得を確認', errorCode: 'FETCH_FAILED' })],
        price: [normalRow('price')], x: [xRow({ name: '停止したX', enabled: false })] };
    const f = await fixture({ initial });
    try {
        const state = f.field('状態'); assert(state);
        await f.fill(state, 'paused'); await settleSearch(f);
        assert.match(list(f).textContent, /停止した新着/); assert.match(list(f).textContent, /停止したX/);
        assert.doesNotMatch(list(f).textContent, /取得を確認|価格サンプル/);
        await f.fill(state, 'attention'); await settleSearch(f);
        assert.match(list(f).textContent, /取得を確認/); assert.doesNotMatch(list(f).textContent, /停止した新着|停止したX|価格サンプル/);
    } finally { await f.close(); }
});

test('a late result for a retired search cannot replace the current combined list', async () => {
    let releaseOld;
    const initial = { auto: [normalRow('auto', '1', { name: 'older' }), normalRow('auto', '2', { name: 'newer' })], price: [], x: [] };
    const f = await fixture({ initial, response: ({ path, method, url }) => {
        if (path === 'monitors/auto' && method === 'GET' && url.searchParams.get('query') === 'older')
            return new Promise(resolve => { releaseOld = () => resolve({ items: [normalRow('auto', '1', { name: 'older' })], nextCursor: null }); });
    } });
    try {
        const search = f.field('通知を検索'); await f.fill(search, 'older'); await settleSearch(f); assert.equal(typeof releaseOld, 'function');
        await f.fill(search, 'newer'); await settleSearch(f); assert.match(list(f).textContent, /newer/);
        await f.act(async () => releaseOld()); await f.settle();
        assert.match(list(f).textContent, /newer/); assert.doesNotMatch(list(f).textContent, /older/);
    } finally { await f.close(); }
});

test('a delayed stop refreshes the latest search instead of restoring old results', async () => {
    let finishStop;
    const initial = { auto: [normalRow('auto', '1', { name: 'old_result' }), normalRow('auto', '2', { name: 'current_match' })], price: [], x: [] };
    const f = await fixture({ initial, response: ({ path, method, body, f: state }) => {
        if (path === 'monitors/auto/1' && method === 'PATCH') return new Promise(resolve => { finishStop = () => {
            assert.equal(body.expectedRevision, 1); Object.assign(state.rows.auto[0], { enabled: false, revision: 2 }); resolve({ id: '1', revision: 2 });
        }; });
    } });
    try {
        await buttonWithin(f, article(f, 'old_result'), '停止'); assert.equal(typeof finishStop, 'function');
        await f.fill(f.field('通知を検索'), 'current_match'); await settleSearch(f);
        assert.match(list(f).textContent, /current_match/); assert.doesNotMatch(list(f).textContent, /old_result/);
        await f.act(async () => finishStop()); await f.settle();
        assert.match(list(f).textContent, /current_match/); assert.doesNotMatch(list(f).textContent, /old_result/);
        assert.equal(f.calls.filter(call => call.path === 'monitors/auto' && call.method === 'GET').at(-1).query, 'current_match');
    } finally { await f.close(); }
});

test('a delayed deletion cannot restore results from a previous search', async () => {
    let finishDelete;
    const initial = { auto: [normalRow('auto', '1', { name: 'old_result' }), normalRow('auto', '2', { name: 'current_match' })], price: [], x: [] };
    const f = await fixture({ initial, response: ({ path, method, f: state }) => {
        if (path === 'monitors/auto/1' && method === 'DELETE') return new Promise(resolve => { finishDelete = () => {
            state.rows.auto = state.rows.auto.filter(item => item.id !== '1'); resolve({ deleted: true });
        }; });
    } });
    try {
        await buttonWithin(f, article(f, 'old_result'), '削除'); assert.equal(typeof finishDelete, 'function');
        await f.fill(f.field('通知を検索'), 'current_match'); await settleSearch(f);
        assert.match(list(f).textContent, /current_match/); assert.doesNotMatch(list(f).textContent, /old_result/);
        await f.act(async () => finishDelete()); await f.settle();
        assert.match(list(f).textContent, /current_match/); assert.doesNotMatch(list(f).textContent, /old_result/);
        assert.equal(f.calls.filter(call => call.path === 'monitors/auto' && call.method === 'GET').at(-1).query, 'current_match');
    } finally { await f.close(); }
});

test('a delayed stop does not replace a newer status filter with the previous state', async () => {
    let finishStop;
    const initial = { auto: [normalRow('auto', '1', { name: 'active_target' }), normalRow('auto', '2', { name: 'paused_target', enabled: false })], price: [], x: [] };
    const f = await fixture({ initial, response: ({ path, method, f: state }) => {
        if (path === 'monitors/auto/1' && method === 'PATCH') return new Promise(resolve => { finishStop = () => {
            Object.assign(state.rows.auto[0], { enabled: false, revision: 2 }); resolve({ id: '1', revision: 2 });
        }; });
    } });
    try {
        await buttonWithin(f, article(f, 'active_target'), '停止'); assert.equal(typeof finishStop, 'function');
        await f.fill(f.field('状態'), 'paused'); await settleSearch(f);
        assert.match(list(f).textContent, /paused_target/); assert.doesNotMatch(list(f).textContent, /active_target/);
        await f.act(async () => finishStop()); await f.settle();
        assert.match(list(f).textContent, /paused_target/);
        assert.equal(f.calls.filter(call => call.path === 'monitors/auto' && call.method === 'GET').at(-1).state, 'paused');
    } finally { await f.close(); }
});

test('a delayed write from a previous scope cannot change the new scope with the same target ID', async () => {
    let finishStop, currentScope = 'private';
    const initial = { auto: [normalRow('auto', '1', { name: '自分の通知' })], price: [], x: [] };
    const f = await fixture({ initial, response: ({ path, method, url }) => {
        if (path === 'monitors/auto' && method === 'GET' && currentScope === 'guild')
            return { items: [normalRow('auto', '1', { name: 'サーバーの通知', scope: 'guild', enabled: true })], nextCursor: null };
        if (path === 'monitors/auto/1' && method === 'PATCH') return new Promise(resolve => { finishStop = () => resolve({ id: '1', revision: 2 }); });
    } });
    try {
        await buttonWithin(f, article(f, '自分の通知'), '停止'); assert.equal(typeof finishStop, 'function');
        currentScope = 'guild';
        await f.render(f.React.createElement(f.exports.MonitorManager, { api: f.api, scope: 'guild', canEdit: true, guildId: '111111111111111111',
            destinations: [], rules: [], refresh: async () => {} }));
        await f.act(async () => new Promise(resolve => setTimeout(resolve, 50))); await f.settle();
        assert.match(list(f).textContent, /サーバーの通知/); assert.doesNotMatch(list(f).textContent, /自分の通知/);
        await f.act(async () => finishStop()); await f.settle();
        const card = article(f, 'サーバーの通知'); assert([...card.querySelectorAll('button')].some(node => node.textContent.trim() === '停止'));
        assert(![...card.querySelectorAll('button')].some(node => node.textContent.trim() === '再開'));
        assert.equal(f.calls.filter(call => call.path === 'monitors/auto/1' && call.method === 'PATCH').length, 1);
    } finally { await f.close(); }
});

test('explicit refresh retries a failed X list exactly once despite repeated clicks', async () => {
    let initial = true, slow = false, release;
    const f = await fixture({ response: ({ path, method, f: state }) => {
        if (path === 'x-monitors' && method === 'GET' && initial) { initial = false; throw Object.assign(new Error('fixture X failure'), { status: 503 }); }
        if (path === 'x-monitors' && method === 'GET' && slow) return new Promise(resolve => { release = () => resolve({ items: state.rows.x.map(row => ({ ...row })), quota }); });
    } });
    try {
        assert.doesNotMatch(list(f).textContent, /Xサンプル/);
        assert.match(list(f).textContent, /新着サンプル/);
        const before = f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length;
        slow = true;
        const refresh = [...f.container.querySelectorAll('button')].find(node => node.textContent.trim() === '更新'); assert(refresh);
        await f.act(async () => { refresh.click(); refresh.click(); }); await f.settle();
        assert.equal(f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length, before + 1);
        assert.equal(typeof release, 'function'); await f.act(async () => release()); await f.settle();
        assert.match(list(f).textContent, /Xサンプル/);
    } finally { await f.close(); }
});

test('X-only retry restores an X list while preserving the other sources', async () => {
    let initial = true;
    const f = await fixture({ response: ({ path, method }) => {
        if (path === 'x-monitors' && method === 'GET' && initial) { initial = false; throw Object.assign(new Error('fixture X failure'), { status: 503 }); }
    } });
    try {
        assert.match(list(f).textContent, /新着サンプル/); assert.match(list(f).textContent, /価格サンプル/);
        assert.doesNotMatch(list(f).textContent, /Xサンプル/);
        const before = f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length;
        await f.click('X通知を再読み込み'); await f.settle();
        assert.match(list(f).textContent, /Xサンプル/);
        assert.equal(f.calls.filter(call => call.path === 'x-monitors' && call.method === 'GET').length, before + 1);
        assert.match(list(f).textContent, /新着サンプル/); assert.match(list(f).textContent, /価格サンプル/);
    } finally { await f.close(); }
});

test('failed X setup shows the available refresh action and recovers independently of a successful list', async () => {
    let failSetup = true;
    const f = await fixture({ response: ({ path, method }) => {
        if (path === 'x-setup' && method === 'GET' && failSetup) { failSetup = false; throw Object.assign(new Error('fixture setup unavailable'), { status: 503 }); }
    } });
    try {
        assert.match(list(f).textContent, /Xサンプル/);
        const alerts = [...f.container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' ');
        assert.match(alerts, /受信情報を取得できませんでした。［更新］で再確認してください。/);
        assert.doesNotMatch(alerts, /X一覧・利用枠を更新/);
        await f.click('更新'); await f.settle();
        assert(![...f.container.querySelectorAll('[role="alert"]')].some(node => node.textContent.includes('受信情報を取得できませんでした')));
        assert.match(list(f).textContent, /Xサンプル/);
        assert.equal(f.calls.filter(call => call.path === 'x-setup' && call.method === 'GET').length, 2);
    } finally { await f.close(); }
});

test('refresh while the initial X request is pending queues one fresh read', async () => {
    let releaseInitial, xReads = 0;
    const f = await fixture({ response: ({ path, method, f: state }) => {
        if (path === 'x-monitors' && method === 'GET' && ++xReads === 1)
            return new Promise(resolve => { releaseInitial = () => resolve({ items: state.rows.x.map(row => ({ ...row })), quota }); });
    } });
    try {
        assert.equal(typeof releaseInitial, 'function'); assert.equal(xReads, 1);
        await f.click('更新'); await f.settle(); assert.equal(xReads, 1, 'do not overlap reconciliation with the initial read');
        await f.act(async () => releaseInitial());
        for (let attempt = 0; attempt < 20 && xReads < 2; attempt++) await f.act(async () => new Promise(resolve => setTimeout(resolve, 20)));
        assert.equal(xReads, 2, 'the requested refresh must run after the first request');
        await f.settle(); assert.match(list(f).textContent, /Xサンプル/);
    } finally { await f.close(); }
});

test('the shared add action opens the same chooser for normal and X notifications', async () => {
    for (const [kind, expected] of [['auto', '対象のURL・ID'], ['price', '商品URL'], ['x', 'Xアカウント名']]) {
        const f = await fixture();
        try { await openNotification(f, kind); assert(f.field(expected), `missing ${expected} after choosing ${kind}`); }
        finally { await f.close(); }
    }
});

test('guild scope does not request or offer personal X and a viewer cannot add', async () => {
    const f = await fixture({ scope: 'guild', guildId: '111111111111111111', canEdit: false, initial: { x: [xRow()] } });
    try {
        assert.equal(f.calls.filter(call => call.path === 'x-monitors' || call.path === 'x-setup').length, 0);
        assert.doesNotMatch(list(f).textContent, /Xサンプル/);
        const button = [...f.container.querySelectorAll('button')].find(item => item.textContent.trim() === '通知を追加'); assert(button && button.disabled);
    } finally { await f.close(); }
});
