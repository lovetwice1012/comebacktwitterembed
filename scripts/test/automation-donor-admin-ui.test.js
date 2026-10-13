'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const FIRST = '111111111111111111', SECOND = '222222222222222222', THIRD = '333333333333333333';
const grant = changes => ({ active: false, threshold: null, validityDays: null, netAmount: 0, validUntilAtMs: null, unitAmount: null, slotsPerUnit: null, purchaseUnits: 0, extraSlots: 0, paymentCount: 0, unitsValidUntilAtMs: null, ...changes });
const donor = (userId = FIRST, changes = {}) => ({ userId, exists: true,
    manual: { isDonor: true, extraSlots: 2, paymentCount: 3, purchaseUnits: 4, displayName: userId === FIRST ? '最初の支援者' : '次の支援者', note: '以前の支援記録', updatedAtMs: 100 },
    version: { updatedAtMs: 100, legacyIsDonor: 1, legacyExtraSlots: 2 },
    square: { configured: true, environment: 'sandbox', active: false, paymentCount: 2, totalsByCurrency: [{ currency: 'JPY', amount: 3000, refundedAmount: 500, netAmount: 2500, paymentCount: 2 }], grant: grant({ purchaseUnits: 1, extraSlots: 2 }), history: [], historyNextCursor: null },
    entitlement: { label: '支援者', tier: 'supporter', planId: 'supporter', slotLimit: 9, usedSlots: 2, remainingSlots: 7, minuteLimit: 5, dayLimit: 24, priority: 1, overLimit: false },
    totals: { paymentCount: 5 }, ...changes });
const list = (items = [donor(), donor(SECOND)], changes = {}) => ({ items, total: items.length, pageSize: 20, nextCursor: null, ...changes });
const writes = f => f.calls.filter(item => item.method !== 'GET');
async function fixture({ respond, items } = {}) {
    const f = await reactFixture('export { DonorManager, donorAPI } from "./components/admin/donor-manager"; export { automationResponseError } from "./components/automation/automation-feedback";');
    f.calls = [];
    f.api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body });
        const result = respond && await respond(route, method, body, f); if (result !== undefined) return result;
        if (route.startsWith('donors?')) return list(items);
        if (route.includes('/audit?')) return { items: [], nextCursor: null, pageSize: 20 };
        if (route.endsWith('/history?pageSize=20')) return { items: [], nextCursor: null, pageSize: 20 };
        if (method === 'PATCH') return donor(route.split('/')[1], { manual: { ...donor().manual, ...body, updatedAtMs: 101 }, version: { updatedAtMs: 101, legacyIsDonor: Number(body.isDonor), legacyExtraSlots: body.extraSlots } });
        return donor(route.split('/')[1]);
    };
    await f.render(f.React.createElement(f.exports.DonorManager, { api: f.api })); await f.settle();
    f.choose = async userId => f.act(async () => { const button = [...f.container.querySelectorAll('[aria-label="支援者一覧"] button')].find(item => item.textContent.includes('Discord ID: ' + userId)); assert(button, 'missing listed donor'); button.click(); });
    f.editor = (userId = FIRST) => f.container.querySelector(`[aria-label="${userId}の支援者設定"]`);
    f.inClick = async (node, text) => f.act(async () => { const button = [...node.querySelectorAll('button')].find(item => item.textContent.trim() === text); assert(button, 'missing button ' + text); button.click(); });
    f.editSubmit = async (userId = FIRST) => f.act(async () => f.editor(userId).querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    f.review = async (userId = FIRST) => { await f.fill(f.field('手動の追加通知枠'), '5'); await f.fill(f.field('変更理由（必須）'), '旧決済の購入履歴を確認'); await f.editSubmit(userId); };
    return f;
}

test('donor page requires an admin session and is discoverable from new and common legacy-wrapper navigation', () => {
    const root = path.resolve(__dirname, '../..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const page = read('dashboard/app/admin/donors/page.tsx');
    assert.match(page, /await requireDashboardSession\(\)/); assert.match(page, /if \(!session\.user\.isAdmin\) notFound\(\)/); assert.match(page, /<DonorManager/);
    assert.match(page, /href="\/admin\/notification-plans"/); assert.match(page, /href="\/admin"/);
    for (const file of ['dashboard/components/admin/workspace-shell.tsx', 'dashboard/app/admin/notification-plans/page.tsx', 'dashboard/app/admin/page.tsx']) assert.match(read(file), /href="\/admin\/donors"/);
    const wrapper = read('dashboard/app/admin/page.tsx'); assert(wrapper.indexOf('if (!session.user.isAdmin)') < wrapper.indexOf('usesNewDashboardUI(session)'));
    assert.match(wrapper, /usesNewDashboardUI\(session\)[\s\S]*支援者管理[\s\S]*<LegacyPage/);
});

test('list search and keyset pagination keep cursor history, reset cursors for filters and show source-specific counts', async () => {
    const f = await fixture({ respond: route => {
        if (route.startsWith('donors?')) { const params = new URL('https://test.invalid/' + route).searchParams;
            return params.get('cursor') ? list([donor(THIRD)], { total: 3 }) : params.get('search') ? list([donor(SECOND)]) : list([donor()], { total: 3, nextCursor: 'opaque-cursor' }); }
    } });
    try {
        assert.match(f.container.textContent, /手動の支援者/); assert.match(f.container.textContent, /支援 5回（手動 3・Square 2）/); assert.equal(writes(f).length, 0);
        await f.click('次のページ'); assert.match(f.calls.at(-1).route, /cursor=opaque-cursor/); assert.match(f.container.textContent, /2ページ/); assert.match(f.container.textContent, new RegExp(THIRD));
        await f.click('前のページ'); assert(!f.calls.at(-1).route.includes('cursor=')); assert.match(f.container.textContent, /1ページ/);
        await f.fill(f.field('Discord ID・管理用表示名で検索'), '次の支援者'); await f.submit();
        const query = new URL('https://test.invalid/' + f.calls.at(-1).route).searchParams; assert.equal(query.get('search'), '次の支援者'); assert.equal(query.get('cursor'), null);
        assert.match(f.container.textContent, /「次の支援者」の検索結果/); await f.click('検索を解除'); assert.equal(f.field('Discord ID・管理用表示名で検索').value, ''); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('late search requests cannot replace newer results and failed searches retain the prior list with an exact retry', async () => {
    let release, failed = false;
    const f = await fixture({ respond: async route => {
        if (!route.startsWith('donors?')) return;
        const params = new URL('https://test.invalid/' + route).searchParams;
        if (params.get('search') === 'old') { await new Promise(resolve => { release = resolve; }); return list([donor(THIRD)]); }
        if (params.get('search') === 'new') { if (failed) { failed = false; throw new Error('PRIVATE_QUERY_FAILURE'); } return list([donor(SECOND)]); }
    } });
    try {
        await f.fill(f.field('Discord ID・管理用表示名で検索'), 'old'); await f.submit();
        await f.fill(f.field('Discord ID・管理用表示名で検索'), 'new'); await f.submit(); await f.act(async () => release());
        assert.match(f.container.textContent, new RegExp(SECOND)); assert(!f.container.textContent.includes(THIRD));
        failed = true; await f.submit(); assert.match(f.container.textContent, new RegExp(SECOND)); assert(!f.container.textContent.includes('PRIVATE_QUERY_FAILURE'));
        const failedRoute = f.calls.at(-1).route; await f.click('一覧を再取得'); assert.equal(f.calls.at(-1).route, failedRoute); assert.equal(writes(f).length, 0);
    } finally { if (release) release(); await f.close(); }
});

test('entering an unknown valid Discord ID reads defaults and creates no record until a reasoned confirmed save', async () => {
    const unknown = donor(THIRD, { exists: false, manual: { isDonor: false, extraSlots: 0, paymentCount: 0, purchaseUnits: 0, displayName: '', note: '', updatedAtMs: null }, version: { updatedAtMs: null, legacyIsDonor: 0, legacyExtraSlots: 0 } });
    const f = await fixture({ respond: (route, method) => route === 'donors/' + THIRD && method === 'GET' ? unknown : undefined });
    try {
        for (const invalid of ['0', '01', 'abc', '999999999999999999999999999999999']) { await f.fill(f.field('Discord IDから登録・編集'), invalid); await f.click('このユーザーの設定を開く'); assert.equal(f.calls.filter(item => !item.route.includes('?')).length, 0); }
        await f.fill(f.field('Discord IDから登録・編集'), THIRD); await f.click('このユーザーの設定を開く'); assert.match(f.editor(THIRD).textContent, /未登録のユーザー/); assert.equal(writes(f).length, 0);
        await f.editSubmit(THIRD); assert.equal(f.editor(THIRD).querySelector('[aria-label="支援者設定の変更確認"]'), null);
        await f.fill(f.field('変更理由（必須）'), '支援者を手動登録'); await f.editSubmit(THIRD); assert.equal(writes(f).length, 0); await f.click('この支援者設定で保存');
        assert.equal(writes(f)[0].route, 'donors/' + THIRD); assert.equal(writes(f)[0].body.expectedUpdatedAtMs, null); assert.equal(writes(f)[0].body.expectedLegacyIsDonor, 0);
    } finally { await f.close(); }
});

test('manual support counts, units and slots remain independent and the exact legacy CAS is sent only after review', async () => {
    const detail = donor(FIRST, { manual: { ...donor().manual, isDonor: false, extraSlots: -3 }, version: { updatedAtMs: 100, legacyIsDonor: 2, legacyExtraSlots: -3 } });
    const f = await fixture({ respond: (route, method) => route === 'donors/' + FIRST && method === 'GET' ? detail : undefined });
    try {
        await f.choose(FIRST); await f.fill(f.field('手動で記録した支援回数'), '8'); await f.fill(f.field('手動で記録した購入口数'), '11'); await f.fill(f.field('管理用表示名'), '確認した支援者'); await f.fill(f.field('管理メモ'), '旧記録\n確認済み'); await f.review();
        const before = f.editor().querySelector('[aria-label="支援者設定の変更確認"]'); assert.match(before.textContent, /手動の追加通知枠-3枠5枠/); assert.match(before.textContent, /手動で記録した購入口数4口11口/); assert.equal(writes(f).length, 0);
        await f.click('この支援者設定で保存'); assert.deepEqual(writes(f)[0].body, { isDonor: false, extraSlots: 5, paymentCount: 8, purchaseUnits: 11, displayName: '確認した支援者', note: '旧記録\n確認済み', reason: '旧決済の購入履歴を確認', expectedUpdatedAtMs: 100, expectedLegacyIsDonor: 2, expectedLegacyExtraSlots: -3 });
        assert.match(f.editor().textContent, /手動設定と変更理由を保存/); assert.equal(f.field('変更理由（必須）').value, '');
    } finally { await f.close(); }
});

test('changing selected users cancels confirmation and late detail results cannot overwrite a different user draft', async () => {
    let release;
    const f = await fixture({ respond: async route => { if (route === 'donors/' + SECOND) { await new Promise(resolve => { release = resolve; }); return donor(SECOND); } } });
    try {
        await f.choose(FIRST); await f.review(); assert(f.editor().querySelector('[aria-label="支援者設定の変更確認"]'));
        await f.choose(SECOND); assert.equal(f.editor(), null); await f.choose(FIRST);
        assert.equal(f.editor().querySelector('[aria-label="支援者設定の変更確認"]'), null); await f.fill(f.field('手動の追加通知枠'), '7');
        await f.act(async () => release()); assert.equal(f.field('手動の追加通知枠').value, '7'); assert.equal(f.editor(SECOND), null); assert.equal(writes(f).length, 0);
    } finally { if (release) release(); await f.close(); }
});

test('conflict retains draft and requires fresh review using both the changed profile and raw legacy versions', async () => {
    let reads = 0, failed = false;
    const f = await fixture({ respond: (route, method, body, current) => {
        if (route === 'donors/' + FIRST && method === 'GET') return donor(FIRST, ++reads > 1 ? { manual: { ...donor().manual, extraSlots: 4, updatedAtMs: 102 }, version: { updatedAtMs: 102, legacyIsDonor: 0, legacyExtraSlots: 4 } } : {});
        if (method === 'PATCH' && !failed) { failed = true; throw current.exports.automationResponseError({ code: 'DONOR_EDIT_CONFLICT', error: 'PRIVATE_CONFLICT' }, new Response('', { status: 409 })); }
    } });
    try {
        await f.choose(FIRST); await f.review(); await f.click('この支援者設定で保存'); assert.equal(f.field('手動の追加通知枠').value, '5'); assert(!f.container.textContent.includes('PRIVATE_CONFLICT'));
        await f.click('最新の支援者設定を再取得'); assert.equal(f.field('手動の追加通知枠').value, '5'); await f.editSubmit();
        assert.match(f.editor().querySelector('[aria-label="支援者設定の変更確認"]').textContent, /手動の追加通知枠4枠5枠/); await f.click('この支援者設定で保存');
        assert.deepEqual([writes(f).at(-1).body.expectedUpdatedAtMs, writes(f).at(-1).body.expectedLegacyIsDonor, writes(f).at(-1).body.expectedLegacyExtraSlots], [102, 0, 4]);
    } finally { await f.close(); }
});

test('rapid confirmation clicks produce one write and lock user switching while the save is pending', async () => {
    let release;
    const f = await fixture({ respond: async (route, method, body) => { if (method === 'PATCH') { await new Promise(resolve => { release = resolve; }); return donor(FIRST, { manual: { ...donor().manual, ...body, updatedAtMs: 101 }, version: { updatedAtMs: 101, legacyIsDonor: 1, legacyExtraSlots: 5 } }); } } });
    try {
        await f.choose(FIRST); await f.review(); const save = [...f.container.querySelectorAll('button')].find(item => item.textContent === 'この支援者設定で保存');
        await f.act(async () => { save.click(); save.click(); }); assert.equal(writes(f).length, 1);
        await f.choose(SECOND); assert(f.editor()); assert.equal(f.calls.filter(item => item.route === 'donors/' + SECOND).length, 0); await f.act(async () => release()); assert.match(f.editor().textContent, /保存しました/);
    } finally { if (release) release(); await f.close(); }
});

test('validation rejects fractional/out-of-range counters and missing reasons without changing the draft', async () => {
    const f = await fixture();
    try {
        await f.choose(FIRST);
        for (const [label, values] of [['手動の追加通知枠', ['', '-1', '1.5', '10001']], ['手動で記録した支援回数', ['', '-1', '1.5', '1000001']], ['手動で記録した購入口数', ['', '-1', '1.5', '1000001']]]) {
            for (const value of values) { await f.fill(f.field(label), value); await f.fill(f.field('変更理由（必須）'), '確認'); await f.editSubmit(); assert.equal(f.editor().querySelector('[aria-label="支援者設定の変更確認"]'), null); assert.equal(f.field(label).value, value); }
            await f.fill(f.field(label), '5');
        }
        await f.fill(f.field('変更理由（必須）'), '   '); await f.editSubmit(); assert.equal(writes(f).length, 0); assert.equal(f.editor().querySelector('[aria-label="支援者設定の変更確認"]'), null);
    } finally { await f.close(); }
});

test('Square lifetime counts and current grants are read-only, distinct from manual recorded units, with safe history pagination', async () => {
    const entry = { attemptId: 'fixture-attempt', state: 'COMPLETED', amount: 3000, currency: 'JPY', refundedAmount: 500, netAmount: 2500, verified: true, createdAtMs: 1791850000000, completedAtMs: 1791850010000 };
    const detail = donor(FIRST, { square: { ...donor().square, active: true, grant: grant({ active: true, purchaseUnits: 2, extraSlots: 4 }), history: [entry], historyNextCursor: 'history-next' } });
    const f = await fixture({ respond: (route, method) => route === 'donors/' + FIRST && method === 'GET' ? detail : route.includes('/history?') ? { items: [{ ...entry, attemptId: 'older', refundedAmount: 3000, netAmount: 0 }], nextCursor: null, pageSize: 20 } : undefined });
    try {
        await f.choose(FIRST); const square = f.editor().querySelector('[aria-label="Squareによる支援"]');
        assert.match(square.textContent, /確認済みの支援回数: 2回/); assert.match(square.textContent, /対象の購入口数 2口 · 追加 4枠/); assert.match(square.textContent, /返金 ￥500 · 支援額 ￥2,500/);
        assert.equal(square.querySelector('input,select,textarea'), null); assert.equal(f.field('手動で記録した購入口数').value, '4');
        await f.click('履歴の次へ'); assert.match(f.calls.at(-1).route, /history\?pageSize=20&cursor=history-next/); assert.match(square.textContent, /支援額 ￥0/); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('a failed detail load retries safely and a failed save retains the review inputs without raw server errors', async () => {
    let failedRead = false, failedWrite = false;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'donors/' + FIRST && method === 'GET' && !failedRead) { failedRead = true; throw new Error('PRIVATE_DETAIL'); }
        if (method === 'PATCH' && !failedWrite) { failedWrite = true; throw new Error('PRIVATE_SAVE'); }
    } });
    try {
        await f.choose(FIRST); assert(!f.container.textContent.includes('PRIVATE_DETAIL')); await f.click('設定を再取得'); await f.review(); await f.click('この支援者設定で保存');
        assert(!f.container.textContent.includes('PRIVATE_SAVE')); assert.equal(f.field('手動の追加通知枠').value, '5'); assert.equal(f.field('変更理由（必須）').value, '旧決済の購入履歴を確認');
        await f.editSubmit(); await f.click('この支援者設定で保存'); assert.equal(writes(f).length, 2); assert.match(f.editor().textContent, /保存しました/);
    } finally { await f.close(); }
});


test('reducing manual capacity warns before save and displays the returned over-limit state without deleting registrations', async () => {
    const f = await fixture({ respond: (route, method, body) => method === 'PATCH' ? donor(FIRST, {
        manual: { ...donor().manual, ...body, updatedAtMs: 101 }, version: { updatedAtMs: 101, legacyIsDonor: 0, legacyExtraSlots: 0 },
        entitlement: { ...donor().entitlement, label: '無料', tier: 'free', slotLimit: 5, usedSlots: 8, remainingSlots: 0, overLimit: true },
    }) : undefined });
    try {
        await f.choose(FIRST); await f.fill(f.field('手動の追加通知枠'), '0');
        await f.act(async () => f.editor().querySelector('input[type=checkbox]').click()); await f.fill(f.field('変更理由（必須）'), '旧枠の見直し'); await f.editSubmit();
        const confirmation = f.editor().querySelector('[aria-label="支援者設定の変更確認"]'); assert.match(confirmation.textContent, /手動の追加枠または支援者優先枠を減らす変更/);
        assert.match(confirmation.textContent, /Squareによる自動付与や有償プラン/); assert.match(confirmation.textContent, /既存の通知は削除されません/); assert.equal(writes(f).length, 0);
        await f.click('この支援者設定で保存'); const capacity = f.editor().querySelector('[aria-label="現在の通知枠"]');
        assert.match(capacity.textContent, /合計 5枠 · 使用中 8枠 · 残り 0枠/); assert.match(capacity.querySelector('[role="alert"]').textContent, /登録済みの通知が現在の通知枠を超えています/);
        assert.match(capacity.textContent, /登録は保持されます/); assert.match(capacity.textContent, /複数枠を使う高速化が制限/); assert.equal(writes(f).length, 1);
    } finally { await f.close(); }
});


const auditEntry = (userId = FIRST, changes = {}) => ({ id: 'fixture-audit', userId, actorUserId: '999999999999999999', reason: '以前の理由', createdAtMs: 1791850000000,
    before: { ...donor(userId).manual, legacyIsDonor: 1, legacyExtraSlots: 2 },
    after: { ...donor(userId).manual, extraSlots: 5, paymentCount: 8, note: '<script>private()</script>\n確認済み', legacyIsDonor: 1, legacyExtraSlots: 5 }, ...changes });
const auditReads = f => f.calls.filter(item => item.route.includes('/audit?'));

test('manual audit loads only when opened, pages by the selected owner cursor and renders actor/reason/before-after as text', async () => {
    const f = await fixture({ respond: route => route.includes('/audit?') ? { items: [auditEntry(FIRST, { reason: '<img src=x onerror=private()>を文字として記録', id: route.includes('cursor=') ? 'older-audit' : 'fixture-audit' })], nextCursor: route.includes('cursor=') ? null : 'audit-cursor', pageSize: 20 } : undefined });
    try {
        await f.choose(FIRST); assert.equal(auditReads(f).length, 0); await f.click('変更履歴を表示'); assert.equal(auditReads(f)[0].route, 'donors/' + FIRST + '/audit?pageSize=20');
        const history = f.editor().querySelector('[aria-label="この画面からの変更履歴"]'); assert.match(history.textContent, /変更者 Discord ID: 999999999999999999/);
        assert.match(history.textContent, /変更理由: <img src=x onerror=private\(\)>を文字として記録/); assert.match(history.textContent, /手動の追加通知枠2枠5枠/); assert.match(history.textContent, /手動で記録した支援回数3回8回/);
        assert.match(history.textContent, /<script>private\(\)<\/script>/); assert.equal(history.querySelector('script,img'), null);
        assert.match(history.textContent, /以前のDiscord操作など、ほかの管理機能での変更は含まれません/);
        await f.click('変更履歴の次へ'); assert.equal(auditReads(f).at(-1).route, 'donors/' + FIRST + '/audit?pageSize=20&cursor=audit-cursor'); assert.match(history.textContent, /変更履歴 2ページ/);
        await f.click('変更履歴の前へ'); assert.equal(auditReads(f).at(-1).route, 'donors/' + FIRST + '/audit?pageSize=20'); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('an already-open manual audit refreshes after saving and displays the newly committed reason', async () => {
    let reason = '以前の理由';
    const f = await fixture({ respond: (route, method, body) => {
        if (route.includes('/audit?')) return { items: [auditEntry(FIRST, { reason })], nextCursor: null, pageSize: 20 };
        if (method === 'PATCH') reason = body.reason;
    } });
    try {
        await f.choose(FIRST); await f.click('変更履歴を表示'); assert.equal(auditReads(f).length, 1); await f.review(); await f.click('この支援者設定で保存'); await f.settle();
        assert.equal(auditReads(f).length, 2); assert.equal(auditReads(f).at(-1).route, 'donors/' + FIRST + '/audit?pageSize=20');
        assert.match(f.editor().querySelector('[aria-label="この画面からの変更履歴"]').textContent, /変更理由: 旧決済の購入履歴を確認/); assert.equal(writes(f).length, 1);
        await f.click('変更履歴を閉じる'); await f.fill(f.field('手動の追加通知枠'), '6'); await f.fill(f.field('変更理由（必須）'), '次の修正'); await f.editSubmit(); await f.click('この支援者設定で保存');
        assert.equal(auditReads(f).length, 2, 'closed audit performs no reads on save');
    } finally { await f.close(); }
});

test('a late manual audit response cannot appear in another selected user and stale pagination cannot replace a newer refresh', async () => {
    let releaseOwner, releasePage;
    const f = await fixture({ respond: async route => {
        if (!route.includes('/audit?')) return;
        if (route.startsWith('donors/' + FIRST + '/audit')) { await new Promise(resolve => { releaseOwner = resolve; }); return { items: [auditEntry(FIRST, { reason: '古いユーザーの履歴' })], nextCursor: null, pageSize: 20 }; }
        if (route.includes('cursor=')) { await new Promise(resolve => { releasePage = resolve; }); return { items: [auditEntry(SECOND, { reason: '遅れたページの履歴' })], nextCursor: null, pageSize: 20 }; }
        return { items: [auditEntry(SECOND, { reason: '選択中のユーザーの履歴' })], nextCursor: 'next-audit', pageSize: 20 };
    } });
    try {
        await f.choose(FIRST); await f.click('変更履歴を表示'); await f.choose(SECOND); assert.equal(auditReads(f).length, 1); await f.click('変更履歴を表示');
        await f.act(async () => releaseOwner()); assert(!f.container.textContent.includes('古いユーザーの履歴')); assert.match(f.editor(SECOND).textContent, /選択中のユーザーの履歴/);
        await f.click('変更履歴の次へ'); await f.click('変更履歴を閉じる'); await f.click('変更履歴を表示'); await f.act(async () => releasePage());
        assert(!f.container.textContent.includes('遅れたページの履歴')); assert.match(f.editor(SECOND).textContent, /変更履歴 1ページ/); assert.equal(writes(f).length, 0);
    } finally { if (releaseOwner) releaseOwner(); if (releasePage) releasePage(); await f.close(); }
});

test('a failed manual audit page retains earlier records and retries the failed cursor without raw errors', async () => {
    let failed = false;
    const f = await fixture({ respond: route => {
        if (!route.includes('/audit?')) return;
        if (route.includes('cursor=') && !failed) { failed = true; throw new Error('PRIVATE_AUDIT_QUERY'); }
        return { items: [auditEntry(FIRST, { reason: route.includes('cursor=') ? '古い変更理由' : '表示中の変更理由' })], nextCursor: route.includes('cursor=') ? null : 'retry-audit', pageSize: 20 };
    } });
    try {
        await f.choose(FIRST); await f.click('変更履歴を表示'); await f.click('変更履歴の次へ');
        assert.match(f.editor().textContent, /表示中の変更理由/); assert(!f.container.textContent.includes('PRIVATE_AUDIT_QUERY')); const failedRoute = auditReads(f).at(-1).route;
        await f.click('変更履歴を再取得'); assert.equal(auditReads(f).at(-1).route, failedRoute); assert.match(f.editor().textContent, /古い変更理由/); assert.match(f.editor().textContent, /変更履歴 2ページ/); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});
