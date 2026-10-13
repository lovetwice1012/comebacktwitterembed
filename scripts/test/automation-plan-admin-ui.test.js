'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const policy = (planId, changes = {}) => ({ tier: planId === 'free' ? 'free' : planId === 'supporter' ? 'supporter' : 'paid', planId,
    label: planId === 'free' ? '無料' : planId === 'supporter' ? '支援者' : '有償設定', slotLimit: 5, dayLimit: 24, minuteLimit: 5,
    priority: planId === 'supporter' ? 1 : 0, enabled: true, isBuiltin: ['free', 'supporter'].includes(planId), updatedAtMs: 100, ...changes });
const billing = (changes = {}) => ({ configured: false, environment: 'sandbox', missing: [], bindings: [], ...changes });
async function fixture({ plans = [policy('free'), policy('supporter')], square = billing(), respond } = {}) {
    const f = await reactFixture('export { NotificationPlanManager, notificationPlanAPI } from "./components/admin/notification-plan-manager"; export { automationResponseError } from "./components/automation/automation-feedback";');
    const calls = [];
    f.api = async (route, method = 'GET', body) => {
        calls.push({ route, method, body });
        const override = respond && await respond(route, method, body, f);
        if (override !== undefined) return override;
        if (route === 'plans' && method === 'GET') return { items: plans };
        if (route === 'billing/admin') return square;
        if (route.startsWith('plans/') || method === 'POST') return policy(body.planId, { ...body, updatedAtMs: 101 });
        throw new Error('Unexpected API request');
    };
    f.calls = calls;
    await f.render(f.React.createElement(f.exports.NotificationPlanManager, { api: f.api })); await f.settle();
    f.article = label => [...f.container.querySelectorAll('article')].find(node => node.getAttribute('aria-label') === `${label}の通知設定`);
    f.inField = (node, label) => [...node.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(label))?.querySelector('input');
    f.inClick = async (node, label) => {
        const button = [...node.querySelectorAll('button')].find(item => item.textContent.trim() === label);
        assert(button, `missing button ${label}`); await f.act(async () => button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
    };
    f.inSubmit = async node => f.act(async () => node.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    return f;
}
const writes = f => f.calls.filter(call => call.method !== 'GET');

test('admin notification plans are guarded by the session and both rollout navigation variants provide a real route', () => {
    const root = path.resolve(__dirname, '../..');
    const page = fs.readFileSync(path.join(root, 'dashboard/app/admin/notification-plans/page.tsx'), 'utf8');
    assert.match(page, /await requireDashboardSession\(\)/); assert.match(page, /if \(!session\.user\.isAdmin\) notFound\(\)/);
    assert.match(page, /<NotificationPlanManager/);
    for (const source of ['dashboard/components/admin/workspace-shell.tsx', 'dashboard/legacy/components/admin/workspace-shell.tsx']) {
        assert.match(fs.readFileSync(path.join(root, source), 'utf8'), /href="\/admin\/notification-plans"/);
    }
});

test('free/supporter editable defaults display server values and cannot be disabled, with explicit message counting and reset rules', async () => {
    const f = await fixture();
    try {
        for (const label of ['無料', '支援者']) {
            const article = f.article(label);
            assert.equal(f.inField(article, '通知枠数').value, '5'); assert.equal(f.inField(article, '枠あたりの日次上限').value, '24');
            assert.equal(f.inField(article, '枠あたりの分次上限').value, '5'); assert.equal(article.querySelector('input[type=checkbox]'), null);
            assert.match(article.textContent, /常に有効/);
        }
        assert.equal(f.inField(f.article('無料'), '処理の優先度').value, '0'); assert.equal(f.inField(f.article('支援者'), '処理の優先度').value, '1');
        assert.match(f.container.textContent, /メッセージ1件＝1通/); assert.match(f.container.textContent, /日本時間の0時/); assert.match(f.container.textContent, /停止中の登録も1枠/);
    } finally { await f.close(); }
});

test('numeric fields preserve empty input and reject non-integer and out-of-range values before opening confirmation or saving', async () => {
    const f = await fixture();
    try {
        const article = f.article('無料'), field = f.inField(article, '通知枠数');
        for (const value of ['', '0', '1.5', '10001', '-1']) {
            await f.fill(field, value); assert.equal(field.value, value);
            await f.inSubmit(article); assert.equal(article.querySelector('[aria-label="変更内容の確認"]'), null); assert.equal(writes(f).length, 0);
        }
        await f.fill(field, '10'); await f.fill(f.inField(article, '処理の優先度'), '101'); await f.inSubmit(article); assert.equal(writes(f).length, 0);
        await f.fill(f.inField(article, '処理の優先度'), '0'); await f.inSubmit(article); assert(article.querySelector('[aria-label="変更内容の確認"]'));
    } finally { await f.close(); }
});

test('editing limits saves typed numbers and expected version only after the explicit before/after confirmation', async () => {
    const f = await fixture();
    try {
        const article = f.article('無料'); await f.fill(f.inField(article, '通知枠数'), '9'); await f.fill(f.inField(article, '枠あたりの日次上限'), '48');
        await f.fill(f.inField(article, '枠あたりの分次上限'), '7'); await f.fill(f.inField(article, '処理の優先度'), '2');
        await f.inSubmit(article); assert.equal(writes(f).length, 0);
        const confirmation = article.querySelector('[aria-label="変更内容の確認"]'); assert.match(confirmation.textContent, /通知枠数59枠/); assert.match(confirmation.textContent, /枠あたりの日次上限2448通/);
        await f.inClick(article, 'この内容で保存');
        assert.deepEqual(writes(f), [{ route: 'plans/free', method: 'PATCH', body: { planId: 'free', label: '無料', slotLimit: 9, dayLimit: 48, minuteLimit: 7, priority: 2, enabled: true, expectedUpdatedAtMs: 100 } }]);
        assert.match(article.textContent, /保存しました/); assert.equal(f.inField(article, '通知枠数').value, '9');
    } finally { await f.close(); }
});

test('a conflict reloads the current baseline while keeping edits and requires a fresh review with the new version', async () => {
    let conflict = true, listCount = 0;
    const f = await fixture({ respond: async (route, method, body, current) => {
        if (route === 'plans' && method === 'GET' && ++listCount > 1) return { items: [policy('free', { slotLimit: 8, updatedAtMs: 102 }), policy('supporter')] };
        if (route === 'plans/free' && conflict) { conflict = false; throw current.exports.automationResponseError({ error: 'Changed', code: 'AUTOMATION_PLAN_CONFLICT' }, new Response('', { status: 409 })); }
    } });
    try {
        const article = f.article('無料'); await f.fill(f.inField(article, '通知枠数'), '9'); await f.inSubmit(article); await f.inClick(article, 'この内容で保存');
        assert.match(article.textContent, /ほかの管理者による変更/); assert.equal(f.inField(article, '通知枠数').value, '9');
        await f.inClick(article, '最新の設定を再取得'); assert.equal(f.inField(article, '通知枠数').value, '9'); assert.equal(article.querySelector('[aria-label="変更内容の確認"]'), null);
        await f.inSubmit(article); assert.match(article.querySelector('[aria-label="変更内容の確認"]').textContent, /通知枠数89枠/);
        await f.inClick(article, 'この内容で保存'); assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 102);
    } finally { await f.close(); }
});

test('new paid plans require explicitly entered name and all limits, without copying a free default or inventing a price', async () => {
    const f = await fixture();
    try {
        await f.click('有償プランを追加'); const article = f.article('新しい有償プラン');
        for (const label of ['表示名', '通知枠数', '枠あたりの日次上限', '枠あたりの分次上限', '処理の優先度']) assert.equal(f.inField(article, label).value, '');
        await f.inSubmit(article); assert.equal(writes(f).length, 0);
        for (const [label, value] of [['プランID', 'paid_config'], ['表示名', '管理者が設定したプラン'], ['通知枠数', '12'], ['枠あたりの日次上限', '100'], ['枠あたりの分次上限', '10'], ['処理の優先度', '4']]) await f.fill(f.inField(article, label), value);
        await f.inSubmit(article); await f.inClick(article, 'この内容で保存');
        assert.equal(writes(f)[0].method, 'POST'); assert.equal(writes(f)[0].body.expectedUpdatedAtMs, 0); assert.equal(writes(f)[0].body.dayLimit, 100);
        assert.match(f.container.textContent, /管理者が設定したプラン/); assert(!/￥[0-9]/.test(f.container.textContent)); assert(!f.container.textContent.includes('1,000円'));
    } finally { await f.close(); }
});

test('new paid plans reject built-in reserved IDs in uppercase and mixed case before confirmation or saving', async () => {
    const f = await fixture();
    try {
        await f.click('有償プランを追加'); const article = f.article('新しい有償プラン');
        for (const [label, value] of [['表示名', '入力した有償プラン'], ['通知枠数', '12'], ['枠あたりの日次上限', '100'], ['枠あたりの分次上限', '10'], ['処理の優先度', '4']]) await f.fill(f.inField(article, label), value);
        for (const id of ['FREE', 'Free', 'Supporter', 'SUPPORTER', 'sUpPoRtEr']) {
            await f.fill(f.inField(article, 'プランID'), id); await f.inSubmit(article);
            assert.equal(article.querySelector('[aria-label="変更内容の確認"]'), null); assert.equal(writes(f).length, 0);
            assert.equal([...article.querySelectorAll('button')].find(node => node.textContent === '変更内容を確認').disabled, true);
        }
        await f.fill(f.inField(article, 'プランID'), 'FREE_CUSTOM'); await f.inSubmit(article); assert(article.querySelector('[aria-label="変更内容の確認"]'));
    } finally { await f.close(); }
});

test('failed initial load can retry, and refreshing settings preserves a current edit while updating the comparison baseline', async () => {
    let listCount = 0;
    const f = await fixture({ respond: async (route, method) => {
        if (route === 'plans' && method === 'GET') { listCount++; if (listCount === 1) throw new Error('設定を読み込めませんでした。'); return { items: [policy('free', { slotLimit: listCount === 2 ? 5 : 7, updatedAtMs: 100 + listCount })] }; }
    } });
    try {
        assert.match(f.container.textContent, /設定を読み込めません/); await f.click('読み込みを再試行'); await f.settle();
        const article = f.article('無料'); await f.fill(f.inField(article, '通知枠数'), '9'); await f.click('設定を更新'); await f.settle();
        assert.equal(f.inField(article, '通知枠数').value, '9'); await f.inSubmit(article); assert.match(article.querySelector('[aria-label="変更内容の確認"]').textContent, /通知枠数79枠/);
    } finally { await f.close(); }
});

test('a refresh after confirmation prevents saving against an unseen changed baseline until the edit is reviewed again', async () => {
    let listCount = 0;
    const f = await fixture({ respond: async (route, method) => route === 'plans' && method === 'GET' ? { items: [policy('free', { updatedAtMs: ++listCount })] } : undefined });
    try {
        const article = f.article('無料'); await f.fill(f.inField(article, '通知枠数'), '9'); await f.inSubmit(article); await f.click('設定を更新'); await f.settle();
        assert.match(article.textContent, /現在の設定が更新/); const save = [...article.querySelectorAll('button')].find(node => node.textContent === 'この内容で保存'); assert.equal(save.disabled, true);
        await f.inClick(article, '編集に戻る'); await f.inSubmit(article); await f.inClick(article, 'この内容で保存'); assert.equal(writes(f)[0].body.expectedUpdatedAtMs, 2);
    } finally { await f.close(); }
});

test('default API rate feedback uses Retry-After, keeps draft fields and allows the same edit to be retried manually', async () => {
    const f = await reactFixture('export { NotificationPlanManager } from "./components/admin/notification-plan-manager";');
    let patchCount = 0;
    f.set('fetch', async (url, options = {}) => {
        if (url.endsWith('/billing/admin')) return Response.json(billing());
        if (options.method === 'PATCH') {
            if (++patchCount === 1) return Response.json({ code: 'AUTOMATION_RATE_LIMITED', error: 'PRIVATE_RATE_FAILURE' }, { status: 429, headers: { 'Retry-After': '7' } });
            return Response.json(policy('free', { ...JSON.parse(options.body), updatedAtMs: 101 }));
        }
        return Response.json({ items: [policy('free')] });
    });
    try {
        await f.render(f.React.createElement(f.exports.NotificationPlanManager)); await f.settle(); await f.fill(f.field('通知枠数'), '9'); await f.submit(); await f.click('この内容で保存');
        assert.match(f.container.textContent, /約7秒待ってから再試行/); assert(!f.container.textContent.includes('PRIVATE_RATE_FAILURE')); assert.equal(f.field('通知枠数').value, '9');
        await f.submit(); await f.click('この内容で保存'); assert.equal(patchCount, 2); assert.match(f.container.textContent, /保存しました/);
    } finally { await f.close(); }
});

test('unconfigured Square is clearly shown without secret fields and does not block paid limit editing', async () => {
    const f = await fixture({ plans: [policy('paid_one')], square: billing({ missing: ['SQUARE_ACCESS_TOKEN', 'SQUARE_WEBHOOK_SIGNATURE_KEY'] }) });
    try {
        const article = f.article('有償設定'); assert.match(f.container.textContent, /Square連携: 未設定/); assert.match(article.textContent, /サーバー側のSquare設定が未完了/);
        assert.match(f.container.textContent, /署名キーが未設定/); assert.match(f.container.textContent, /接続トークンが未設定/);
        assert.equal(f.inField(article, 'SquareプランバリエーションID').matches(':disabled'), true); assert.equal(f.inField(article, '通知枠数').matches(':disabled'), false);
        assert(!f.container.textContent.includes('SQUARE_ACCESS_TOKEN')); assert.equal(f.container.querySelector('input[type=password]'), null);
        await f.fill(f.inField(article, '通知枠数'), '8'); await f.inSubmit(article); await f.inClick(article, 'この内容で保存'); assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].route, 'plans/paid_one');
    } finally { await f.close(); }
});

test('Square association shows minor-unit price and cadence, validates before saving and retains an invalid catalog ID for correction', async () => {
    const oldBinding = { planId: 'paid_one', variationId: 'OLD_VARIATION', enabled: true, catalogName: 'Square月額', cadence: 'MONTHLY', amount: 1500, currency: 'JPY', verifiedAtMs: 1791831600000 };
    let rejected = false;
    const f = await fixture({ plans: [policy('paid_one')], square: billing({ configured: true, bindings: [oldBinding] }), respond: async (route, method, body) => {
        if (route === 'billing/bindings/paid_one') { if (!rejected) { rejected = true; throw new Error('Squareプランを検証できませんでした。'); } return { ...oldBinding, ...body, catalogName: '検証済みSquare', amount: 199, currency: 'USD' }; }
    } });
    try {
        const article = f.article('有償設定'), input = f.inField(article, 'SquareプランバリエーションID'); assert.match(article.textContent, /￥1,500 · 月ごと/);
        await f.fill(input, 'NEW_VARIATION'); await f.inClick(article, '紐付け内容を確認'); assert.equal(writes(f).length, 0); assert.match(article.textContent, /NEW_VARIATION.*現在の設定/);
        await f.inClick(article, 'Squareで検証して紐付け'); assert.equal(input.value, 'NEW_VARIATION'); assert.match(article.textContent, /検証できません/);
        await f.inClick(article, '紐付け内容を確認'); await f.inClick(article, 'Squareで検証して紐付け');
        assert.deepEqual(writes(f).at(-1).body, { cadence: 'MONTHLY', variationId: 'NEW_VARIATION', enabled: true, expectedVerifiedAtMs: oldBinding.verifiedAtMs }); assert.match(article.textContent, /\$1.99 · 月ごと/); assert.match(article.textContent, /プランを紐付けました/);
        assert(writes(f).every(call => call.route === 'billing/bindings/paid_one'));
    } finally { await f.close(); }
});

test('Square status errors have their own retry control and never erase a limits draft', async () => {
    let tries = 0;
    const f = await fixture({ plans: [policy('paid_one')], respond: async route => {
        if (route === 'billing/admin') { if (++tries === 1) throw new Error('Square連携状態を取得できませんでした。'); return billing({ configured: true }); }
    } });
    try {
        const article = f.article('有償設定'); await f.fill(f.inField(article, '通知枠数'), '11'); assert.match(f.container.textContent, /Square連携状態を取得できません/);
        await f.click('Square連携を再確認'); assert.equal(f.inField(article, '通知枠数').value, '11'); assert.equal(f.inField(article, 'SquareプランバリエーションID').disabled, false); assert.match(f.container.textContent, /Square連携: サンドボックス/);
    } finally { await f.close(); }
});

test('Square catalog choices fill the variation ID without requiring manual entry and still need confirmation before saving', async () => {
    const f = await fixture({ plans: [policy('paid_one')], square: billing({ configured: true, availableVariations: [{ variationId: 'CATALOG_VARIATION', catalogName: 'Squareで登録した月額', cadence: 'MONTHLY', amount: 980, currency: 'JPY' }] }), respond: async (route, method, body) => route === 'billing/bindings/paid_one' ? { planId: 'paid_one', ...body, catalogName: 'Squareで登録した月額', cadence: 'MONTHLY', amount: 980, currency: 'JPY', verifiedAtMs: 1791831600000 } : undefined });
    try {
        const article = f.article('有償設定'), select = [...article.querySelectorAll('label')].find(node => node.textContent.startsWith('Squareのプランから選ぶ')).querySelector('select'); assert(select); assert.match(select.textContent, /Squareで登録した月額.*￥980.*月ごと/);
        await f.fill(select, 'CATALOG_VARIATION'); assert.equal(f.inField(article, 'SquareプランバリエーションID').value, 'CATALOG_VARIATION'); assert.equal(writes(f).length, 0);
        await f.inClick(article, '紐付け内容を確認'); await f.inClick(article, 'Squareで検証して紐付け'); assert.equal(writes(f)[0].body.variationId, 'CATALOG_VARIATION');
    } finally { await f.close(); }
});

test('Square binding conflict preserves a stale edit and requires review against the newly disabled binding before CAS save', async () => {
    const initial = { planId: 'paid_one', variationId: 'ORIGINAL', enabled: true, catalogName: 'Original', cadence: 'MONTHLY', amount: 1500, currency: 'JPY', verifiedAtMs: 100 };
    let adminReads = 0, attempts = 0;
    const f = await fixture({ plans: [policy('paid_one')], respond: async (route, method, body, current) => {
        if (route === 'billing/admin') return billing({ configured: true, bindings: [{ ...initial, enabled: ++adminReads === 1, verifiedAtMs: adminReads === 1 ? 100 : 101 }] });
        if (route === 'billing/bindings/paid_one') {
            if (++attempts === 1) throw current.exports.automationResponseError({ error: 'changed', code: 'SQUARE_BINDING_CONFLICT' }, new Response('', { status: 409 }));
            return { ...initial, ...body, verifiedAtMs: 102 };
        }
    } });
    try {
        const article = f.article('有償設定'), input = f.inField(article, 'SquareプランバリエーションID');
        await f.fill(input, 'REPLACEMENT'); await f.inClick(article, '紐付け内容を確認');
        assert.match(article.querySelector('[aria-label="Square紐付けの確認"]').textContent, /SquareプランORIGINALREPLACEMENT/);
        await f.inClick(article, 'Squareで検証して紐付け'); assert.equal(writes(f)[0].body.expectedVerifiedAtMs, 100);
        assert.match(article.textContent, /ほかの管理者がSquareの紐付けを変更/); assert.equal(input.value, 'REPLACEMENT');
        await f.inClick(article, '紐付け内容を確認'); assert.equal(writes(f).length, 1);
        await f.inClick(article, '最新のSquare紐付けを再取得'); assert.equal(input.value, 'REPLACEMENT'); assert.equal(article.querySelector('[aria-label="Square紐付けの確認"]'), null);
        await f.inClick(article, '紐付け内容を確認'); assert.match(article.querySelector('[aria-label="Square紐付けの確認"]').textContent, /購入受付停止有効/);
        await f.inClick(article, 'Squareで検証して紐付け'); assert.equal(writes(f).at(-1).body.expectedVerifiedAtMs, 101);
    } finally { await f.close(); }
});

test('a refreshed Square binding invalidates the previous confirmation and rapid clicks issue only one current CAS write', async () => {
    const initial = { planId: 'paid_one', variationId: 'ORIGINAL', enabled: true, catalogName: 'Original', cadence: 'MONTHLY', amount: 1500, currency: 'JPY', verifiedAtMs: 100 };
    let adminReads = 0, release;
    const f = await fixture({ plans: [policy('paid_one')], respond: async (route, method, body) => {
        if (route === 'billing/admin') return billing({ configured: true, bindings: [{ ...initial, verifiedAtMs: 99 + ++adminReads }] });
        if (route === 'billing/bindings/paid_one') { await new Promise(resolve => { release = resolve; }); return { ...initial, ...body, verifiedAtMs: 102 }; }
    } });
    try {
        const article = f.article('有償設定'); await f.fill(f.inField(article, 'SquareプランバリエーションID'), 'REPLACEMENT'); await f.inClick(article, '紐付け内容を確認');
        await f.click('Square連携を再確認'); assert.match(article.textContent, /現在のSquare設定が更新/);
        const staleButton = [...article.querySelectorAll('button')].find(node => node.textContent === 'Squareで検証して紐付け'); assert.equal(staleButton.disabled, true);
        await f.inClick(article, '紐付けの編集に戻る'); await f.inClick(article, '紐付け内容を確認');
        const button = [...article.querySelectorAll('button')].find(node => node.textContent === 'Squareで検証して紐付け');
        await f.act(async () => { button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); });
        assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].body.expectedVerifiedAtMs, 101);
        await f.act(async () => release()); assert.match(article.textContent, /プランを紐付けました/);
    } finally { if (release) release(); await f.close(); }
});

test('a late binding refresh cannot replace the newer saved binding or its CAS baseline', async () => {
    const initial = { planId: 'paid_one', variationId: 'ORIGINAL', enabled: true, catalogName: 'Original', cadence: 'MONTHLY', amount: 1500, currency: 'JPY', verifiedAtMs: 100 };
    let reads = 0, releaseSave, releaseRefresh;
    const f = await fixture({ plans: [policy('paid_one')], respond: async (route, method, body) => {
        if (route === 'billing/admin') { if (++reads > 1) await new Promise(resolve => { releaseRefresh = resolve; }); return billing({ configured: true, bindings: [initial] }); }
        if (route === 'billing/bindings/paid_one') { if (!releaseSave) await new Promise(resolve => { releaseSave = resolve; }); return { ...initial, ...body, verifiedAtMs: 102 }; }
    } });
    try {
        const article = f.article('有償設定'), input = f.inField(article, 'SquareプランバリエーションID');
        await f.fill(input, 'SAVED'); await f.inClick(article, '紐付け内容を確認'); await f.inClick(article, 'Squareで検証して紐付け');
        await f.click('Square連携を再確認'); await f.act(async () => releaseSave()); await f.act(async () => releaseRefresh());
        assert.equal(input.value, 'SAVED'); assert.match(article.textContent, /プランを紐付けました/);
        await f.fill(input, 'ANOTHER'); await f.inClick(article, '紐付け内容を確認'); await f.inClick(article, 'Squareで検証して紐付け');
        assert.equal(writes(f).at(-1).body.expectedVerifiedAtMs, 102);
    } finally { if (releaseSave) releaseSave(); if (releaseRefresh) releaseRefresh(); await f.close(); }
});

const paidBinding = (cadence, changes = {}) => ({ planId: 'paid_one', variationId: cadence + '_VARIATION', enabled: true,
    catalogName: cadence === 'MONTHLY' ? 'Square月額' : 'Square年額', cadence, amount: cadence === 'MONTHLY' ? 1000 : 10000,
    currency: 'JPY', verifiedAtMs: cadence === 'MONTHLY' ? 100 : 200, ...changes });
const intervalSection = (article, cadence) => article.querySelector(`[aria-label="${cadence === 'MONTHLY' ? '月ごと' : '年ごと'}の支払い設定"]`);
const intervalSelect = (node, label) => [...node.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(label))?.querySelector('select');

test('adding an annual interval preserves the monthly binding and targets a new annual CAS row', async () => {
    const monthly = paidBinding('MONTHLY'), annual = paidBinding('ANNUAL');
    const f = await fixture({ plans: [policy('paid_one')], square: billing({ configured: true, bindings: [monthly], availableVariations: [monthly, annual] }),
        respond: (route, method, body) => route === 'billing/bindings/paid_one' ? { ...annual, ...body } : undefined });
    try {
        const article = f.article('有償設定'); await f.inClick(article, '支払い間隔を追加');
        const add = article.querySelector('[aria-label="支払い間隔の追加"]'), cadence = intervalSelect(add, '追加する支払い間隔');
        assert(![...cadence.options].some(option => option.value === 'MONTHLY')); await f.fill(cadence, 'ANNUAL');
        const variations = intervalSelect(add, 'Squareのプランから選ぶ'); assert.deepEqual([...variations.options].map(option => option.value), ['', 'ANNUAL_VARIATION']);
        await f.fill(variations, 'ANNUAL_VARIATION'); await f.inClick(add, '紐付け内容を確認');
        assert.match(add.querySelector('[aria-label="Square紐付けの確認"]').textContent, /対象の支払い間隔: 年ごと/); assert.equal(writes(f).length, 0);
        await f.inClick(add, 'Squareで検証して紐付け');
        assert.deepEqual(writes(f)[0].body, { cadence: 'ANNUAL', variationId: 'ANNUAL_VARIATION', enabled: true, expectedVerifiedAtMs: null });
        assert.equal(f.inField(intervalSection(article, 'MONTHLY'), 'SquareプランバリエーションID').value, 'MONTHLY_VARIATION');
        assert.equal(f.inField(intervalSection(article, 'ANNUAL'), 'SquareプランバリエーションID').value, 'ANNUAL_VARIATION');
        assert.match(intervalSection(article, 'ANNUAL').textContent, /￥10,000 · 年ごと/); assert.match(intervalSection(article, 'ANNUAL').textContent, /￥833.33／月相当/);
        assert.equal(article.querySelector('[aria-label="支払い間隔の追加"]'), null);
    } finally { await f.close(); }
});

test('monthly and annual acceptance save independently with exact row versions and preserve the sibling draft', async () => {
    const monthly = paidBinding('MONTHLY'), annual = paidBinding('ANNUAL');
    const f = await fixture({ plans: [policy('paid_one')], square: billing({ configured: true, bindings: [monthly, annual] }),
        respond: (route, method, body) => route === 'billing/bindings/paid_one' ? { ...(body.cadence === 'MONTHLY' ? monthly : annual), ...body, verifiedAtMs: body.expectedVerifiedAtMs + 1 } : undefined });
    try {
        const article = f.article('有償設定'), month = intervalSection(article, 'MONTHLY'), year = intervalSection(article, 'ANNUAL');
        await f.fill(f.inField(year, 'SquareプランバリエーションID'), 'YEAR_REPLACEMENT');
        await f.act(async () => year.querySelector('input[type=checkbox]').click());
        await f.act(async () => month.querySelector('input[type=checkbox]').click());
        await f.inClick(month, '紐付け内容を確認'); await f.inClick(month, 'Squareで検証して紐付け');
        assert.equal(f.inField(year, 'SquareプランバリエーションID').value, 'YEAR_REPLACEMENT'); assert.equal(year.querySelector('input[type=checkbox]').checked, false);
        assert.equal(month.querySelector('input[type=checkbox]').checked, false); assert.match(month.textContent, /購入受付停止中/);
        await f.inClick(year, '紐付け内容を確認'); await f.inClick(year, 'Squareで検証して紐付け');
        assert.deepEqual(writes(f).map(call => call.body), [
            { cadence: 'MONTHLY', variationId: 'MONTHLY_VARIATION', enabled: false, expectedVerifiedAtMs: 100 },
            { cadence: 'ANNUAL', variationId: 'YEAR_REPLACEMENT', enabled: false, expectedVerifiedAtMs: 200 },
        ]);
        assert.equal(month.querySelector('input[type=checkbox]').checked, false); assert.equal(year.querySelector('input[type=checkbox]').checked, false);
        assert.equal(f.inField(month, 'SquareプランバリエーションID').value, 'MONTHLY_VARIATION');
        await f.fill(f.inField(month, 'SquareプランバリエーションID'), 'MONTH_REPLACEMENT'); await f.inClick(month, '紐付け内容を確認'); await f.inClick(month, 'Squareで検証して紐付け');
        assert.equal(writes(f).at(-1).body.expectedVerifiedAtMs, 101);
    } finally { await f.close(); }
});

test('editing an interval cannot replace its cadence with another known Square variation', async () => {
    const monthly = paidBinding('MONTHLY'), annual = paidBinding('ANNUAL');
    const f = await fixture({ plans: [policy('paid_one')], square: billing({ configured: true, bindings: [monthly], availableVariations: [monthly, annual] }) });
    try {
        const article = f.article('有償設定'), month = intervalSection(article, 'MONTHLY');
        assert.equal(intervalSelect(month, '追加する支払い間隔'), undefined);
        assert.deepEqual([...intervalSelect(month, 'Squareのプランから選ぶ').options].map(option => option.value), ['', 'MONTHLY_VARIATION']);
        await f.fill(f.inField(month, 'SquareプランバリエーションID'), 'ANNUAL_VARIATION'); await f.inClick(month, '紐付け内容を確認');
        assert.equal(month.querySelector('[aria-label="Square紐付けの確認"]'), null); assert.equal(writes(f).length, 0); assert.equal(f.inField(month, 'SquareプランバリエーションID').value, 'ANNUAL_VARIATION');
    } finally { await f.close(); }
});

test('a failed annual association retains the added interval, amount selection and monthly row', async () => {
    const monthly = paidBinding('MONTHLY'), annual = paidBinding('ANNUAL');
    const f = await fixture({ plans: [policy('paid_one')], square: billing({ configured: true, bindings: [monthly], availableVariations: [annual] }),
        respond: route => { if (route === 'billing/bindings/paid_one') throw new Error('Squareプランを検証できませんでした。'); } });
    try {
        const article = f.article('有償設定'); await f.inClick(article, '支払い間隔を追加'); const add = article.querySelector('[aria-label="支払い間隔の追加"]');
        await f.fill(intervalSelect(add, '追加する支払い間隔'), 'ANNUAL'); await f.fill(intervalSelect(add, 'Squareのプランから選ぶ'), 'ANNUAL_VARIATION');
        await f.inClick(add, '紐付け内容を確認'); await f.inClick(add, 'Squareで検証して紐付け');
        assert.equal(intervalSelect(add, '追加する支払い間隔').value, 'ANNUAL'); assert.equal(f.inField(add, 'SquareプランバリエーションID').value, 'ANNUAL_VARIATION');
        assert.match(add.textContent, /検証できません/); assert.equal(f.inField(intervalSection(article, 'MONTHLY'), 'SquareプランバリエーションID').value, 'MONTHLY_VARIATION');
        assert.equal(intervalSection(article, 'ANNUAL'), null);
    } finally { await f.close(); }
});
