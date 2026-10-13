'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const row = changes => ({ id: 'monitor-1', revision: 1, name: '本人の新着通知', scope: 'private', kind: 'auto', providerId: 'youtube', source: 'https://example.test/source', enabled: true, slotCost: 1, effectiveSlotCost: 1, baseIntervalMinutes: 180, intervalMinutes: 180, cadenceUpdatedAtMs: null, cadenceLimited: false, canAllocateCadence: true, ...changes });
const pool = changes => ({ used: 4, max: 8, available: 4, ...changes });
async function fixture({ current = row(), slots = pool(), respond, parent = false } = {}) {
    const f = await reactFixture('export { MonitorCadenceEditor } from "./components/automation/monitor-cadence-editor"; export { MonitorManager } from "./components/automation/monitor-manager";');
    f.current = current; f.pool = slots; f.calls = []; const cached = new Map();
    f.api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body }); const override = respond && await respond(route, method, body, f); if (override !== undefined) return override;
        if (route === 'providers') return { autoRegistration: { eligible: true }, auto: [{ id: 'youtube' }], price: [{ id: 'steam' }] };
        if (route === 'entitlements') { if (!f.pool) throw new Error('PRIVATE_POOL'); return { plan: { id: 'free', name: '無料', dayLimit: 24, minuteLimit: 5, priority: 0 }, slots: f.pool, usage: { entries: [] } }; }
        if (route.startsWith('monitors/') && method === 'GET') return { items: [f.current], nextCursor: null };
        if (method === 'POST') { f.current = { ...f.current, slotCost: body.slotCost, effectiveSlotCost: body.slotCost, cadenceUpdatedAtMs: 100, intervalMinutes: Math.max(5, f.current.baseIntervalMinutes / body.slotCost) }; return { slotCost: body.slotCost, intervalMs: f.current.intervalMinutes * 60000 }; }
        throw new Error('Unexpected cadence UI request');
    };
    function Wrapper() {
        const [view, setView] = f.React.useState(f.current), [profile, setProfile] = f.React.useState(f.pool);
        f.setRow = next => { f.current = next; setView(next); }; f.setPool = next => { f.pool = next; setProfile(next); };
        return f.React.createElement(f.exports.MonitorCadenceEditor, { row: view, pool: profile, api: f.api, draftValue: cached.get(view.id), onDraft: value => cached.set(view.id, value), onReload: async () => { const result = await f.api('monitors/auto'); setView(result.items[0]); setProfile(f.pool); return result.items[0]; } });
    }
    if (parent) await f.render(f.React.createElement(f.exports.MonitorManager, { api: f.api, scope: 'private', canEdit: true, destinations: [], rules: [], refresh: async () => {} }));
    else await f.render(f.React.createElement(Wrapper));
    await f.act(async () => new Promise(resolve => setTimeout(resolve, parent ? 20 : 1)));
    f.open = () => f.click('確認間隔・使用枠');
    f.review = async value => { await f.fill(f.field('この通知で使う枠数'), value); await f.submit(); };
    return f;
}
const writes = f => f.calls.filter(item => item.method !== 'GET');

test('cadence editor waits for an explicit allocation and previews shared pool use before posting typed CAS values', async () => {
    const f = await fixture();
    try { assert.equal(f.calls.length, 0); assert.match(f.container.textContent, /使用枠 1枠/); await f.open(); assert.equal(f.field('この通知で使う枠数').value, '1'); await f.review('3'); assert.equal(writes(f).length, 0); assert.match(f.container.textContent, /目安: 約60分/); assert.match(f.container.querySelector('[aria-label="確認間隔・枠配分の変更確認"]').textContent, /1枠3枠/); await f.click('この枠配分で保存'); assert.deepEqual(writes(f)[0], { route: 'monitors/auto/monitor-1', method: 'POST', body: { action: 'cadence', slotCost: 3, expectedRevision: 1, expectedUpdatedAtMs: null } }); }
    finally { await f.close(); }
});
test('an exhausted weighted pool blocks increases and invalid or blank numeric drafts stay intact', async () => {
    const f = await fixture({ slots: pool({ used: 8, available: 0 }) });
    try { await f.open(); for (const value of ['', '0', '1.5', '10001', '2']) { await f.review(value); assert.equal(f.field('この通知で使う枠数').value, value); assert.equal(f.container.querySelector('[aria-label="確認間隔・枠配分の変更確認"]'), null); } assert.match(f.container.textContent, /空き枠が足りません/); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
test('restoring one slot releases extra allocation even without entitlement metadata and requires explicit confirmation', async () => {
    const f = await fixture({ current: row({ slotCost: 5, effectiveSlotCost: 1, cadenceLimited: true }), slots: null });
    try { await f.open(); assert.match(f.container.textContent, /短縮設定は現在適用されていません/); await f.click('1枠に戻す'); assert.equal(writes(f).length, 0); await f.submit(); await f.click('この枠配分で保存'); assert.equal(writes(f)[0].body.slotCost, 1); assert.match(f.container.textContent, /枠配分を保存しました/); }
    finally { await f.close(); }
});
test('a downgraded pool accounts for the full selected allocation when checking how many frames still fit', async () => {
    const f = await fixture({ current: row({ slotCost: 6, effectiveSlotCost: 1, cadenceLimited: true }), slots: pool({ used: 8, max: 5, available: 0 }) });
    try { await f.open(); await f.review('4'); assert.equal(f.container.querySelector('[aria-label="確認間隔・枠配分の変更確認"]'), null); await f.review('3'); assert(f.container.querySelector('[aria-label="確認間隔・枠配分の変更確認"]')); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
test('request estimates respect the five-minute floor and confirmed service interval is shown instead of promising the estimate', async () => {
    const f = await fixture({ current: row({ baseIntervalMinutes: 30 }), slots: pool({ max: 100, available: 96 }), respond: (route, method, body, current) => { if (method === 'POST') { current.current = row({ slotCost: body.slotCost, intervalMinutes: 15, cadenceUpdatedAtMs: 100 }); return { slotCost: body.slotCost, intervalMs: 15 * 60000 }; } } });
    try { await f.open(); await f.review('10'); assert.match(f.container.textContent, /目安: 約5分/); await f.click('この枠配分で保存'); assert.match(f.container.textContent, /サービスの設定間隔は15分/); assert.match(f.container.textContent, /実際の確認は取得先と送信上限の範囲/); }
    finally { await f.close(); }
});
test('rapid save clicks post once, and a late result after unmount cannot start another request', async () => {
    let finish;
    const f = await fixture({ respond: (route, method) => method === 'POST' ? new Promise(resolve => { finish = () => resolve({ slotCost: 3, intervalMs: 60 * 60000 }); }) : undefined });
    await f.open(); await f.review('3'); const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === 'この枠配分で保存'); await f.act(async () => { button.click(); button.click(); }); assert.equal(writes(f).length, 1); await f.render(null); await f.act(async () => finish()); assert.equal(writes(f).length, 1); assert.equal(f.calls.filter(item => item.method === 'GET').length, 0); await f.close();
});
test('cadence conflict retains entered count and reload requires reviewing the new notification and allocation versions', async () => {
    let conflict = true;
    const f = await fixture({ respond: (route, method, body, current) => { if (method === 'POST' && conflict) { conflict = false; current.current = row({ revision: 2, slotCost: 2, cadenceUpdatedAtMs: 200, intervalMinutes: 90 }); throw Object.assign(new Error('PRIVATE_CONFLICT'), { status: 409 }); } } });
    try { await f.open(); await f.review('3'); await f.click('この枠配分で保存'); assert.equal(f.field('この通知で使う枠数').value, '3'); assert(!f.container.textContent.includes('PRIVATE_CONFLICT')); await f.click('通知・利用枠を再取得'); assert.equal(f.field('この通知で使う枠数').value, '3'); assert.equal(f.container.querySelector('[aria-label="確認間隔・枠配分の変更確認"]'), null); await f.submit(); assert.match(f.container.querySelector('[aria-label="確認間隔・枠配分の変更確認"]').textContent, /2枠3枠/); await f.click('この枠配分で保存'); assert.equal(writes(f).at(-1).body.expectedRevision, 2); assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 200); }
    finally { await f.close(); }
});
test('a refreshed baseline makes a stale reviewed allocation unsavable until review is repeated', async () => {
    const f = await fixture();
    try { await f.open(); await f.review('3'); await f.act(async () => f.setRow(row({ revision: 2, cadenceUpdatedAtMs: 200 }))); assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === 'この枠配分で保存').disabled, true); assert.match(f.container.textContent, /現在の設定が更新されました/); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
test('closing or refreshing the parent notification list preserves a draft without automatically reallocating frames', async () => {
    const f = await fixture({ parent: true });
    try { await f.open(); await f.fill(f.field('この通知で使う枠数'), '3'); await f.click('枠配分を閉じる'); assert.match(f.container.textContent, /枠配分の入力を保持/); await f.open(); assert.equal(f.field('この通知で使う枠数').value, '3'); await f.click('更新'); await f.settle(); await f.open(); assert.equal(f.field('この通知で使う枠数').value, '3'); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
test('cadence save through the parent refreshes both notification rows and the shared weighted allocation profile', async () => {
    const f = await fixture({ parent: true });
    try { const before = f.calls.filter(item => item.route === 'entitlements').length; await f.open(); await f.review('3'); await f.click('この枠配分で保存'); assert(f.calls.filter(item => item.route === 'entitlements').length > before); assert.match(f.container.textContent, /使用枠 3枠/); assert.match(f.container.textContent, /確認間隔に配分した追加枠も含みます/); }
    finally { await f.close(); }
});
test('foreign-owner or legacy rows expose no allocation entry point and unknown stored count is never silently treated as one', async () => {
    for (const flag of [false, undefined]) { const f = await fixture({ current: row({ canAllocateCadence: flag }), parent: true }); try { assert(![...f.container.querySelectorAll('button')].some(item => item.textContent === '確認間隔・使用枠')); assert.equal(writes(f).length, 0); } finally { await f.close(); } }
    const f = await fixture({ current: row({ slotCost: 'unrecognized' }) });
    try { await f.open(); assert.match(f.container.textContent, /使用枠 確認中/); await f.click('1枠に戻す'); await f.submit(); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
