'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const policy = (changes = {}) => ({ planId: 'paid_saved', label: '保存済み有償プラン', tier: 'paid', enabled: true, slotLimit: 12, minuteLimit: 8, dayLimit: 96, priority: 2, isBuiltin: false, updatedAtMs: 100, ...changes });
const creation = (changes = {}) => ({ creationId: 'creation-1', planId: 'paid_saved', name: '確認済みSquareプラン', cadence: 'MONTHLY', amount: 1500, currency: 'JPY', state: 'QUOTED', variationId: null, expiresAtMs: Date.now() + 60000, retryable: false, ...changes });
const coupon = (changes = {}) => ({ code: 'WELCOME', label: '初回の割引', type: 'percent', value: 20, currency: null, planIds: ['paid_saved'], enabled: true, expiresAtMs: null, totalLimit: 50, userLimit: 1, updatedAtMs: 100, used: 2, reserved: 1, ...changes });
const admin = (changes = {}) => ({ configured: true, environment: 'sandbox', locationCurrency: 'JPY', minorUnitDigits: 0, coupons: [], creations: [], ...changes });
const subscriptionPlan = (changes = {}) => ({ ...policy(), variationId: 'BASE_VARIATION', catalogName: 'Square月額', cadence: 'MONTHLY', amount: 1500, currency: 'JPY', ...changes });
const status = (changes = {}) => ({ configured: true, environment: 'sandbox', subscription: null, pending: null, ...changes });

async function fixture({ kind = 'catalog', initialAdmin = admin(), plans = [policy()], respond, quotedPlan, configured = true, occupiedCadences = [] } = {}) {
    const f = await reactFixture('export { SquareCatalogCreator, SquareCouponManager, couponExpiry } from "./components/admin/square-commerce-manager"; export { SubscriptionManager } from "./components/automation/subscription-manager"; export { NotificationPlanManager } from "./components/admin/notification-plan-manager";');
    const calls = [], sdk = { loads: 0, tokens: [] }; let savedCreation = creation(), refreshed = 0;
    f.api = async (route, method = 'GET', body) => {
        calls.push({ route, method, body }); const override = respond && await respond(route, method, body, f); if (override !== undefined) return override;
        if (route === 'billing/commerce/admin') return initialAdmin;
        if (route === 'billing/catalog/quote') return savedCreation = creation({ ...body });
        if (route === 'billing/catalog/create') return creation({ ...savedCreation, state: 'COMPLETE', variationId: 'CREATED_VARIATION' });
        if (route.startsWith('billing/catalog/')) return savedCreation;
        if (route.startsWith('billing/coupons')) return coupon({ ...body, updatedAtMs: 101, used: 0, reserved: 0 });
        if (route === 'plans') return { items: plans };
        if (route === 'billing/admin') return { configured, environment: 'sandbox', missing: [], bindings: [], availableVariations: [] };
        if (route === 'options') return { configured: true, environment: 'sandbox', applicationId: 'sandbox-app', locationId: 'location', plans: [subscriptionPlan()] };
        if (route === 'status') return status();
        if (route === 'quote') return { checkoutId: 'checkout-1', expiresAtMs: Date.now() + 60000, email: body.email, name: body.name, plan: quotedPlan ?? subscriptionPlan() };
        if (route === 'subscribe') return status({ pending: { checkoutId: 'checkout-1', state: 'SUBMITTING', retryable: false } });
        throw new Error('Unexpected UI request: ' + route);
    };
    f.calls = calls; f.sdk = sdk; f.refreshed = () => refreshed;
    const loader = async () => { sdk.loads++; return { payments: () => ({ card: async () => ({ attach: async () => {}, destroy: async () => {}, tokenize: async payload => { sdk.tokens.push(payload); return { status: 'OK', token: 'cnon:test-token' }; } }) }) }; };
    let Component, props;
    if (kind === 'catalog') { Component = f.exports.SquareCatalogCreator; props = { plan: policy(), configured, api: f.api, occupiedCadences, onCreated: async () => { refreshed++; } }; }
    else if (kind === 'coupons') { Component = f.exports.SquareCouponManager; props = { plans, configured, api: f.api }; }
    else if (kind === 'subscription') { Component = f.exports.SubscriptionManager; props = { api: f.api, loadSquare: loader }; }
    else { Component = f.exports.NotificationPlanManager; props = { api: f.api }; }
    await f.render(f.React.createElement(Component, props)); await f.settle();
    f.toggle = async text => f.act(async () => { const label = [...f.container.querySelectorAll('label')].find(item => item.textContent.trim() === text); assert(label, 'missing checkbox ' + text); label.querySelector('input[type=checkbox]').click(); });
    f.consent = async () => f.act(async () => f.container.querySelector('[aria-label="Square料金の作成確認"] input[type=checkbox], [aria-label="契約内容の確認"] input[type=checkbox]').click());
    f.catalogReview = async (amount = '1500') => { await f.click('Square料金プランを作成'); await f.fill(f.field('継続課金の料金'), amount); await f.fill(f.field('請求周期'), 'MONTHLY'); await f.submit(); await f.settle(); };
    f.newCoupon = async () => { await f.click('割引クーポンを管理'); await f.click('クーポンを発行'); };
    f.percentDraft = async () => { await f.fill(f.field('クーポンコード'), 'WELCOME'); await f.fill(f.field('クーポンの表示名'), '初回の割引'); await f.fill(f.field('割引方法'), 'percent'); await f.fill(f.field('割引率'), '20'); await f.toggle('保存済み有償プラン'); await f.toggle('このクーポンを有効にする'); };
    f.subscriptionReview = async code => { await f.act(async () => f.container.querySelector('input[type=radio]').click()); await f.fill(f.field('請求名'), '山田'); await f.fill(f.field('請求先メールアドレス'), 'receipt@example.test'); if (code !== undefined) await f.fill(f.field('クーポンコード'), code); await f.submit(); await f.settle(); };
    return f;
}
const writes = f => f.calls.filter(item => item.method !== 'GET');

test('saved paid-policy cards expose lazy Square creation and coupon management without extra initial API reads', async () => {
    const f = await fixture({ kind: 'parent' });
    try { assert.deepEqual(f.calls.map(item => item.route).sort(), ['billing/admin', 'plans']); assert.match(f.container.textContent, /Square料金プランを作成/); assert.match(f.container.textContent, /割引クーポンを管理/); await f.click('Square料金プランを作成'); assert.equal(f.calls.at(-1).route, 'billing/commerce/admin'); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
test('Square price/cadence have no invented defaults and actual store currency is locked before quote review', async () => {
    const f = await fixture();
    try {
        assert.equal(f.calls.length, 0); await f.click('Square料金プランを作成'); assert.equal(f.field('継続課金の料金').value, ''); assert.equal(f.field('請求周期').value, ''); assert.equal(f.field('料金の通貨').value, 'JPY'); assert.equal(f.field('料金の通貨').readOnly, true); assert.equal(f.field('Squareでの料金プラン名').value, '保存済み有償プラン');
        await f.submit(); assert.equal(writes(f).length, 0); await f.fill(f.field('継続課金の料金'), '1500'); await f.fill(f.field('請求周期'), 'MONTHLY'); await f.submit();
        assert.deepEqual(writes(f)[0], { route: 'billing/catalog/quote', method: 'POST', body: { planId: 'paid_saved', name: '保存済み有償プラン', amount: 1500, currency: 'JPY', cadence: 'MONTHLY' } }); assert.equal(writes(f).length, 1);
        assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '確認してSquareに作成').disabled, true);
    } finally { await f.close(); }
});
test('currency minor-unit input is exact and server-quoted terms are displayed before a single consented creation', async () => {
    const f = await fixture({ initialAdmin: admin({ locationCurrency: 'USD', minorUnitDigits: 2 }), respond: (route, method, body) => route === 'billing/catalog/quote' ? creation({ ...body, name: 'サーバー確認名', amount: 250 }) : undefined });
    try { await f.catalogReview('1.99'); assert.equal(writes(f)[0].body.amount, 199); assert.match(f.container.textContent, /\$2.50/); assert.match(f.container.textContent, /サーバー確認名/); await f.consent(); const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '確認してSquareに作成'); await f.act(async () => { button.click(); button.click(); }); await f.settle(); assert.equal(writes(f).filter(item => item.route === 'billing/catalog/create').length, 1); assert.deepEqual(writes(f).at(-1).body, { creationId: 'creation-1', consent: true }); assert.equal(f.refreshed(), 1); }
    finally { await f.close(); }
});
test('unknown catalog creation blocks new drafts and retries only the same server-permitted creation after explicit status read', async () => {
    let attempts = 0;
    const f = await fixture({ respond: route => { if (route === 'billing/catalog/create' && ++attempts === 1) throw new Error('PRIVATE_SQUARE_FAILURE'); if (route === 'billing/catalog/creation-1') return creation({ state: 'UNKNOWN', retryable: true }); } });
    try {
        await f.catalogReview(); await f.consent(); await f.click('確認してSquareに作成'); assert(!f.container.textContent.includes('PRIVATE_SQUARE_FAILURE')); assert.equal(f.container.querySelector('form'), null); assert.match(f.container.textContent, /新しい作成を始めず/);
        await f.click('Square料金の受付状態を確認'); assert.equal(writes(f).filter(item => item.route === 'billing/catalog/create').length, 1); await f.click('同じ作成内容で再試行'); assert.equal(attempts, 2); assert.deepEqual(writes(f).filter(item => item.route === 'billing/catalog/create').map(item => item.body.creationId), ['creation-1', 'creation-1']);
    } finally { await f.close(); }
});
test('restored pending catalog creation needs renewed consent and cannot silently start another creation', async () => {
    const f = await fixture({ initialAdmin: admin({ creations: [creation({ state: 'UNKNOWN', retryable: true })] }) });
    try { await f.click('Square料金プランを作成'); assert.equal(f.container.querySelector('form'), null); assert.equal(writes(f).length, 0); assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '同じ作成内容で再試行').disabled, true); assert.equal(f.container.querySelector('input[type=checkbox]').checked, false); }
    finally { await f.close(); }
});
test('expired creation quote cannot write Square and returning to input preserves amount and cadence', async () => {
    const f = await fixture({ respond: (route, method, body) => route === 'billing/catalog/quote' ? creation({ ...body, expiresAtMs: 1 }) : undefined });
    try { await f.catalogReview('2100'); await f.consent(); await f.click('確認してSquareに作成'); assert.match(f.container.textContent, /確認期限が切れ/); assert.equal(writes(f).length, 1); await f.click('料金の入力へ戻る'); assert.equal(f.field('継続課金の料金').value, '2100'); assert.equal(f.field('請求周期').value, 'MONTHLY'); }
    finally { await f.close(); }
});
test('coupons load only on request and new discount/code/limit fields preserve blanks instead of invented values', async () => {
    const f = await fixture({ kind: 'coupons' });
    try { assert.equal(f.calls.length, 0); await f.newCoupon(); for (const label of ['クーポンコード', 'クーポンの表示名', '割引率', '有効期限', '全体の利用上限', 'ユーザーごとの利用上限']) assert.equal(f.field(label).value, ''); assert.equal(f.field('割引方法').value, ''); assert.equal(writes(f).length, 0); assert.match(f.container.textContent, /初回請求/); assert.match(f.container.textContent, /次回以降の継続課金は通常料金/); }
    finally { await f.close(); }
});
test('percentage coupon records typed caps, JST expiry and selected paid policies only after before/after confirmation', async () => {
    const f = await fixture({ kind: 'coupons', plans: [policy(), policy({ planId: 'free', label: '無料', tier: 'free' }), policy({ planId: 'supporter', label: '支援者', tier: 'supporter' })] });
    try {
        await f.newCoupon(); await f.percentDraft(); await f.fill(f.field('全体の利用上限'), '100'); await f.fill(f.field('ユーザーごとの利用上限'), '2'); await f.fill(f.field('有効期限'), '2030-02-05T18:30'); await f.submit();
        assert.equal(writes(f).length, 0); assert.match(f.container.querySelector('[aria-label="クーポン設定の変更確認"]').textContent, /20%引き/); assert(![...f.container.querySelectorAll('label')].some(item => item.textContent.trim() === '無料')); await f.click('このクーポン設定で保存');
        assert.deepEqual(writes(f)[0], { route: 'billing/coupons', method: 'POST', body: { code: 'WELCOME', label: '初回の割引', type: 'percent', value: 20, currency: null, planIds: ['paid_saved'], enabled: true, expiresAtMs: Date.parse('2030-02-05T18:30:00+09:00'), totalLimit: 100, userLimit: 2, expectedUpdatedAtMs: null } });
    } finally { await f.close(); }
});
test('percent rejects zero, fractional and 100 percent while cap limits enforce server range without changing the draft', async () => {
    const f = await fixture({ kind: 'coupons' });
    try {
        await f.newCoupon(); await f.percentDraft();
        for (const value of ['', '0', '1.5', '100']) { await f.fill(f.field('割引率'), value); await f.submit(); assert.equal(f.field('割引率').value, value); assert.equal(f.container.querySelector('[aria-label="クーポン設定の変更確認"]'), null); }
        await f.fill(f.field('割引率'), '99'); await f.fill(f.field('全体の利用上限'), '1000001'); await f.submit(); assert.equal(writes(f).length, 0); await f.fill(f.field('全体の利用上限'), ''); await f.submit(); await f.click('このクーポン設定で保存'); assert.equal(writes(f)[0].body.totalLimit, null); assert.equal(writes(f)[0].body.userLimit, null); assert.equal(writes(f)[0].body.value, 99);
    } finally { await f.close(); }
});
test('fixed coupon uses exact minor units and generated codes remain readable and need confirmation before issuance', async () => {
    const f = await fixture({ kind: 'coupons', initialAdmin: admin({ locationCurrency: 'USD', minorUnitDigits: 2 }) });
    try {
        await f.newCoupon(); await f.click('読みやすいコードを生成'); assert.match(f.field('クーポンコード').value, /^CBTE-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/); const generated = f.field('クーポンコード').value;
        await f.fill(f.field('クーポンの表示名'), '初回固定額'); await f.fill(f.field('割引方法'), 'fixed'); await f.fill(f.field('割引額の通貨'), 'USD'); await f.fill(f.field('割引金額'), '1.99'); await f.toggle('保存済み有償プラン'); await f.submit(); assert.equal(writes(f).length, 0); await f.click('このクーポン設定で保存'); assert.equal(writes(f)[0].body.value, 199); assert.equal(writes(f)[0].body.currency, 'USD'); assert.equal(writes(f)[0].body.code, generated);
    } finally { await f.close(); }
});
test('existing coupon code is immutable and usage/reservations come from server while stale CAS reload keeps current edits', async () => {
    let failed = false, loads = 0;
    const f = await fixture({ kind: 'coupons', respond: (route, method) => { if (route === 'billing/commerce/admin') return admin({ coupons: [coupon({ value: ++loads > 1 ? 30 : 20, updatedAtMs: loads > 1 ? 102 : 100 })] }); if (route === 'billing/coupons/WELCOME' && !failed) { failed = true; throw Object.assign(new Error('PRIVATE_CAS'), { status: 409 }); } } });
    try {
        await f.click('割引クーポンを管理'); assert.equal(f.field('クーポンコード').readOnly, true); assert.match(f.container.textContent, /確定した利用 2件 · 受付中の予約 1件/); await f.fill(f.field('割引率'), '25'); await f.submit(); await f.click('このクーポン設定で保存'); assert.equal(f.field('割引率').value, '25'); assert(!f.container.textContent.includes('PRIVATE_CAS')); await f.click('最新のクーポンを再取得'); assert.equal(f.field('割引率').value, '25'); await f.submit(); assert.match(f.container.querySelector('[aria-label="クーポン設定の変更確認"]').textContent, /30%引き25%引き/); await f.click('このクーポン設定で保存'); assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 102);
    } finally { await f.close(); }
});
test('an updated coupon baseline invalidates previously reviewed edits until review is repeated', async () => {
    let reads = 0;
    const f = await fixture({ kind: 'coupons', respond: (route, method) => route === 'billing/commerce/admin' && method === 'GET' ? admin({ coupons: [coupon({ updatedAtMs: ++reads })] }) : undefined });
    try { await f.click('割引クーポンを管理'); await f.fill(f.field('割引率'), '25'); await f.submit(); await f.click('クーポン一覧を更新'); const save = [...f.container.querySelectorAll('button')].find(item => item.textContent === 'このクーポン設定で保存'); assert.equal(save.disabled, true); assert.equal(f.field('割引率').value, '25'); await f.click('クーポンの編集に戻る'); await f.submit(); await f.click('このクーポン設定で保存'); assert.equal(writes(f)[0].body.expectedUpdatedAtMs, 2); }
    finally { await f.close(); }
});
test('coupon expiry explicitly uses JST and rejects invalid calendar rollovers', async () => {
    const f = await fixture({ kind: 'coupons' });
    try { assert.equal(f.exports.couponExpiry('2030-02-05T18:30'), Date.parse('2030-02-05T18:30:00+09:00')); assert.equal(f.exports.couponExpiry('2030-02-30T18:30'), null); assert.equal(f.exports.couponExpiry('not-a-date'), null); }
    finally { await f.close(); }
});
test('coupon checkout sends only the optional code and displays frozen first-invoice and subsequent regular amounts before consent', async () => {
    const f = await fixture({ kind: 'subscription', quotedPlan: subscriptionPlan({ firstAmount: 1200, regularAmount: 1500, coupon: { code: 'WELCOME', label: '初回の割引', type: 'percent', value: 20, discountAmount: 300 } }) });
    try {
        await f.subscriptionReview('WELCOME'); assert.deepEqual(writes(f)[0].body, { planId: 'paid_saved', variationId: 'BASE_VARIATION', email: 'receipt@example.test', name: '山田', couponCode: 'WELCOME' }); assert.match(f.container.textContent, /初回請求: ￥1,200/); assert.match(f.container.textContent, /次回以降の通常料金: ￥1,500 · 毎月/); assert.match(f.container.textContent, /初回請求の1回だけ/); assert.match(f.container.textContent, /初回は￥1,200、次回以降は通常料金の￥1,500が毎月継続課金/); assert.equal(f.sdk.tokens.length, 0); await f.consent(); await f.click('同意してサブスクリプションを契約'); assert.equal(f.sdk.tokens.length, 1); assert.deepEqual(writes(f).at(-1).body, { checkoutId: 'checkout-1', sourceId: 'cnon:test-token', consent: true });
    } finally { await f.close(); }
});
test('coupon quote failures preserve code and personal details without silently falling back to full-price subscription', async () => {
    const f = await fixture({ kind: 'subscription', respond: route => { if (route === 'quote') throw Object.assign(new Error('このクーポンは期限切れです。'), { code: 'SQUARE_COUPON_EXPIRED' }); } });
    try { await f.subscriptionReview('EXPIRED'); assert.match(f.container.textContent, /期限切れ/); assert.equal(f.field('クーポンコード').value, 'EXPIRED'); assert.equal(f.field('請求先メールアドレス').value, 'receipt@example.test'); assert.equal(f.sdk.loads, 0); assert.equal(writes(f).length, 1); assert.equal(f.container.querySelector('[aria-label="契約内容の確認"]'), null); }
    finally { await f.close(); }
});
test('malformed or unsupported zero initial invoice disables card collection and subscription rather than inventing a first amount', async () => {
    for (const firstAmount of [0, undefined, 1500]) {
        const f = await fixture({ kind: 'subscription', quotedPlan: subscriptionPlan({ firstAmount, regularAmount: 1500, coupon: { code: 'WELCOME', label: '初回の割引', type: 'percent', value: 20, discountAmount: 300 } }) });
        try { await f.subscriptionReview('WELCOME'); assert.match(f.container.textContent, /初回請求額を確認できません/); assert.equal(f.sdk.loads, 0); const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '同意してサブスクリプションを契約'); assert.equal(button.disabled, true); assert.equal(writes(f).filter(item => item.route === 'subscribe').length, 0); }
        finally { await f.close(); }
    }
});
test('unconfigured Square disables admin write entry points and performs no commerce request', async () => {
    for (const kind of ['catalog', 'coupons']) { const f = await fixture({ kind, configured: false }); try { assert.equal(f.container.querySelector('button').disabled, true); assert.equal(f.calls.length, 0); } finally { await f.close(); } }
});
test('pausing an expired coupon preserves its exact existing expiry including sub-minute precision', async () => {
    const expired = Date.parse('2020-02-05T18:30:41.123+09:00');
    const f = await fixture({ kind: 'coupons', initialAdmin: admin({ coupons: [coupon({ expiresAtMs: expired })] }) });
    try { await f.click('割引クーポンを管理'); await f.toggle('このクーポンを有効にする'); await f.submit(); await f.click('このクーポン設定で保存'); assert.equal(writes(f)[0].body.enabled, false); assert.equal(writes(f)[0].body.expiresAtMs, expired); }
    finally { await f.close(); }
});
test('an anchored/prorated plan explains coupon unavailability and preserves the code until the user explicitly clears it', async () => {
    const f = await fixture({ kind: 'subscription', respond: route => route === 'options' ? { configured: true, environment: 'sandbox', applicationId: 'sandbox-app', locationId: 'location', plans: [subscriptionPlan({ billingAnchorDay: 15, canProrate: true })] } : undefined });
    try { await f.subscriptionReview('WELCOME'); assert.match(f.container.textContent, /日割り・固定課金日のあるプランはクーポンに未対応/); assert.equal(f.field('クーポンコード').value, 'WELCOME'); assert.equal(writes(f).length, 0); await f.fill(f.field('クーポンコード'), ''); await f.submit(); assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].body.couponCode, undefined); }
    finally { await f.close(); }
});


test('an existing monthly binding still permits a separate annual Square price but blocks duplicate monthly creation', async () => {
    const f = await fixture({ occupiedCadences: ['MONTHLY'] });
    try {
        await f.click('Square料金プランを作成'); await f.fill(f.field('継続課金の料金'), '10000');
        const cadence = f.field('請求周期'); assert.equal([...cadence.options].find(option => option.value === 'MONTHLY').disabled, true);
        await f.fill(cadence, 'MONTHLY'); await f.submit(); assert.equal(writes(f).length, 0);
        await f.fill(cadence, 'ANNUAL'); await f.submit();
        assert.deepEqual(writes(f)[0].body, { planId: 'paid_saved', name: '保存済み有償プラン', amount: 10000, currency: 'JPY', cadence: 'ANNUAL' });
        assert.match(f.container.querySelector('[aria-label="Square料金の作成確認"]').textContent, /￥10,000 · 毎年/);
        await f.consent(); await f.click('確認してSquareに作成'); assert.equal(f.refreshed(), 1);
    } finally { await f.close(); }
});
