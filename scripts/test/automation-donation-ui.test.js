'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const options = changes => ({ configured: true, enabled: true, environment: 'sandbox', applicationId: 'sandbox-app', locationId: 'location', currency: 'JPY', minorUnitDigits: 0, minimumAmount: 100, maximumAmount: 20000, supporterThreshold: 1500, validityDays: 30, updatedAtMs: 10, ...changes });
const status = changes => ({ history: [], pending: null, supporter: { active: false, manualActive: false, threshold: 1500, validityDays: 30, netAmount: 0, validUntilAtMs: null }, ...changes });
const entry = changes => ({ attemptId: 'attempt-1', state: 'COMPLETED', verified: true, amount: 500, currency: 'JPY', refundedAmount: 0, netAmount: 500, createdAtMs: 1791831600000, completedAtMs: 1791831600100, ...changes });
const policy = changes => ({ enabled: false, currency: 'JPY', minimumAmount: null, maximumAmount: null, supporterThreshold: null, validityDays: null, updatedAtMs: 10, ...changes });
async function donationFixture({ config = options(), initial = status(), respond, tokenize, loader } = {}) {
    const f = await reactFixture('export { SquareDonationManager, donationAmount, donationMoney, donationAPI } from "./components/automation/square-donation-manager"; export { isPaymentEmail } from "./lib/payment-input";');
    const calls = [], sdk = { loads: [], payments: [], tokens: [], destroyed: 0 };
    const api = async (route, method = 'GET', body) => {
        calls.push({ route, method, body }); const override = respond && await respond(route, method, body, f); if (override !== undefined) return override;
        if (route === 'options') return config;
        if (route === 'status') return initial;
        if (route === 'quote') return { attemptId: 'attempt-1', expiresAtMs: Date.now() + 60000, amount: body.amount, currency: config.currency, minorUnitDigits: config.minorUnitDigits, name: body.name, email: body.email };
        if (route === 'donate') return status({ history: [entry()], supporter: { ...initial.supporter, netAmount: 500 } });
        throw new Error('Unexpected request');
    };
    const square = async environment => { sdk.loads.push(environment); if (loader) return loader(environment, f); return { payments: (app, location) => { sdk.payments.push({ app, location }); return { card: async () => ({ attach: async () => {}, destroy: async () => sdk.destroyed++, tokenize: async payload => { sdk.tokens.push(payload); return tokenize ? tokenize(payload) : { status: 'OK', token: 'cnon:secret-nonce' }; } }) }; } }; };
    f.calls = calls; f.sdk = sdk; f.api = api;
    await f.render(f.React.createElement(f.exports.SquareDonationManager, { api, loadSquare: square })); await f.settle();
    f.review = async value => { await f.fill(f.field('寄付金額'), value ?? '500'); await f.fill(f.field('領収名'), '山田 太郎'); await f.fill(f.field('領収先メールアドレス'), 'receipt@example.test'); await f.submit(); await f.settle(); };
    f.consent = async () => f.act(async () => f.container.querySelector('input[type=checkbox]').click());
    return f;
}
async function policyFixture({ initial = policy(), respond } = {}) {
    const f = await reactFixture('export { DonationPolicyManager } from "./components/admin/donation-policy-manager";');
    f.calls = [];
    f.api = async (route, method = 'GET', body) => { f.calls.push({ route, method, body }); const override = respond && await respond(route, method, body, f); if (override !== undefined) return override; return method === 'GET' ? initial : policy({ ...body, updatedAtMs: 11 }); };
    await f.render(f.React.createElement(f.exports.DonationPolicyManager, { api: f.api })); await f.settle();
    return f;
}
const writes = f => f.calls.filter(item => item.method !== 'GET');

test('donation route requires a session and existing payment/workspace routes expose support without replacing subscription', () => {
    const root = path.resolve(__dirname, '../..');
    const page = fs.readFileSync(path.join(root, 'dashboard/app/dashboard/automation/support/page.tsx'), 'utf8');
    assert.match(page, /await requireDashboardSession\(\)/); assert.match(page, /key=\{session\.user\.id\}/);
    for (const file of ['dashboard/components/automation/automation-workspace.tsx', 'dashboard/app/dashboard/automation/plans/page.tsx']) assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /href="\/dashboard\/automation\/support"/);
    assert.match(fs.readFileSync(path.join(root, 'dashboard/app/admin/notification-plans/page.tsx'), 'utf8'), /<DonationPolicyManager/);
});
test('disabled or unconfigured donations preserve history and never load Square or invent a contribution amount', async () => {
    for (const config of [options({ enabled: false, minimumAmount: null, maximumAmount: null }), options({ configured: false })]) {
        const f = await donationFixture({ config, initial: status({ history: [entry()] }) });
        try { assert.match(f.container.textContent, /無料枠の通知は引き続き利用/); assert.match(f.container.textContent, /支払い確定/); assert.equal(f.container.querySelector('form'), null); assert.equal(f.sdk.loads.length, 0); assert.equal(writes(f).length, 0); }
        finally { await f.close(); }
    }
});
test('amount conversion rejects rounding, exponents and overflow with exact zero/two/three decimal minor units', async () => {
    const f = await donationFixture();
    try {
        assert.equal(f.exports.donationAmount('199', 0), 199); assert.equal(f.exports.donationAmount('1.99', 2), 199); assert.equal(f.exports.donationAmount('1.234', 3), 1234);
        for (const [value, digits] of [['1.5', 0], ['1.234', 2], ['1e2', 0], ['0', 0], ['', 2], ['999999999999999999', 0], ['-1', 0], ['1\n', 0], ['1.2\n', 2], ['1.'.padEnd(100000, '0'), 2], ['0'.repeat(100000) + '1', 0]]) assert.equal(f.exports.donationAmount(value, digits), null);
        assert.equal(f.exports.donationAmount('9007199254740.991', 3), Number.MAX_SAFE_INTEGER); assert.equal(f.exports.donationAmount('9007199254740.992', 3), null);
        assert.equal(f.exports.donationMoney(199, 'USD'), '$1.99'); assert.equal(f.exports.donationMoney(500, 'JPY'), '￥500');
        await f.fill(f.field('寄付金額'), '99'); await f.fill(f.field('領収名'), '山田'); await f.fill(f.field('領収先メールアドレス'), 'receipt@example.test'); await f.submit(); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});
test('server quote determines charge amount and billing contact, and explicit one-off consent precedes tokenization', async () => {
    const f = await donationFixture({ respond: (route, method, body) => route === 'quote' ? { attemptId: 'attempt-1', expiresAtMs: Date.now() + 60000, amount: 750, currency: 'JPY', minorUnitDigits: 0, name: '確認済み名', email: 'confirmed@example.test' } : undefined });
    try {
        assert.match(f.container.textContent, /過去30日間/); assert.match(f.container.textContent, /対象期間を過ぎた寄付は累計から外れ/);
        await f.review(); assert.equal(writes(f)[0].body.amount, 500); assert.match(f.container.textContent, /￥750今回1回のみ/);
        const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '同意して寄付を支払う'); assert.equal(button.disabled, true); assert.equal(f.sdk.tokens.length, 0);
        await f.consent(); await f.click('同意して寄付を支払う');
        assert.deepEqual(f.sdk.tokens[0], { intent: 'CHARGE', amount: '750', currencyCode: 'JPY', customerInitiated: true, sellerKeyedIn: false, billingContact: { givenName: '確認済み名', email: 'confirmed@example.test', countryCode: 'JP' } });
        assert.deepEqual(writes(f)[1].body, { attemptId: 'attempt-1', sourceId: 'cnon:secret-nonce', consent: true }); assert(!f.container.textContent.includes('cnon:'));
    } finally { await f.close(); }
});
test('rapid duplicate clicks make one token and one payment and confirmed below-threshold contribution remains successful', async () => {
    const f = await donationFixture();
    try {
        await f.review(); await f.consent(); const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '同意して寄付を支払う');
        await f.act(async () => { button.click(); button.click(); }); await f.settle();
        assert.equal(f.sdk.tokens.length, 1); assert.equal(writes(f).filter(item => item.route === 'donate').length, 1);
        assert.match(f.container.textContent, /寄付の支払いが確定/); assert.match(f.container.textContent, /Square寄付による支援者枠の適用なし/);
        assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0);
        await f.click('新しい寄付内容を入力'); assert.equal(f.field('寄付金額').value, '500');
    } finally { await f.close(); }
});
test('uncertain charge blocks a new charge and retains quote/input while safe recheck resolves the confirmed result', async () => {
    let attempted = false, recheck = 0;
    const f = await donationFixture({ respond: route => {
        if (route === 'donate') { attempted = true; throw new Error('SECRET_PAYMENT_ERROR'); }
        if (route === 'status' && attempted) return ++recheck === 1 ? status({ pending: { attemptId: 'attempt-1', state: 'UNKNOWN' } }) : status({ history: [entry()] });
    } });
    try {
        await f.review(); await f.consent(); await f.click('同意して寄付を支払う'); assert.match(f.container.textContent, /新しい支払いを始めず/); assert(!f.container.textContent.includes('SECRET_PAYMENT_ERROR')); assert.equal(f.container.querySelector('form'), null);
        assert.equal([...f.container.querySelectorAll('button')].some(item => item.textContent === '新しい寄付内容を入力'), false);
        await f.click('支払い状態を再確認'); assert.match(f.container.textContent, /寄付の支払いが確定/); assert.equal(writes(f).filter(item => item.route === 'donate').length, 1); assert.equal(f.sdk.tokens.length, 1);
    } finally { await f.close(); }
});
test('pending state restored after mounting blocks checkout and does not store or reload a nonce', async () => {
    const f = await donationFixture({ initial: status({ pending: { attemptId: 'previous', state: 'UNKNOWN', retryable: true } }) });
    try { assert.equal(f.container.querySelector('form'), null); assert.match(f.container.textContent, /重複を避けるため/); assert.equal(f.sdk.loads.length, 0); assert.equal([...f.container.querySelectorAll('button')].some(item => item.textContent === '同じ受付内容で再試行'), false); }
    finally { await f.close(); }
});
test('server-confirmed same-attempt retry reuses the held source only after status allows it', async () => {
    let submitted = 0;
    const f = await donationFixture({ respond: route => { if (route === 'donate' && ++submitted === 1) throw new Error('offline'); if (route === 'status' && submitted) return status({ pending: { attemptId: 'attempt-1', state: 'UNKNOWN', retryable: true } }); } });
    try { await f.review(); await f.consent(); await f.click('同意して寄付を支払う'); await f.click('同じ受付内容で再試行'); assert.equal(submitted, 2); assert.equal(f.sdk.tokens.length, 1); assert.deepEqual(writes(f).filter(item => item.route === 'donate')[0].body, writes(f).filter(item => item.route === 'donate')[1].body); }
    finally { await f.close(); }
});
test('expired quotes and failed card tokenization do not post a payment and keep the amount draft', async () => {
    const expired = await donationFixture({ respond: (route, method, body) => route === 'quote' ? { attemptId: 'expired', expiresAtMs: 1, amount: body.amount, currency: 'JPY', minorUnitDigits: 0, name: body.name, email: body.email } : undefined });
    try { await expired.review(); await expired.consent(); await expired.click('同意して寄付を支払う'); assert.match(expired.container.textContent, /確認期限が切れ/); assert.equal(expired.sdk.tokens.length, 0); await expired.click('金額の入力へ戻る'); assert.equal(expired.field('寄付金額').value, '500'); }
    finally { await expired.close(); }
    const rejected = await donationFixture({ tokenize: () => ({ status: 'INVALID' }) });
    try { await rejected.review(); await rejected.consent(); await rejected.click('同意して寄付を支払う'); assert.match(rejected.container.textContent, /支払いは実行されていません/); assert.equal(writes(rejected).filter(item => item.route === 'donate').length, 0); }
    finally { await rejected.close(); }
});
test('a card SDK failure has an explicit reload and leaving review destroys the iframe without losing draft', async () => {
    let failed = false;
    const f = await donationFixture({ loader: async () => { if (!failed) { failed = true; throw new Error('SECRET_SDK'); } return { payments: () => ({ card: async () => ({ attach: async () => {}, destroy: async () => f.sdk.destroyed++, tokenize: async () => ({ status: 'OK', token: 'secret' }) }) }) }; } });
    try { await f.review(); assert.match(f.container.textContent, /カード入力欄を読み込めません/); assert(!f.container.textContent.includes('SECRET_SDK')); await f.click('カード入力欄を再読み込み'); await f.settle(); await f.click('金額の入力へ戻る'); assert.equal(f.field('寄付金額').value, '500'); assert.equal(f.sdk.destroyed, 1); }
    finally { await f.close(); }
});
test('refund history separates paid, refunded and net money, while supporter threshold can be unset', async () => {
    const f = await donationFixture({ config: options({ supporterThreshold: null, validityDays: null }), initial: status({ history: [entry({ refundedAmount: 200, netAmount: 300 }), entry({ attemptId: 'other', refundedAmount: 500, netAmount: 0 })] }) });
    try { assert.match(f.container.textContent, /自動適用は未設定/); assert.match(f.container.textContent, /一部返金/); assert.match(f.container.textContent, /全額返金/); assert.match(f.container.textContent, /￥200￥300/); assert.match(f.container.textContent, /￥500￥0/); }
    finally { await f.close(); }
});
test('failed options/status loading can retry and preserves an existing amount entry', async () => {
    let fail = false;
    const f = await donationFixture({ respond: route => { if (route === 'options' && fail) { fail = false; throw new Error('PRIVATE_OPTIONS'); } } });
    try { await f.fill(f.field('寄付金額'), '650'); fail = true; await f.click('再読み込み'); assert.match(f.container.textContent, /入力内容を保持/); assert(!f.container.textContent.includes('PRIVATE_OPTIONS')); await f.click('再読み込み'); assert.equal(f.field('寄付金額').value, '650'); }
    finally { await f.close(); }
});
test('default donation API uses the dedicated endpoint, safe rate feedback and never exposes response internals', async () => {
    const f = await reactFixture('export { donationAPI } from "./components/automation/square-donation-manager";'); let request;
    f.set('fetch', async (url, payload) => { request = { url, payload }; return Response.json({ error: 'PRIVATE_FAILURE', code: 'AUTOMATION_RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '9' } }); });
    try { await assert.rejects(f.exports.donationAPI('quote', 'POST', { amount: 100 }), /約9秒/); assert.equal(request.url, '/api/automation/billing/donations/quote'); assert.equal(request.payload.cache, 'no-store'); }
    finally { await f.close(); }
});
test('admin policy starts with blank amount/period settings and enables receipt only with explicit range', async () => {
    const f = await policyFixture();
    try {
        for (const label of ['受付の最低金額', '受付の最高金額', '支援者枠を適用する累計額', '累計の対象期間']) assert.equal(f.field(label).value, '');
        assert.match(f.container.textContent, /過去N日間/); assert.match(f.container.textContent, /全期間の正味寄付額/);
        await f.act(async () => f.container.querySelector('input[type=checkbox]').click()); await f.submit(); assert.equal(writes(f).length, 0); assert.equal(f.container.querySelector('[aria-label="寄付設定の変更確認"]'), null);
    } finally { await f.close(); }
});
test('admin saves typed configured values with before/after review and CAS revision, including decimal currency', async () => {
    const f = await policyFixture({ initial: policy({ currency: 'USD' }) });
    try {
        await f.act(async () => f.container.querySelector('input[type=checkbox]').click());
        await f.fill(f.field('受付の最低金額'), '1.99'); await f.fill(f.field('受付の最高金額'), '99.50'); await f.fill(f.field('支援者枠を適用する累計額'), '19.99'); await f.fill(f.field('累計の対象期間'), '90');
        await f.submit(); assert.equal(writes(f).length, 0); assert.match(f.container.querySelector('[aria-label="寄付設定の変更確認"]').textContent, /未設定\$1.99/);
        await f.click('この寄付設定で保存'); assert.deepEqual(writes(f), [{ route: 'policy', method: 'PATCH', body: { enabled: true, currency: 'USD', minimumAmount: 199, maximumAmount: 9950, supporterThreshold: 1999, validityDays: 90, expectedUpdatedAtMs: 10 } }]); assert.match(f.container.textContent, /受付設定を保存/);
    } finally { await f.close(); }
});
test('admin input can remain empty and invalid period/amount prevents confirmation without coerced defaults', async () => {
    const f = await policyFixture();
    try {
        await f.fill(f.field('受付の最低金額'), '100'); await f.fill(f.field('受付の最高金額'), '50'); await f.submit(); assert.equal(f.container.querySelector('[aria-label="寄付設定の変更確認"]'), null);
        await f.fill(f.field('受付の最高金額'), '1000'); await f.fill(f.field('累計の対象期間'), '0'); await f.submit(); assert.equal(writes(f).length, 0);
        await f.fill(f.field('累計の対象期間'), ''); assert.equal(f.field('累計の対象期間').value, ''); await f.submit(); await f.click('この寄付設定で保存'); assert.equal(writes(f)[0].body.validityDays, null); assert.equal(writes(f)[0].body.supporterThreshold, null);
    } finally { await f.close(); }
});
test('admin conflict reload keeps the edited threshold and requires a new review against current server version', async () => {
    let conflict = true, loads = 0;
    const f = await policyFixture({ respond: (route, method) => { if (method === 'GET' && ++loads > 1) return policy({ supporterThreshold: 4000, updatedAtMs: 12 }); if (method === 'PATCH' && conflict) { conflict = false; throw Object.assign(new Error('PRIVATE_CONFLICT'), { status: 409 }); } } });
    try {
        await f.fill(f.field('支援者枠を適用する累計額'), '5000'); await f.submit(); await f.click('この寄付設定で保存'); assert.match(f.container.textContent, /ほかの管理者による変更/); assert(!f.container.textContent.includes('PRIVATE_CONFLICT')); assert.equal(f.field('支援者枠を適用する累計額').value, '5000');
        await f.click('最新の寄付設定を再取得'); assert.equal(f.field('支援者枠を適用する累計額').value, '5000'); assert.equal(f.container.querySelector('[aria-label="寄付設定の変更確認"]'), null);
        await f.submit(); assert.match(f.container.querySelector('[aria-label="寄付設定の変更確認"]').textContent, /￥4,000￥5,000/); await f.click('この寄付設定で保存'); assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 12);
    } finally { await f.close(); }
});
test('admin failed load and refresh preserve draft while updating the reviewed baseline', async () => {
    let count = 0, release;
    const f = await policyFixture({ respond: (route, method) => { if (method !== 'GET') return; if (++count === 1) throw new Error('private'); if (count === 3) return new Promise(resolve => { release = () => resolve(policy({ updatedAtMs: 11 })); }); return policy({ updatedAtMs: count === 2 ? 10 : 12 }); } });
    try {
        assert.match(f.container.textContent, /取得できません/); await f.click('寄付設定を更新'); await f.fill(f.field('支援者枠を適用する累計額'), '6000');
        const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '寄付設定を更新'); await f.act(async () => { button.click(); });
        release(); await f.settle(); assert.equal(f.field('支援者枠を適用する累計額').value, '6000'); await f.submit(); await f.click('この寄付設定で保存'); assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 11);
    } finally { await f.close(); }
});
test('an initial null policy revision requires an explicit currency and confirms before first CAS creation', async () => {
    const f = await policyFixture({ initial: policy({ currency: null, updatedAtMs: null }), respond: (route, method) => method === 'GET' ? { configured: true, locationCurrency: 'JPY', policy: policy({ currency: null, updatedAtMs: null }) } : undefined });
    try {
        assert.equal(f.field('寄付の通貨').value, ''); assert.match(f.container.textContent, /Square店舗の通貨: JPY/); await f.fill(f.field('寄付の通貨'), 'jpy');
        await f.fill(f.field('受付の最低金額'), '100'); await f.fill(f.field('受付の最高金額'), '10000'); await f.fill(f.field('支援者枠を適用する累計額'), '3000'); await f.submit();
        assert(f.container.querySelector('[aria-label="寄付設定の変更確認"]')); assert.equal(writes(f).length, 0); await f.click('この寄付設定で保存'); assert.equal(writes(f)[0].body.expectedUpdatedAtMs, null); assert.equal(writes(f)[0].body.currency, 'JPY');
    } finally { await f.close(); }
});
test('an unverified completed response stays pending until REST status verifies the payment', async () => {
    let attempted = false;
    const f = await donationFixture({ respond: route => { if (route === 'donate') { attempted = true; return status({ history: [entry({ verified: false, netAmount: 0 })] }); } if (route === 'status' && attempted) return status({ history: [entry()] }); } });
    try { await f.review(); await f.consent(); await f.click('同意して寄付を支払う'); assert(!f.container.textContent.includes('寄付の支払いが確定しました')); assert.match(f.container.textContent, /支払い確認中/); assert.equal([...f.container.querySelectorAll('button')].some(item => item.textContent === '新しい寄付内容を入力'), false); await f.click('支払い状態を再確認'); assert.match(f.container.textContent, /寄付の支払いが確定/); }
    finally { await f.close(); }
});
test('a pre-wire policy change verified as still quoted allows returning to the amount without charging again', async () => {
    let attempted = false;
    const f = await donationFixture({ respond: route => { if (route === 'donate') { attempted = true; throw Object.assign(new Error('changed'), { code: 'SQUARE_DONATION_QUOTE_CHANGED' }); } if (route === 'status' && attempted) return status({ history: [entry({ state: 'QUOTED', verified: false, netAmount: 0 })] }); } });
    try { await f.review(); await f.consent(); await f.click('同意して寄付を支払う'); assert.match(f.container.textContent, /今回の支払いは完了していません/); assert.match(f.container.textContent, /内容確認済み（未送信）/); await f.click('新しい寄付内容を入力'); assert.equal(f.field('寄付金額').value, '500'); assert.equal(writes(f).filter(item => item.route === 'donate').length, 1); }
    finally { await f.close(); }
});
test('manual supporter status remains visible when donation auto-grant is unset', async () => {
    const f = await donationFixture({ config: options({ supporterThreshold: null, validityDays: null }), initial: status({ supporter: { active: false, manualActive: true, threshold: null, validityDays: null, netAmount: 0, validUntilAtMs: null } }) });
    try { assert.match(f.container.textContent, /手動で付与された支援者枠を利用中/); assert.match(f.container.textContent, /自動適用は未設定/); }
    finally { await f.close(); }
});
test('unconfigured donation integration explains server setup and blocks policy writes without displaying secrets', async () => {
    const f = await policyFixture({ respond: (route, method) => method === 'GET' ? { configured: false, missing: ['SQUARE_ACCESS_TOKEN'], policy: policy() } : undefined });
    try { assert.match(f.container.textContent, /サーバー設定が未完了/); assert(!f.container.textContent.includes('SQUARE_ACCESS_TOKEN')); await f.fill(f.field('支援者枠を適用する累計額'), '3000'); await f.submit(); assert.equal(f.container.querySelector('[aria-label="寄付設定の変更確認"]'), null); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
test('cached failed/busy/cooldown refresh states disclose latest-check limits and block repeated checks until server retry time', async () => {
    for (const state of ['failed', 'busy', 'cooldown']) {
        const f = await donationFixture({ initial: status({ pending: { attemptId: 'unknown', state: 'UNKNOWN' }, refresh: { state, retryAtMs: Date.now() + 9000 } }) });
        try {
            assert.match(f.container.textContent, /保存された確認結果を表示/); assert.match(f.container.textContent, /秒後に再確認/); assert.match(f.container.textContent, /新しい支払いは開始できません/);
            assert.equal(f.container.querySelector('form'), null);
            for (const text of ['再読み込み', '支払い状態を再確認']) assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === text).disabled, true);
            assert.equal(f.calls.filter(item => item.route === 'status').length, 1); assert.equal(writes(f).length, 0);
        } finally { await f.close(); }
    }
});
test('a failed remote recheck uses cached-result wording, retains pending state and safely enables manual check after retry time', async () => {
    let checks = 0;
    const f = await donationFixture({ initial: status({ pending: { attemptId: 'unknown', state: 'UNKNOWN' }, refresh: { state: 'checked', retryAtMs: null } }), respond: route => {
        if (route === 'status' && ++checks > 1) return status({ pending: { attemptId: 'unknown', state: 'UNKNOWN' }, refresh: { state: 'failed', retryAtMs: Date.now() + 30 } });
    } });
    try {
        await f.click('支払い状態を再確認'); assert.match(f.container.textContent, /最新の支払い・返金状態を確認できません/); assert.match(f.container.textContent, /保存された支払い結果を取得/); assert(!f.container.textContent.includes('Squareで支払い状態を再確認しました'));
        const button = [...f.container.querySelectorAll('button')].find(item => item.textContent === '支払い状態を再確認'); assert.equal(button.disabled, true);
        await f.act(async () => new Promise(resolve => setTimeout(resolve, 55))); assert.equal(button.disabled, false); assert.equal(checks, 2); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});
test('a freshly checked status explains the next allowed check without hiding the one-off donation form', async () => {
    const f = await donationFixture({ initial: status({ refresh: { state: 'checked', retryAtMs: Date.now() + 9000 } }) });
    try { assert.match(f.container.textContent, /Squareで支払い・返金状態を確認しました/); assert.match(f.container.textContent, /秒後に再確認/); assert(f.container.querySelector('form')); assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === '再読み込み').disabled, true); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});
test('receipt email validation keeps Unicode/subdomain semantics with a bounded linear scan and rejects repeated separators', async () => {
    const f = await donationFixture();
    try {
        for (const value of ['user+support@payments.example.test', '利用者@例え.テスト', 'a'.repeat(242) + '@example.com']) assert.equal(f.exports.isPaymentEmail(value), true, value);
        for (const value of ['', 'x@domain', '@example.test', 'user@.x', 'user@x.', 'user@@example.test', 'user name@example.test', '利用者\u3000@例え.テスト', 'x@example.test\n', 'a'.repeat(243) + '@example.com', 'a'.repeat(100000) + '@example.test', 'x@' + '.'.repeat(100000)]) assert.equal(f.exports.isPaymentEmail(value), false);
    } finally { await f.close(); }
});
test('donation receipt emails reject overlength or malformed input before requesting a quote and accept Unicode after correction', async () => {
    const f = await donationFixture();
    try {
        await f.fill(f.field('寄付金額'), '500'); await f.fill(f.field('領収名'), '山田');
        for (const value of ['a'.repeat(243) + '@example.com', 'user@@example.test', 'user@domain']) { await f.fill(f.field('領収先メールアドレス'), value); await f.submit(); assert.equal(writes(f).length, 0); }
        await f.fill(f.field('領収先メールアドレス'), '利用者@payments.例え.テスト'); await f.submit(); assert.equal(writes(f)[0].body.email, '利用者@payments.例え.テスト');
    } finally { await f.close(); }
});
