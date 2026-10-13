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
// The production Square SDK rejects these fields for STORE before it reads the card form.
// https://developer.squareup.com/reference/sdks/web/payments/objects/StoreCardVerificationDetails
function squareStoreToken(data, token = 'cnon:private-nonce') {
    const errors = ['amount', 'currencyCode', 'total'].filter(field => field in data).map(field => ({
        field: `verificationDetails.${field}`, message: `The STORE intent does not support the ${field} field.`, type: 'VALIDATION_ERROR',
    }));
    return errors.length ? { status: 'Invalid', errors } : { status: 'OK', token };
}
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
        return { payments: (app, location) => { sdk.payments.push({ app, location }); return { card: async () => ({ attach: async selector => sdk.attached.push(selector), destroy: async () => sdk.destroyed.push('card'), tokenize: async data => { sdk.tokens.push(data); return tokenize ? tokenize(data) : squareStoreToken(data); } }) }; } };
    };
    f.calls = calls; f.sdk = sdk;
    await f.render(f.React.createElement(f.exports.SubscriptionManager, { api: f.api, loadSquare: loader })); await f.settle();
    f.select = async () => f.act(async () => f.container.querySelector('input[type=radio]').click());
    f.consent = async () => f.act(async () => f.container.querySelector('input[type=checkbox]').click());
    f.review = async () => { await f.select(); await f.fill(f.field('請求名'), '山田 太郎'); await f.fill(f.field('請求先メールアドレス'), 'receipt@example.test'); await f.click('契約内容を確認'); await f.settle(); };
    return f;
}
const writes = f => f.calls.filter(call => call.method !== 'GET');
const pendingCheckout = (changes = {}) => ({ checkoutId: 'old-checkout', state: 'CARD_STORED', retryable: false, resumeAllowed: true, abortAllowed: true,
    quote: { checkoutId: 'old-checkout', expiresAtMs: Date.now() - 60000, plan: plan(), email: 'saved@example.test', name: '保存された請求名' }, ...changes });

test('subscription submit handler rejects overlength and ambiguous email separators while preserving Unicode subdomains', async () => {
    const f = await fixture();
    try {
        await f.select(); await f.fill(f.field('請求名'), '山田');
        for (const value of ['a'.repeat(243) + '@example.com', 'user@@example.test', 'user@domain', 'user name@example.test']) { await f.fill(f.field('請求先メールアドレス'), value); await f.submit(); assert.equal(writes(f).length, 0); }
        await f.fill(f.field('請求先メールアドレス'), '利用者@payments.例え.テスト'); await f.submit(); assert.equal(writes(f)[0].body.email, '利用者@payments.例え.テスト');
    } finally { await f.close(); }
});

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
        assert.equal(f.sdk.tokens.length, 1); assert.deepEqual(f.sdk.tokens[0], { intent: 'STORE', customerInitiated: true, sellerKeyedIn: false, billingContact: { email: 'receipt@example.test', givenName: '山田 太郎', countryCode: 'JP' } });
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

test('Square STORE protocol rejects the previous currency field and the reviewed contract submits with valid card-storage details', async () => {
    const original = { intent: 'STORE', customerInitiated: true, sellerKeyedIn: false, billingContact: { email: 'receipt@example.test', givenName: '山田 太郎', countryCode: 'JP' }, currencyCode: 'JPY' };
    assert.deepEqual(squareStoreToken(original), { status: 'Invalid', errors: [{ field: 'verificationDetails.currencyCode', message: 'The STORE intent does not support the currencyCode field.', type: 'VALIDATION_ERROR' }] });
    const valid = { intent: original.intent, customerInitiated: original.customerInitiated, sellerKeyedIn: original.sellerKeyedIn, billingContact: original.billingContact };
    for (const field of ['amount', 'currencyCode', 'total']) {
        const rejected = squareStoreToken({ ...valid, [field]: undefined });
        assert.equal(rejected.status, 'Invalid'); assert.equal(rejected.errors[0].field, `verificationDetails.${field}`);
    }
    const f = await fixture();
    try {
        await f.review(); await f.consent(); await f.click('同意してサブスクリプションを契約');
        assert.equal(f.sdk.tokens.length, 1); assert.equal(squareStoreToken(f.sdk.tokens[0]).status, 'OK');
        for (const field of ['amount', 'currencyCode', 'total']) assert.equal(field in f.sdk.tokens[0], false);
        assert.deepEqual(writes(f).filter(call => call.route === 'subscribe'), [{ route: 'subscribe', method: 'POST', body: { checkoutId: 'checkout-1', sourceId: 'cnon:private-nonce', consent: true } }]);
        assert.match(f.container.textContent, /支払い・契約状態を確認中/);
    } finally { await f.close(); }
});

test('tokenization failures distinguish service configuration, card validation, interruption and unavailable verification without exposing Square details', async () => {
    const cases = [
        { result: { status: 'Invalid', errors: [{ field: 'verificationDetails.currencyCode', type: 'VALIDATION_ERROR', message: 'PRIVATE_CARD_NUMBER' }] }, expected: /サービスのカード受付設定に問題.*運営側での修正/ },
        { result: { status: 'Invalid', errors: [{ field: 'cardNumber', type: 'VALIDATION_ERROR', message: 'PRIVATE_CARD_NUMBER' }] }, expected: /カード情報の入力内容を確認/ },
        { result: { status: 'Invalid' }, expected: /カード情報の入力内容を確認/ },
        { result: { status: 'Error', errors: [{ type: 'PRIVATE_CARD_NUMBER', message: 'PRIVATE_CARD_NUMBER' }] }, expected: /Squareでカード情報を確認できません.*時間をおいて/ },
        { result: { status: 'Unknown' }, expected: /Squareでカード情報を確認できません/ },
        { result: { status: 'Cancel' }, expected: /カードの本人認証が中止.*本人認証を完了/ },
        { result: { status: 'Abort' }, expected: /カードの本人認証が中止.*本人認証を完了/ },
        { result: { status: 'OK' }, expected: /Squareでカード情報を確認できません/ },
    ];
    for (const { result, expected } of cases) {
        const f = await fixture({ tokenize: async () => result });
        try {
            await f.review(); await f.consent(); await f.click('同意してサブスクリプションを契約');
            assert.match(f.container.textContent, expected); assert.match(f.container.textContent, /支払いは実行されていません/);
            assert(!f.container.textContent.includes('PRIVATE_CARD_NUMBER')); assert(!f.container.textContent.includes('VALIDATION_ERROR')); assert(!f.container.textContent.includes('verificationDetails.currencyCode'));
            assert.equal(writes(f).filter(call => call.route === 'subscribe').length, 0); assert(f.container.querySelector('[aria-label="契約内容の確認"]'));
            assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0);
        } finally { await f.close(); }
    }
});

test('retrying a failed card verification requests a new token and never sends an unsuccessful result token to subscription creation', async () => {
    let attempts = 0;
    const f = await fixture({ tokenize: async data => ++attempts === 1 ? { status: 'Invalid', token: 'cnon:failed-private-token', errors: [{ field: 'cvv', message: 'PRIVATE_CVV' }] } : squareStoreToken(data, 'cnon:fresh-private-token') });
    try {
        await f.review(); await f.consent(); await f.click('同意してサブスクリプションを契約');
        assert.equal(writes(f).filter(call => call.route === 'subscribe').length, 0); assert.match(f.container.textContent, /カード情報の入力内容を確認/);
        await f.click('同意してサブスクリプションを契約');
        assert.equal(f.sdk.tokens.length, 2); assert.deepEqual(writes(f).filter(call => call.route === 'subscribe'), [{ route: 'subscribe', method: 'POST', body: { checkoutId: 'checkout-1', sourceId: 'cnon:fresh-private-token', consent: true } }]);
        for (const secret of ['cnon:failed-private-token', 'cnon:fresh-private-token', 'PRIVATE_CVV']) assert(!f.container.textContent.includes(secret));
        assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0);
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

test('reload restores frozen stored-card terms including charge-day flags and renewed consent resumes the original checkout without a nonce or SDK', async () => {
    let release;
    const pending = pendingCheckout({ quote: { ...pendingCheckout().quote, plan: plan({ billingAnchorDay: 12, canProrate: true }) } });
    const f = await fixture({ initialStatus: status({ pending }), respond: async route => {
        if (route === 'resume') { await new Promise(resolve => { release = resolve; }); return status({ subscription: contract({ active: false, paidThroughAtMs: null, validUntilAtMs: null }) }); }
    } });
    try {
        assert.match(f.container.textContent, /保存された請求名.*saved@example.test/); assert.match(f.container.textContent, /毎月12日が課金日/); assert.match(f.container.textContent, /初回は日割り/);
        assert.equal(f.sdk.loads.length, 0); assert.equal(writes(f).length, 0);
        const button = [...f.container.querySelectorAll('button')].find(node => node.textContent === '保存済みカードで契約を再開'); assert.equal(button.disabled, true);
        await f.consent(); await f.act(async () => { button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); });
        assert.deepEqual(writes(f), [{ route: 'resume', method: 'POST', body: { checkoutId: 'old-checkout', consent: true } }]);
        assert.equal(f.sdk.tokens.length, 0); assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0);
        await f.act(async () => release()); assert.match(f.container.textContent, /支払い・契約状態を確認中/); assert(!f.container.textContent.includes('利用中'));
    } finally { if (release) release(); await f.close(); }
});

test('retryable stage alone never exposes nonce-free resume, and malformed initial-discount money cannot resume or collect a card', async () => {
    const unsafe = await fixture({ initialStatus: status({ pending: pendingCheckout({ resumeAllowed: false, abortAllowed: false, retryable: true }) }) });
    try { assert.equal(unsafe.container.querySelector('[aria-label="受付済み契約の再開確認"]'), null); assert.equal(unsafe.container.querySelector('input[type=checkbox]'), null); assert.equal(unsafe.sdk.loads.length, 0); assert.equal(writes(unsafe).length, 0); }
    finally { await unsafe.close(); }
    const coupon = { code: 'FIRST', label: '初回だけ', type: 'fixed', value: 1500, discountAmount: 1500 };
    const f = await fixture({ initialStatus: status({ pending: pendingCheckout({ quote: { ...pendingCheckout().quote, plan: plan({ coupon, firstAmount: 0, regularAmount: 1500 }) } }) }) });
    try {
        assert.match(f.container.textContent, /初回請求額を確認できません/);
        assert.equal(f.container.querySelector('input[type=checkbox]').disabled, true);
        const button = [...f.container.querySelectorAll('button')].find(node => node.textContent === '保存済みカードで契約を再開'); assert.equal(button.disabled, true);
        await f.click('保存済みカードで契約を再開'); assert.equal(writes(f).length, 0); assert.equal(f.sdk.loads.length, 0);
    } finally { await f.close(); }
});

test('stale resume refreshes capabilities and changed frozen terms require fresh consent before another original-checkout attempt', async () => {
    let attempts = 0;
    const coupon = { code: 'FIRST', label: '初回だけ', type: 'percent', value: 20, discountAmount: 300 };
    const pending = pendingCheckout({ quote: { ...pendingCheckout().quote, plan: plan({ coupon, firstAmount: 1200, regularAmount: 1500 }) } });
    const changed = pendingCheckout({ quote: { ...pending.quote, plan: plan({ amount: 2500 }) } });
    const f = await fixture({ initialStatus: status({ pending }), respond: async route => {
        if (route === 'resume') { if (++attempts === 1) throw Object.assign(new Error('stale'), { status: 409, code: 'SQUARE_CHECKOUT_PENDING' }); return status({ subscription: contract({ active: false }) }); }
        if (route === 'status' && attempts) return status({ pending: changed });
    } });
    try {
        assert.match(f.container.textContent, /初回請求: ￥1,200/); await f.consent(); await f.click('保存済みカードで契約を再開');
        assert.equal(f.calls.filter(call => call.route === 'status').length, 2); assert.match(f.container.textContent, /￥2,500/);
        assert.equal(f.container.querySelector('input[type=checkbox]').checked, false);
        await f.click('保存済みカードで契約を再開'); assert.equal(writes(f).length, 1);
        await f.consent(); await f.click('保存済みカードで契約を再開'); assert.equal(writes(f).length, 2); assert(writes(f).every(call => call.body.checkoutId === 'old-checkout' && !Object.hasOwn(call.body, 'sourceId')));
    } finally { await f.close(); }
});

test('only server-permitted pre-enrollment abort needs a second confirmation and returns to the retained contact, plan and coupon draft', async () => {
    const coupon = { code: 'FIRST', label: '初回だけ', type: 'percent', value: 20, discountAmount: 300 };
    const pending = pendingCheckout({ state: 'CUSTOMER_READY', resumeAllowed: false, quote: { ...pendingCheckout().quote, plan: plan({ coupon, firstAmount: 1200, regularAmount: 1500 }) } });
    const f = await fixture({ initialStatus: status({ pending }), respond: async route => route === 'abort' ? status() : undefined });
    try {
        await f.click('申し込みを中止してやり直す'); assert.equal(writes(f).length, 0); assert(f.container.querySelector('[aria-label="申し込み中止の確認"]'));
        await f.click('確認して申し込みを中止'); assert.deepEqual(writes(f), [{ route: 'abort', method: 'POST', body: { checkoutId: 'old-checkout' } }]);
        assert.equal(f.field('請求名').value, pending.quote.name); assert.equal(f.field('請求先メールアドレス').value, pending.quote.email); assert.equal(f.field('クーポンコード').value, 'FIRST'); assert.equal(f.container.querySelector('input[type=radio]').checked, true);
        assert.match(f.container.textContent, /申し込みを中止しました/); assert.equal(f.sdk.loads.length, 0);
    } finally { await f.close(); }
});

test('stale abort rechecks the original checkout and removes a withdrawn abort capability without allowing a new enrollment', async () => {
    let aborted = false;
    const f = await fixture({ initialStatus: status({ pending: pendingCheckout({ state: 'CUSTOMER_READY', resumeAllowed: false }) }), respond: async route => {
        if (route === 'abort') { aborted = true; throw Object.assign(new Error('stale'), { status: 409 }); }
        if (route === 'status' && aborted) return status({ pending: pendingCheckout({ state: 'SUBSCRIPTION_SUBMITTING', resumeAllowed: false, abortAllowed: false }) });
    } });
    try {
        await f.click('申し込みを中止してやり直す'); await f.click('確認して申し込みを中止');
        assert.equal(f.calls.filter(call => call.route === 'status').length, 2); assert.equal(f.container.querySelector('[aria-label="申し込み中止の確認"]'), null);
        assert(!f.container.textContent.includes('申し込みを中止してやり直す')); assert.equal(f.container.querySelector('input[type=radio]'), null); assert.equal(writes(f).length, 1);
    } finally { await f.close(); }
});

test('cached failed/busy/cooldown contract refresh discloses retained evidence and blocks repeated reads until the server retry time', async () => {
    for (const state of ['failed', 'busy', 'cooldown']) {
        const f = await fixture({ initialStatus: status({ pending: pendingCheckout({ resumeAllowed: false, abortAllowed: false }), refresh: { state, retryAtMs: Date.now() + 60000 } }) });
        try {
            assert.match(f.container.textContent, /保存された確認結果を表示/); assert.match(f.container.textContent, /秒後に再確認/);
            await f.click('受付状態を再確認'); await f.click('再読み込み'); assert.equal(f.calls.filter(call => call.route === 'status').length, 1); assert.equal(writes(f).length, 0);
        } finally { await f.close(); }
    }
});

test('a cached recheck never claims a fresh remote verification, and a resume response after unmount cannot trigger another status request', async () => {
    const cached = await fixture({ initialStatus: status({ pending: pendingCheckout({ resumeAllowed: false, abortAllowed: false }) }), respond: async route => route === 'status' ? status({ pending: pendingCheckout({ resumeAllowed: false, abortAllowed: false }), refresh: { state: 'failed', retryAtMs: Date.now() - 1 } }) : undefined });
    try { await cached.click('受付状態を再確認'); assert.match(cached.container.textContent, /保存された契約状態を取得/); assert(!cached.container.textContent.includes('契約状態を再確認しました')); }
    finally { await cached.close(); }
    let reject;
    const f = await fixture({ initialStatus: status({ pending: pendingCheckout() }), respond: async route => route === 'resume' ? new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }) : undefined });
    await f.consent(); await f.click('保存済みカードで契約を再開'); const before = f.calls.length; await f.close(); reject(new Error('late network result'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, before); assert.equal(writes(f).length, 1);
});

test('a stale recovery action whose status recheck fails cannot be confirmed again until status succeeds', async () => {
    for (const action of ['resume', 'abort']) {
        let stale = false, retries = 0;
        const f = await fixture({ initialStatus: status({ pending: pendingCheckout() }), respond: async route => {
            if (route === action) { stale = true; throw Object.assign(new Error('changed'), { status: 409 }); }
            if (route === 'status' && stale && ++retries === 1) throw new Error('temporary status failure');
        } });
        try {
            if (action === 'resume') { await f.consent(); await f.click('保存済みカードで契約を再開'); }
            else { await f.click('申し込みを中止してやり直す'); await f.click('確認して申し込みを中止'); }
            assert.match(f.container.textContent, /受付状態を再確認してから/);
            assert.equal(f.container.querySelector('input[type=checkbox]').disabled, true);
            const actionButton = [...f.container.querySelectorAll('button')].find(node => node.textContent === (action === 'resume' ? '保存済みカードで契約を再開' : '申し込みを中止してやり直す'));
            assert.equal(actionButton.disabled, true); await f.click(actionButton.textContent); assert.equal(writes(f).length, 1);
            await f.click('受付状態を再確認'); assert.equal(f.container.querySelector('input[type=checkbox]').checked, false); assert.equal(f.container.querySelector('input[type=checkbox]').disabled, false);
            assert.equal(f.container.querySelector('[aria-label="申し込み中止の確認"]'), null);
        } finally { await f.close(); }
    }
});

test('busy or cooled cancellation responses retain the active contract and explain deferred processing without claiming acceptance', async () => {
    for (const state of ['busy', 'cooldown']) {
        const f = await fixture({ initialStatus: status({ subscription: contract() }), respond: async route => route === 'cancel' ? status({ subscription: contract(), refresh: { state, retryAtMs: Date.now() + 30000 } }) : undefined });
        try {
            await f.click('サブスクリプションを解約'); await f.click('解約を申し込む');
            assert.match(f.container.textContent, state === 'busy' ? /解約の処理が進行中/ : /新しい解約操作を待機/); assert(!f.container.textContent.includes('解約の受付結果を反映しました')); assert(!f.container.textContent.includes('解約予定'));
            assert.equal(writes(f).length, 1); assert.equal(f.sdk.loads.length, 0);
        } finally { await f.close(); }
    }
});

test('proration verification warning survives a fresh reload while the owned unverified contract can still be canceled explicitly', async () => {
    const warning = { code: 'SQUARE_PRORATION_UNVERIFIED', message: '初回の日割り請求の期間を確認できません。管理者にお問い合わせください。' };
    const initial = status({ subscription: contract({ active: false, validUntilAtMs: null, paidThroughAtMs: null }), verificationWarning: warning, refresh: { state: 'failed', retryAtMs: Date.now() + 30000 } });
    const f = await fixture({ initialStatus: initial, respond: async route => route === 'cancel' ? status({ ...initial, subscription: contract({ active: false, validUntilAtMs: null, paidThroughAtMs: null, cancelScheduled: true, canceledDate: '2026-11-13' }) }) : undefined });
    try {
        assert.match(f.container.textContent, /初回の日割り請求の期間を確認できません.*管理者にお問い合わせ/); assert.match(f.container.textContent, /解約操作は引き続き利用/);
        assert.equal(f.container.querySelector('input[type=radio]'), null); assert.equal(f.sdk.loads.length, 0);
        await f.click('サブスクリプションを解約'); await f.click('解約を申し込む'); assert.match(f.container.textContent, /解約予定/); assert(!f.container.textContent.includes('利用中'));
        assert.deepEqual(writes(f), [{ route: 'cancel', method: 'POST', body: {} }]);
    } finally { await f.close(); }
});

test('restored annual and quarterly contracts disclose the charge month anchor and proration before renewed consent', async () => {
    for (const [cadence, label] of [['ANNUAL', '毎年'], ['QUARTERLY', '3か月ごと']]) {
        const pending = pendingCheckout({ quote: { ...pendingCheckout().quote, plan: plan({ cadence, billingAnchorDay: 20, canProrate: true }) } });
        const f = await fixture({ initialStatus: status({ pending }) });
        try {
            assert.match(f.container.textContent, /課金月の20日が課金日/); assert(f.container.textContent.includes(label)); assert.match(f.container.textContent, /初回は日割り/);
            assert.equal(f.container.querySelector('input[type=checkbox]').checked, false); assert.equal(f.sdk.loads.length, 0); assert.equal(writes(f).length, 0);
            assert(f.container.querySelector('input[type=checkbox]').parentElement.textContent.includes(label));
        } finally { await f.close(); }
    }
});
