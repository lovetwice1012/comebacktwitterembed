'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const plan = (changes = {}) => ({ planId: 'configured', label: '管理者設定プラン', slotLimit: 12, minuteLimit: 9, dayLimit: 96, priority: 3, variationId: 'VARIATION', catalogName: 'Square月額設定', cadence: 'MONTHLY', amount: 1500, currency: 'JPY', ...changes });
const options = (changes = {}) => ({ configured: true, environment: 'sandbox', applicationId: 'sandbox-app', locationId: 'location', plans: [plan()], ...changes });
const status = (changes = {}) => ({ configured: true, environment: 'sandbox', subscription: null, pending: null, ...changes });
const contract = (changes = {}) => ({ planId: 'configured', label: '管理者設定プラン', state: 'ACTIVE', paidThroughAtMs: 1794423600000, validUntilAtMs: 1794423600000, canceledDate: null, active: true, cancelScheduled: false, ...changes });
async function fixture({ initialOptions = options(), initialStatus = status(), respond, squareLoader, tokenize } = {}) {
    const f = await reactFixture('export { SubscriptionManager, subscriptionPrice, loadSquareSubscriptionSDK } from "./components/automation/subscription-manager";');
    const calls = [], sdk = { loads: [], payments: [], attached: [], destroyed: [], tokens: [] };
    let quoteIndex = 0;
    f.api = async (route, method = 'GET', body) => {
        calls.push({ route, method, body });
        const result = respond && await respond(route, method, body, f);
        if (result !== undefined) return result;
        if (route === 'options') return initialOptions;
        if (route === 'status') return initialStatus;
        if (route === 'quote') return { checkoutId: `checkout-${++quoteIndex}`, expiresAtMs: Date.now() + 60000, plan: plan(), email: body.email, name: body.name };
        if (route === 'subscribe') return status({ subscription: contract({ active: false, paidThroughAtMs: null, validUntilAtMs: null }) });
        if (route === 'cancel') return status({ subscription: contract({ cancelScheduled: true, canceledDate: '2026-11-13' }) });
        throw new Error('Unexpected API request');
    };
    const loader = async environment => {
        sdk.loads.push(environment);
        if (squareLoader) return squareLoader(environment, f);
        return { payments: (app, location) => { sdk.payments.push({ app, location }); return { card: async () => ({ attach: async selector => sdk.attached.push(selector), destroy: async () => sdk.destroyed.push('card'), tokenize: async data => { sdk.tokens.push(data); return tokenize ? tokenize(data) : { status: 'OK', token: 'cnon:private-nonce' }; } }) }; } };
    };
    f.calls = calls; f.sdk = sdk;
    await f.render(f.React.createElement(f.exports.SubscriptionManager, { api: f.api, loadSquare: loader })); await f.settle();
    f.select = async () => f.act(async () => f.container.querySelector('input[type=radio]').click());
    f.consent = async () => f.act(async () => f.container.querySelector('input[type=checkbox]').click());
    f.review = async () => { await f.select(); await f.fill(f.field('請求名'), '山田 太郎'); await f.fill(f.field('請求先メールアドレス'), 'receipt@example.test'); await f.click('契約内容を確認'); await f.settle(); };
    return f;
}
const writes = f => f.calls.filter(call => call.method !== 'GET');

test('subscription page requires a user session and the workspace exposes a real payment route', () => {
    const root = path.resolve(__dirname, '../..');
    const page = fs.readFileSync(path.join(root, 'dashboard/app/dashboard/automation/plans/page.tsx'), 'utf8');
    assert.match(page, /await requireDashboardSession\(\)/); assert.match(page, /key=\{session\.user\.id\}/);
    assert.match(fs.readFileSync(path.join(root, 'dashboard/components/automation/automation-workspace.tsx'), 'utf8'), /href="\/dashboard\/automation\/plans"/);
});

test('unconfigured Square leaves free notifications available, never loads the card SDK and supports reloading', async () => {
    const f = await fixture({ initialOptions: options({ configured: false, plans: [] }), initialStatus: status({ configured: false }) });
    try {
        assert.match(f.container.textContent, /無料枠の通知を引き続き利用/); assert.equal(f.container.querySelector('input[type=radio]'), null);
        assert.equal(f.sdk.loads.length, 0); assert.equal(writes(f).length, 0); await f.click('再読み込み'); assert.equal(f.calls.filter(call => call.route === 'status').length, 2);
    } finally { await f.close(); }
});

test('plan selection shows server prices and quota, then loads Square only after quote review and holds payment behind explicit consent', async () => {
    const f = await fixture();
    try {
        assert.match(f.container.textContent, /￥1,500毎月/); assert.match(f.container.textContent, /通知12枠.*1日96通・1分9通/); assert.equal(f.sdk.loads.length, 0);
        await f.review(); assert.deepEqual(writes(f), [{ route: 'quote', method: 'POST', body: { planId: 'configured', email: 'receipt@example.test', name: '山田 太郎' } }]);
        assert.deepEqual(f.sdk.loads, ['sandbox']); assert.deepEqual(f.sdk.payments, [{ app: 'sandbox-app', location: 'location' }]); assert.equal(f.sdk.attached.length, 1);
        const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '同意してサブスクリプションを契約'); assert.equal(button.disabled, true);
        assert.match(f.container.textContent, /カードをSquareに保存.*￥1,500が毎月継続課金/); assert.equal(f.sdk.tokens.length, 0);
        await f.consent(); assert.equal(button.disabled, false);
    } finally { await f.close(); }
});

test('quote review explains the catalog monthly charge day and an unconfirmed prorated first amount before card-storage consent, without inventing a charge', async () => {
    const f = await fixture({ respond: async (route, method, body) => route === 'quote' ? { checkoutId: 'anchored-quote', expiresAtMs: Date.now() + 60000, plan: plan({ billingAnchorDay: 15, canProrate: true }), email: body.email, name: body.name } : undefined });
    try {
        await f.review(); const review = f.container.querySelector('[aria-label="契約内容の確認"]'); assert(review);
        assert.match(review.textContent, /毎月15日が課金日/); assert.match(review.textContent, /初回は日割り.*定期料金と異なる場合.*初回の請求額はSquareが確定/);
        assert(review.textContent.indexOf('初回は日割り') < review.textContent.indexOf('カードをSquareに保存'));
        assert.match(review.textContent, /￥1,500毎月/); assert(!review.textContent.includes('￥750')); assert.equal(review.querySelector('input[type=checkbox]').checked, false);
        assert.equal(writes(f).filter(call => call.route === 'subscribe').length, 0); assert.equal(f.sdk.tokens.length, 0);
    } finally { await f.close(); }
});

test('physical money amounts use correct JPY, USD and three-decimal currency scales', async () => {
    const f = await fixture();
    try { assert.equal(f.exports.subscriptionPrice(plan()), '￥1,500'); assert.equal(f.exports.subscriptionPrice(plan({ amount: 199, currency: 'USD' })), '$1.99'); assert.match(f.exports.subscriptionPrice(plan({ amount: 1234, currency: 'KWD' })), /1\.234/); assert.equal(f.exports.subscriptionPrice(plan({ amount: -1 })), '料金を確認できません'); }
    finally { await f.close(); }
});

test('double clicking submits one token and one checkout, stores no nonce and awaits payment confirmation before granting a success claim', async () => {
    let complete;
    const f = await fixture({ respond: async route => route === 'subscribe' ? new Promise(resolve => { complete = resolve; }) : undefined });
    try {
        await f.review(); await f.consent(); const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '同意してサブスクリプションを契約');
        await f.act(async () => { button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); });
        assert.equal(f.sdk.tokens.length, 1); assert.deepEqual(f.sdk.tokens[0], { intent: 'STORE', customerInitiated: true, sellerKeyedIn: false, billingContact: { email: 'receipt@example.test', givenName: '山田 太郎', countryCode: 'JP' }, currencyCode: 'JPY' });
        assert.equal(writes(f).filter(call => call.route === 'subscribe').length, 1); assert.deepEqual(writes(f).at(-1).body, { checkoutId: 'checkout-1', sourceId: 'cnon:private-nonce', consent: true });
        assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0); assert(!f.container.textContent.includes('cnon:private-nonce'));
        await f.act(async () => complete(status({ subscription: contract({ active: false, paidThroughAtMs: null, validUntilAtMs: null }) })));
        assert.match(f.container.textContent, /支払い確認後に通知枠へ適用/); assert.match(f.container.textContent, /支払い・契約状態を確認中/); assert(!f.container.textContent.includes('利用中')); assert.equal(f.sdk.destroyed.length, 1);
    } finally { await f.close(); }
});

test('an uncertain result allows only the exact retained checkout/token to be retried when the server explicitly permits it', async () => {
    let failed = false;
    const f = await fixture({ respond: async route => {
        if (route === 'subscribe' && !failed) { failed = true; throw new Error('PRIVATE_SQUARE_UNKNOWN'); }
        if (route === 'status' && failed) return status({ pending: { checkoutId: 'checkout-1', state: 'CARD_SUBMITTING', retryable: true } });
    } });
    try {
        await f.review(); await f.consent(); await f.click('同意してサブスクリプションを契約');
        assert.match(f.container.textContent, /新しい支払いを始めず/); assert(!f.container.textContent.includes('PRIVATE_SQUARE_UNKNOWN')); assert.equal(f.container.querySelector('input[type=radio]'), null);
        await f.click('同じ受付内容で再試行'); const attempts = writes(f).filter(call => call.route === 'subscribe'); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, attempts[1].body);
        assert.equal(f.sdk.tokens.length, 1); assert.equal(f.sdk.loads.length, 1);
    } finally { await f.close(); }
});

test('an unknown non-retryable result remains blocked and checking status never reissues payment', async () => {
    let failed = false;
    const f = await fixture({ respond: async route => {
        if (route === 'subscribe') { failed = true; throw new Error('Unknown'); }
        if (route === 'status' && failed) return status({ pending: { checkoutId: 'checkout-1', state: 'SUBSCRIPTION_SUBMITTING', retryable: false } });
    } });
    try {
        await f.review(); await f.consent(); await f.click('同意してサブスクリプションを契約'); assert(!f.container.textContent.includes('同じ受付内容で再試行'));
        await f.click('受付状態を再確認'); assert.equal(writes(f).filter(call => call.route === 'subscribe').length, 1); assert.equal(f.container.querySelector('input[type=radio]'), null);
    } finally { await f.close(); }
});

test('after a reload the server pending record has no local nonce, so even retryable state offers only status checks', async () => {
    const f = await fixture({ initialStatus: status({ pending: { checkoutId: 'old-checkout', state: 'CARD_SUBMITTING', retryable: true } }) });
    try { assert.match(f.container.textContent, /受付済みの処理/); assert(!f.container.textContent.includes('同じ受付内容で再試行')); assert.equal(f.sdk.loads.length, 0); await f.click('受付状態を再確認'); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});

test('an existing verified subscription blocks a new contract and cancellation requires an explicit second confirmation', async () => {
    const f = await fixture({ initialStatus: status({ subscription: contract() }) });
    try {
        assert.match(f.container.textContent, /現在の契約: 管理者設定プラン/); assert.match(f.container.textContent, /利用中/); assert.match(f.container.textContent, /JST/); assert.equal(f.container.querySelector('input[type=radio]'), null);
        await f.click('サブスクリプションを解約'); assert.equal(writes(f).length, 0); await f.click('解約を申し込む'); assert.deepEqual(writes(f), [{ route: 'cancel', method: 'POST', body: {} }]);
        assert.match(f.container.textContent, /解約予定/); assert.equal(f.sdk.loads.length, 0);
    } finally { await f.close(); }
});

test('a terminated expired subscription allows a new quote, while a canceled contract inside its paid period still blocks enrollment', async () => {
    const expired = await fixture({ initialStatus: status({ subscription: contract({ state: 'CANCELED', active: false, cancelScheduled: true, validUntilAtMs: Date.now() - 1000 }) }) });
    try { assert.match(expired.container.textContent, /利用期限終了.*新しいプランを契約できます/); await expired.review(); assert.equal(writes(expired).filter(call => call.route === 'quote').length, 1); assert.equal(expired.sdk.attached.length, 1); }
    finally { await expired.close(); }
    const stillPaid = await fixture({ initialStatus: status({ subscription: contract({ state: 'CANCELED', active: true, cancelScheduled: true, validUntilAtMs: Date.now() + 60000 }) }) });
    try { assert.match(stillPaid.container.textContent, /解約予定/); assert.equal(stillPaid.container.querySelector('input[type=radio]'), null); assert.equal(writes(stillPaid).length, 0); }
    finally { await stillPaid.close(); }
});

test('an ACTIVE but unpaid subscription cannot be replaced just because active is false or its benefit deadline is absent', async () => {
    const f = await fixture({ initialStatus: status({ subscription: contract({ state: 'ACTIVE', active: false, validUntilAtMs: null, paidThroughAtMs: null }) }) });
    try { assert.equal(f.container.querySelector('input[type=radio]'), null); assert.match(f.container.textContent, /支払い・契約状態を確認中/); assert.equal(f.sdk.loads.length, 0); }
    finally { await f.close(); }
});

test('card validation failures hide raw Square details and never create a subscription or lose the quoted plan', async () => {
    const f = await fixture({ tokenize: async () => ({ status: 'ERROR', errors: [{ detail: 'PRIVATE_CARD_NUMBER' }] }) });
    try {
        await f.review(); await f.consent(); await f.click('同意してサブスクリプションを契約'); assert.match(f.container.textContent, /カード情報を確認/); assert(!f.container.textContent.includes('PRIVATE_CARD_NUMBER'));
        assert.equal(writes(f).filter(call => call.route === 'subscribe').length, 0); assert(f.container.querySelector('[aria-label="契約内容の確認"]'));
    } finally { await f.close(); }
});

test('late card creation destroys the abandoned frame and cannot attach to a different quote', async () => {
    let finishOld, cardFactories = 0, oldAttached = 0, oldDestroyed = 0, newAttached = 0, newDestroyed = 0;
    const f = await fixture({ squareLoader: async () => ({ payments: () => ({ card: async () => ++cardFactories === 1 ? new Promise(resolve => { finishOld = resolve; }) : { attach: async () => newAttached++, destroy: async () => newDestroyed++, tokenize: async () => ({ status: 'OK', token: 'cnon:new' }) } }) }) });
    try {
        await f.review(); await f.click('プランの選択に戻る'); await f.review();
        await f.act(async () => finishOld({ attach: async () => oldAttached++, destroy: async () => oldDestroyed++, tokenize: async () => ({ status: 'OK', token: 'cnon:old' }) }));
        assert.equal(oldAttached, 0); assert.equal(oldDestroyed, 1); assert.equal(newAttached, 1); assert.equal(newDestroyed, 0);
        await f.click('プランの選択に戻る'); assert.equal(newDestroyed, 1);
    } finally { await f.close(); }
});

test('expired quotes cannot tokenize or charge and explain how to refresh the displayed price', async () => {
    const f = await fixture({ respond: async (route, method, body) => route === 'quote' ? { checkoutId: 'expired', expiresAtMs: Date.now() - 1, plan: plan(), email: body.email } : undefined });
    try { await f.review(); await f.consent(); await f.click('同意してサブスクリプションを契約'); assert.match(f.container.textContent, /確認期限が切れました/); assert.equal(f.sdk.tokens.length, 0); assert.equal(writes(f).filter(call => call.route === 'subscribe').length, 0); }
    finally { await f.close(); }
});

test('a status read failure during refresh keeps the quoted form but disables subscription until status is checked again', async () => {
    let statusReads = 0;
    const f = await fixture({ respond: async route => { if (route === 'status' && ++statusReads === 2) throw new Error('PRIVATE_STATUS_FAILURE'); } });
    try {
        await f.review(); await f.consent(); await f.click('再読み込み'); const review = f.container.querySelector('[aria-label="契約内容の確認"]'); assert(review);
        assert.match(f.container.textContent, /契約状態を確認できません/); assert(!f.container.textContent.includes('PRIVATE_STATUS_FAILURE'));
        assert.equal([...f.container.querySelectorAll('button')].find(node => node.textContent === '同意してサブスクリプションを契約').disabled, true); assert.equal(f.sdk.tokens.length, 0);
        await f.click('再読み込み'); assert.equal([...f.container.querySelectorAll('button')].find(node => node.textContent === '同意してサブスクリプションを契約').disabled, false);
    } finally { await f.close(); }
});
