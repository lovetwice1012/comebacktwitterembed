'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const row = (kind, id = 'same-id') => ({ id, kind, name: kind === 'auto' ? '新着の通知' : '価格の通知', scope: 'private', providerId: kind === 'auto' ? 'github' : 'steam', source: 'https://example.test/source', enabled: true, destinationId: 'dm', lastCheckedAtMs: 100 });
const profile = (changes = {}) => ({
    plan: { id: 'free', tier: 'free', name: '無料プラン', priority: 0, slotLimit: 5, dayLimit: 24, minuteLimit: 5, ...changes },
    slots: { used: 4, max: changes.slotLimit || 5, available: (changes.slotLimit || 5) - 4 },
    usage: { entries: [
        { slotId: 'auto:same-id', targetKind: 'auto', targetId: 'same-id', todayUsed: 3, todayReserved: 2, dayLimit: changes.dayLimit || 24, minuteLimit: changes.minuteLimit || 5, resetAtMs: 1791903600000 },
        { slotId: 'price:same-id', targetKind: 'price', targetId: 'same-id', todayUsed: 8, todayReserved: 0, dayLimit: changes.dayLimit || 24, minuteLimit: changes.minuteLimit || 5, resetAtMs: 1791903600000 },
    ] },
});
async function fixture(entitlements, { createError } = {}) {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager"; export { automationResponseError } from "./components/automation/automation-feedback";');
    const api = async (route, method, body) => {
        if (route === 'entitlements') return entitlements();
        if (route === 'providers') return { autoRegistration: { eligible: true }, auto: [{ id: 'github' }], price: [{ id: 'steam' }] };
        if (route.endsWith('/preview')) return { providerId: body.providerId, source: body.source, intervalMinutes: 360 };
        if (method === 'POST' && route === 'monitors/auto' && createError) throw f.exports.automationResponseError(createError, new Response('', { status: 422 }));
        const kind = route.startsWith('monitors/price') ? 'price' : 'auto';
        return { items: [row(kind)], nextCursor: null };
    };
    await f.render(f.React.createElement(f.exports.MonitorManager, { api, scope: 'private', canEdit: true, destinations: [{ id: 'dm', name: '自分のDM', kind: 'dm', scope: 'private', enabled: true }], rules: [], refresh: async () => {} }));
    await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    return f;
}

test('free notification slots show actual sent messages separately from pending reservations and pair usage by notification kind', async () => {
    const f = await fixture(async () => profile());
    try {
        assert.match(f.container.textContent, /無料プラン.*使用枠 4 \/ 5.*空き 1枠/);
        assert.match(f.container.textContent, /1枠あたり1日24通・1分5通/);
        assert.match(f.container.textContent, /メッセージ1件＝1通/); assert.match(f.container.textContent, /日本時間の0時/);
        assert.match(f.container.querySelector('.monitor-card').textContent, /今日の送信 3通.*1日24通・1分5通.*予約・確認待ち 2通/);
        assert(!f.container.textContent.includes('今日の送信 8通'));
        await f.click('価格通知'); await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        assert.match(f.container.querySelector('.monitor-card').textContent, /今日の送信 8通.*1日24通・1分5通/);
        assert(!f.container.textContent.includes('今日の送信 3通')); assert(!f.container.textContent.includes('予約・確認待ち'));
    } finally { await f.close(); }
});

test('supporter priority and paid plan limits display server-provided values without inventing higher defaults or prices', async () => {
    let current = profile({ id: 'supporter', tier: 'supporter', name: 'サポータープラン', priority: 1 });
    const f = await fixture(async () => current);
    try {
        assert.match(f.container.textContent, /サポータープラン.*使用枠 4 \/ 5/);
        assert.match(f.container.textContent, /1日24通・1分5通まで。優先処理/);
        current = profile({ id: 'configured-paid', tier: 'paid', name: '設定済みプラン', slotLimit: 9, dayLimit: 72, minuteLimit: 7, priority: 2 });
        await f.click('更新'); await f.settle();
        assert.match(f.container.textContent, /設定済みプラン.*使用枠 4 \/ 9.*空き 5枠/);
        assert.match(f.container.textContent, /1日72通・1分7通/); assert.match(f.container.querySelector('.monitor-card').textContent, /今日の送信 3通.*1日72通・1分7通/);
        assert(!f.container.textContent.includes('円')); assert(!f.container.textContent.includes('60通'));
    } finally { await f.close(); }
});

test('unavailable entitlement metadata keeps notifications and stop/delete controls available and refresh can recover it', async () => {
    let failed = true;
    const f = await fixture(async () => { if (failed) throw new Error('PRIVATE_ENTITLEMENT_DATABASE_ERROR'); return profile(); });
    try {
        assert.match(f.container.textContent, /利用枠を確認できません/); assert(!f.container.textContent.includes('PRIVATE_ENTITLEMENT_DATABASE_ERROR'));
        assert.match(f.container.textContent, /新着の通知/);
        for (const label of ['設定を変更', '停止', '削除']) {
            const button = [...f.container.querySelectorAll('button')].find(node => node.textContent.trim() === label);
            assert(button); assert.equal(button.disabled, false, label);
        }
        failed = false; await f.click('更新'); await f.settle();
        assert.match(f.container.textContent, /使用枠 4 \/ 5/); assert(!f.container.textContent.includes('利用枠を確認できません'));
    } finally { await f.close(); }
});

test('an old entitlement response cannot overwrite newer plan and slot usage loaded by refresh', async () => {
    let finishOld, requests = 0;
    const f = await fixture(async () => {
        if (++requests === 1) return new Promise(resolve => { finishOld = resolve; });
        return profile({ id: 'newer', name: '最新のプラン', slotLimit: 8 });
    });
    try {
        await f.click('更新'); await f.settle(); assert.match(f.container.textContent, /最新のプラン.*使用枠 4 \/ 8/);
        await f.act(async () => finishOld(profile()));
        assert.match(f.container.textContent, /最新のプラン.*使用枠 4 \/ 8/); assert(!f.container.textContent.includes('無料プラン'));
    } finally { await f.close(); }
});

test('a service slot validation error keeps the registration form and its source/name so the user can correct capacity and retry', async () => {
    const f = await fixture(async () => profile(), { createError: { code: 'AUTOMATION_SLOT_LIMIT', maxSlots: 5, availableSlots: 0, planName: '無料', error: 'PRIVATE_CREATION_INTERNAL' } });
    try {
        await f.click('通知を追加'); await f.fill(f.field('対象のURL・ID'), 'https://github.com/preserved'); await f.fill(f.field('名前（省略可）'), '残す通知入力');
        await f.submit(); await f.submit();
        const form = f.container.querySelector('form'); assert.match(f.container.textContent, /残す通知入力/);
        await f.submit();
        assert.match(f.container.textContent, /残り0枠／最大5枠/); assert(!f.container.textContent.includes('PRIVATE_CREATION_INTERNAL'));
        assert.equal(f.container.querySelector('form'), form);
        await f.click('戻る'); await f.click('戻る');
        assert.equal(f.field('対象のURL・ID').value, 'https://github.com/preserved'); assert.equal(f.field('名前（省略可）').value, '残す通知入力');
    } finally { await f.close(); }
});

test('existing notifications outside a downgraded plan show their capacity problem while stop and deletion remain available', async () => {
    const limits = profile(); limits.slots = { used: 7, max: 5, available: 0 }; limits.usage.entries[0].allowed = false;
    const f = await fixture(async () => limits);
    try {
        assert.match(f.container.textContent, /使用枠 7 \/ 5.*空き 0枠/); assert.match(f.container.textContent, /現在の登録上限を超えています.*利用状況とプランを確認/);
        for (const label of ['停止', '削除']) assert.equal([...f.container.querySelectorAll('button')].find(node => node.textContent.trim() === label).disabled, false);
    } finally { await f.close(); }
});

test('a slot rejection refreshes stale capacity metadata without closing the modal or losing its error and registration draft', async () => {
    let latest = profile(); latest.slots = { used: 0, max: 5, available: 5 };
    const f = await fixture(async () => latest, { createError: { code: 'AUTOMATION_SLOT_LIMIT', maxSlots: 5, availableSlots: 0, planName: '無料', error: 'PRIVATE_SLOT_REJECTION' } });
    try {
        assert.match(f.container.textContent, /使用枠 0 \/ 5.*空き 5枠/);
        await f.click('通知を追加'); await f.fill(f.field('対象のURL・ID'), 'https://github.com/keep-after-rejection'); await f.fill(f.field('名前（省略可）'), '6枠目の入力');
        await f.submit(); await f.submit();
        const form = f.container.querySelector('form'), dialog = form.closest('dialog');
        latest = profile(); latest.slots = { used: 5, max: 5, available: 0 };
        await f.submit(); await f.settle();
        assert.match(f.container.textContent, /使用枠 5 \/ 5.*空き 0枠/);
        assert.match(dialog.textContent, /通知の登録枠が上限に達しています.*残り0枠／最大5枠/);
        assert.equal(f.container.querySelector('form'), form); assert.equal(dialog.open, true);
        assert(!f.container.textContent.includes('PRIVATE_SLOT_REJECTION'));
        await f.click('戻る'); await f.click('戻る');
        assert.equal(f.field('対象のURL・ID').value, 'https://github.com/keep-after-rejection'); assert.equal(f.field('名前（省略可）').value, '6枠目の入力');
    } finally { await f.close(); }
});
