'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const plan = (planId, changes = {}) => ({ planId, label: planId === 'free' ? '無料' : planId === 'supporter' ? '支援者' : 'ベーシック',
    tier: ['free', 'supporter'].includes(planId) ? planId : 'paid', isBuiltin: ['free', 'supporter'].includes(planId),
    enabled: true, slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, updatedAtMs: 10, ...changes });
const globalPolicy = changes => ({ featureEnabled: false, freePoolLimit: 50, supporterPoolLimit: 100, updatedAtMs: 10, ...changes });
const paidPolicy = changes => ({ featureEnabled: false, planId: 'basic', label: 'ベーシック', planEnabled: true, isPaid: true,
    eligible: false, specialSlotLimit: 0, consumesUserSlots: true, updatedAtMs: 10, ...changes });

async function fixture({ plans = [plan('free'), plan('supporter'), plan('basic')], global = globalPolicy(), paid = paidPolicy(), respond, integrated = false, initiallyOpen = true } = {}) {
    const f = await reactFixture('export { PushCapacityManager } from "./components/admin/push-capacity-manager"; export { NotificationPlanManager } from "./components/admin/notification-plan-manager";');
    f.calls = [];
    f.api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body });
        const override = respond && await respond(route, method, body, f);
        if (override !== undefined) return override;
        if (route === 'push-capacity') return method === 'GET' ? global : globalPolicy({ ...body, updatedAtMs: body.expectedUpdatedAtMs + 1 });
        if (route.startsWith('push-capacity/plans/')) return method === 'GET' ? paid : paidPolicy({ ...body, updatedAtMs: body.expectedUpdatedAtMs + 1 });
        if (route === 'plans') return { items: plans };
        if (route === 'billing/admin') return { configured: false, environment: 'sandbox', missing: [], bindings: [] };
        if (route.startsWith('plans/')) return plan(body.planId, { ...body, updatedAtMs: body.expectedUpdatedAtMs + 1 });
        throw new Error('PRIVATE_UNEXPECTED_API_REQUEST');
    };
    f.renderManager = async nextPlans => f.render(f.React.createElement(integrated ? f.exports.NotificationPlanManager : f.exports.PushCapacityManager, { api: f.api, ...(integrated ? {} : { plans: nextPlans ?? plans }) }));
    await f.renderManager(); await f.settle();
    if (initiallyOpen) { await f.click('容量の設定を開く'); await f.settle(); }
    f.global = () => f.container.querySelector('article[aria-label="自動展開の共有枠"]');
    f.paid = () => f.container.querySelector('article[aria-label="ベーシックの自動展開特殊枠"]');
    f.fieldIn = (node, label) => [...node.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(label))?.querySelector('input');
    f.submitIn = async node => f.act(async () => node.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    f.clickIn = async (node, text) => {
        const button = [...node.querySelectorAll('button')].find(item => item.textContent.trim() === text);
        assert(button, `Missing button: ${text}`); await f.act(async () => button.click());
    };
    f.check = async node => f.act(async () => node.querySelector('input[type=checkbox]').click());
    return f;
}
const writes = f => f.calls.filter(item => item.method !== 'GET');

test('dormant capacity settings stay visible but make no extra requests until opened on the existing admin screen', async () => {
    const f = await fixture({ integrated: true, initiallyOpen: false });
    try {
        assert.deepEqual(f.calls.map(item => item.route).sort(), ['billing/admin', 'plans']);
        assert.match(f.container.textContent, /新しいX自動展開の容量設定/);
        assert.match(f.container.textContent, /現在は未提供/); assert.equal(f.global(), null);
        await f.click('容量の設定を開く'); await f.settle();
        assert.equal(f.fieldIn(f.global(), '無料の全体枠数').value, '50');
        assert.equal(f.fieldIn(f.paid(), 'このプランの特殊枠数').value, '0');
    } finally { await f.close(); }
});

test('shared free50/supporter100 values come from the server, use X-account units, and keep the feature unprovided', async () => {
    const f = await fixture();
    try {
        assert.equal(f.fieldIn(f.global(), '無料の全体枠数').value, '50');
        assert.equal(f.fieldIn(f.global(), '支援者優先の全体枠数').value, '100');
        assert.match(f.container.textContent, /1枠＝通知を監視するXアカウント1件/);
        assert.match(f.container.textContent, /支援者優先枠は無料共有枠と競合しません/);
        assert.match(f.container.textContent, /ユーザーごとの通常の通知枠数とは別/);
        assert.match(f.container.textContent, /現在は未提供.*実通知の受信・復号の検証待ち/);
        assert.match(f.container.textContent, /保存しても、新規受付や通知受信は開始しません/);
        assert.equal(f.fieldIn(f.paid(), 'このプランの特殊枠数').value, '0');
        assert.equal(f.paid().querySelector('input[type=checkbox]').checked, false);
        assert.match(f.paid().textContent, /ユーザー1人あたり/);
        assert.match(f.paid().textContent, /既存のユーザー単位の通知枠も消費/);
        assert.match(f.paid().textContent, /プラン名・価格・優先度では自動判定しません/);
        assert.deepEqual(f.calls.map(item => item.route).sort(), ['push-capacity', 'push-capacity/plans/basic']);
        assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('global limits reject empty, negative, fractional, exponent and overflow input; zero and100000 save typed CAS values after review', async () => {
    const f = await fixture();
    try {
        const article = f.global(), field = f.fieldIn(article, '無料の全体枠数');
        for (const value of ['', '-1', '1.5', '1e2', '100001']) {
            await f.fill(field, value); await f.submitIn(article);
            assert.equal(article.querySelector('[aria-label="自動展開容量の変更確認"]'), null); assert.equal(writes(f).length, 0);
            assert.equal(field.getAttribute('aria-invalid'), 'true');
        }
        await f.fill(field, '0'); await f.fill(f.fieldIn(article, '支援者優先の全体枠数'), '100000');
        await f.submitIn(article); assert.equal(writes(f).length, 0);
        assert.match(article.querySelector('[aria-label="自動展開容量の変更確認"]').textContent, /無料の全体枠数500枠/);
        await f.clickIn(article, 'この容量で保存');
        assert.deepEqual(writes(f), [{ route: 'push-capacity', method: 'PATCH', body: { freePoolLimit: 0, supporterPoolLimit: 100000, expectedUpdatedAtMs: 10 } }]);
        assert.equal(field.value, '0'); assert.match(article.textContent, /新しい自動展開は引き続き未提供/);
        assert.equal(f.container.querySelector('input[name="featureEnabled"]'), null);
    } finally { await f.close(); }
});

test('paid special allowance needs an explicit Basic-or-higher designation and never sends normal slot or activation fields', async () => {
    const f = await fixture();
    try {
        const article = f.paid();
        await f.check(article); await f.fill(f.fieldIn(article, 'このプランの特殊枠数'), '7');
        await f.submitIn(article); assert.equal(writes(f).length, 0);
        assert.match(article.querySelector('[aria-label="自動展開容量の変更確認"]').textContent, /特殊枠の対象対象外対象/);
        await f.clickIn(article, 'この容量で保存');
        assert.deepEqual(writes(f), [{ route: 'push-capacity/plans/basic', method: 'PATCH', body: { eligible: true, specialSlotLimit: 7, expectedUpdatedAtMs: 10 } }]);
        assert.equal(f.fieldIn(f.global(), '無料の全体枠数').value, '50');
        assert.equal(f.fieldIn(f.global(), '支援者優先の全体枠数').value, '100');
        assert.equal(article.querySelector('input[type=checkbox]').checked, true);
    } finally { await f.close(); }
});

test('free/supporter aliases cannot receive paid controls and unverified paid metadata fails closed', async () => {
    const reserved = await fixture({ plans: ['FREE', 'Supporter'].map(id => plan(id, { tier: 'paid', isBuiltin: false })) });
    try {
        assert.equal(reserved.container.querySelectorAll('input[type=checkbox]').length, 0);
        assert.deepEqual(reserved.calls.map(item => item.route), ['push-capacity']);
    } finally { await reserved.close(); }
    const forged = await fixture({ paid: paidPolicy({ planId: 'free', isPaid: true }) });
    try {
        assert.equal(forged.paid().querySelector('form'), null); assert.match(forged.paid().textContent, /読み込めませんでした/);
        assert.equal(writes(forged).length, 0);
    } finally { await forged.close(); }
});

test('a global CAS conflict preserves edits, refetches current values and requires another review using the new revision', async () => {
    let reads = 0, rejected = false;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'push-capacity' && method === 'GET') return globalPolicy({ freePoolLimit: ++reads > 1 ? 8 : 50, updatedAtMs: reads > 1 ? 12 : 10 });
        if (route === 'push-capacity' && method === 'PATCH' && !rejected) { rejected = true; throw Object.assign(new Error('PRIVATE_CAS_DETAIL'), { status: 409, code: 'AUTOMATION_PUSH_CAPACITY_CONFLICT' }); }
    } });
    try {
        const article = f.global(), field = f.fieldIn(article, '無料の全体枠数');
        await f.fill(field, '9'); await f.submitIn(article); await f.clickIn(article, 'この容量で保存');
        assert.equal(field.value, '9'); assert.match(article.textContent, /ほかの管理者による変更/); assert(!article.textContent.includes('PRIVATE_CAS_DETAIL'));
        await f.submitIn(article); assert.equal(article.querySelector('[aria-label="自動展開容量の変更確認"]'), null);
        await f.clickIn(article, '最新の共有枠を再取得'); assert.equal(field.value, '9');
        await f.submitIn(article); assert.match(article.querySelector('[aria-label="自動展開容量の変更確認"]').textContent, /無料の全体枠数89枠/);
        await f.clickIn(article, 'この容量で保存'); assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 12);
    } finally { await f.close(); }
});

test('paid CAS conflict and failed refetch retain eligibility and quota and block writes until current metadata is loaded', async () => {
    let reads = 0, rejected = false;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'push-capacity/plans/basic' && method === 'GET') {
            if (++reads === 2) throw new Error('PRIVATE_READ_DETAIL');
            return paidPolicy({ specialSlotLimit: reads > 1 ? 4 : 0, updatedAtMs: reads > 1 ? 13 : 10 });
        }
        if (route === 'push-capacity/plans/basic' && method === 'PATCH' && !rejected) { rejected = true; throw Object.assign(new Error('PRIVATE_CONFLICT'), { status: 409 }); }
    } });
    try {
        const article = f.paid(); await f.check(article); await f.fill(f.fieldIn(article, 'このプランの特殊枠数'), '6');
        await f.submitIn(article); await f.clickIn(article, 'この容量で保存'); await f.clickIn(article, '最新の特殊枠を再取得');
        assert.equal(f.fieldIn(article, 'このプランの特殊枠数').value, '6'); assert.equal(article.querySelector('input[type=checkbox]').checked, true);
        assert(!article.textContent.includes('PRIVATE_READ_DETAIL')); await f.submitIn(article); assert.equal(writes(f).length, 1);
        await f.clickIn(article, '最新の特殊枠を再取得'); await f.submitIn(article); await f.clickIn(article, 'この容量で保存');
        assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 13); assert.equal(writes(f).at(-1).body.eligible, true);
    } finally { await f.close(); }
});

test('unavailable initial capacity has no guessed editable defaults and retry displays server-custom values', async () => {
    let reads = 0;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'push-capacity' && method === 'GET') { if (++reads === 1) throw new Error('PRIVATE_INITIAL_DETAIL'); return globalPolicy({ freePoolLimit: 75, supporterPoolLimit: 150 }); }
    } });
    try {
        assert.equal(f.global().querySelector('form'), null); assert(!f.global().textContent.includes('PRIVATE_INITIAL_DETAIL'));
        await f.clickIn(f.global(), '最新の共有枠を再取得');
        assert.equal(f.fieldIn(f.global(), '無料の全体枠数').value, '75'); assert.equal(f.fieldIn(f.global(), '支援者優先の全体枠数').value, '150');
    } finally { await f.close(); }
});

test('save failures show safe errors, preserve input and require a fresh manual confirmation before retry', async () => {
    let rejected = false;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'push-capacity' && method === 'PATCH' && !rejected) { rejected = true; throw new Error('PRIVATE_SAVE_DETAIL'); }
    } });
    try {
        const article = f.global(), field = f.fieldIn(article, '無料の全体枠数'); await f.fill(field, '55');
        await f.submitIn(article); await f.clickIn(article, 'この容量で保存'); assert.equal(field.value, '55');
        assert.match(article.textContent, /保存できませんでした/); assert(!article.textContent.includes('PRIVATE_SAVE_DETAIL'));
        assert.equal(article.querySelector('[aria-label="自動展開容量の変更確認"]'), null);
        await f.submitIn(article); await f.clickIn(article, 'この容量で保存'); assert.equal(writes(f).length, 2);
        assert.match(article.textContent, /容量の設定を保存しました/);
    } finally { await f.close(); }
});

test('disabled paid plans permit deactivation and cannot be designated or saved as eligible', async () => {
    for (const initiallyEligible of [false, true]) {
        const f = await fixture({ paid: paidPolicy({ planEnabled: false, eligible: initiallyEligible, specialSlotLimit: 3 }) });
        try {
            const article = f.paid(), check = article.querySelector('input[type=checkbox]');
            assert.equal(check.disabled, !initiallyEligible); assert.match(article.textContent, /このプランは無効/);
            await f.fill(f.fieldIn(article, 'このプランの特殊枠数'), '4'); await f.submitIn(article);
            if (initiallyEligible) {
                assert.equal(article.querySelector('[aria-label="自動展開容量の変更確認"]'), null);
                await f.check(article); await f.submitIn(article);
            }
            await f.clickIn(article, 'この容量で保存'); assert.equal(writes(f).at(-1).body.eligible, false);
        } finally { await f.close(); }
    }
});

test('rapid double-click saves once and a late metadata refresh cannot replace the successful CAS baseline', async () => {
    let reads = 0, releaseSave, releaseRead;
    const f = await fixture({ respond: async (route, method, body) => {
        if (route === 'push-capacity/plans/basic' && method === 'GET' && ++reads > 1) {
            await new Promise(resolve => { releaseRead = resolve; }); return paidPolicy();
        }
        if (route === 'push-capacity/plans/basic' && method === 'PATCH') {
            if (!releaseSave) await new Promise(resolve => { releaseSave = resolve; });
            return paidPolicy({ ...body, updatedAtMs: 12 });
        }
    } });
    try {
        const article = f.paid(); await f.check(article); await f.fill(f.fieldIn(article, 'このプランの特殊枠数'), '7'); await f.submitIn(article);
        const save = [...article.querySelectorAll('button')].find(item => item.textContent === 'この容量で保存');
        await f.act(async () => { save.click(); save.click(); }); assert.equal(writes(f).length, 1);
        await f.renderManager([plan('basic', { updatedAtMs: 11 })]); await f.settle();
        await f.act(async () => releaseSave()); await f.act(async () => releaseRead());
        assert.equal(f.fieldIn(article, 'このプランの特殊枠数').value, '7');
        await f.fill(f.fieldIn(article, 'このプランの特殊枠数'), '8'); await f.submitIn(article); await f.clickIn(article, 'この容量で保存');
        assert.equal(writes(f).at(-1).body.expectedUpdatedAtMs, 12);
    } finally { if (releaseRead) releaseRead(); if (releaseSave) releaseSave(); await f.close(); }
});

test('capacity editor is embedded in the existing admin screen and leaves normal per-user slots and Square controls intact', async () => {
    const f = await fixture({ integrated: true });
    try {
        const normal = f.container.querySelector('article[aria-label="無料の通知設定"]');
        assert.equal(f.fieldIn(normal, '通知枠数').value, '5'); assert.match(f.container.textContent, /Square連携/);
        await f.fill(f.fieldIn(f.global(), '無料の全体枠数'), '80'); await f.submitIn(f.global()); await f.clickIn(f.global(), 'この容量で保存');
        assert.equal(f.fieldIn(normal, '通知枠数').value, '5'); assert.equal(writes(f)[0].route, 'push-capacity');
        await f.fill(f.fieldIn(normal, '通知枠数'), '9'); await f.submitIn(normal); await f.clickIn(normal, 'この内容で保存');
        assert.equal(writes(f).at(-1).route, 'plans/free'); assert.equal(writes(f).at(-1).body.slotLimit, 9);
        assert.equal(f.fieldIn(f.global(), '無料の全体枠数').value, '80'); assert.equal(f.fieldIn(f.global(), '支援者優先の全体枠数').value, '100');
    } finally { await f.close(); }
});

const monitored = changes => ({ id: '7', ownerUserId: '111111111111111111', accountId: '12345', accountHandle: 'fixture_user', name: '管理対象のX監視', enabled: true, state: 'ready', poolKind: 'supporter', subscriptionState: 'pending', revision: 1,
    notificationSettings: { destinationId: 'dm-own' }, quality: { planId: 'basic', priority: 2, minuteLimit: 7, dayLimit: 48, intervalMinutes: 60 }, ...changes });
const adminSummary = changes => ({ pools: { free: { limit: 50, used: 49, available: 1 }, supporter: { limit: 100, used: 3, available: 97 } },
    owners: [{ userId: '111111111111111111', totalSupporterSlots: 5, legacySlots: 2, paidSlots: 3 }], nextCursor: null,
    registrations: [monitored()], registrationNextCursor: null,
    audits: [{ id: '9', actor_user_id: '999', entity_id: 'x:7', action: 'x.quota.allocate', detail_json: '{"PRIVATE_AUDIT_SECRET":"masked"}', created_at_ms: 1791932400000 }],
    integrity: { issues: [] }, ...changes });
const grantHistory = changes => ({ grants: [{ grantId: 'old-record', kind: 'historical_admin', slots: 0, purchasedSlots: 1, amountYen: null, confirmedRefundedAmount: 0, financialReviewRequired: false, createdAtMs: 1791932400000 }],
    payments: [{ attemptId: 'pay-old', amount: 1000, currency: 'JPY', verified: 1, state: 'COMPLETED', created_at_ms: 1791932400000 }], nextCursor: null, ...changes });
async function openDiagnostics(f) { await f.click('使用状況・付与履歴を確認'); await f.settle(); }
async function enterGrant(f, changes = {}) {
    const values = { '付与対象の利用者ID': '111111111111111111', '購入で付与された枠数': '1', '購入記録の参照ID': 'receipt:historic-1', '記録の根拠・理由': '確認済みの旧購入記録', ...changes };
    for (const [label, value] of Object.entries(values)) await f.fill(f.field(label), value);
    await f.click('購入記録の変更を確認');
}

test('admin diagnostics load on request and show pool usage, permanent holdings, allocation types and safe audits/integrity', async () => {
    const f = await fixture({ respond: route => route === 'push-capacity/admin' ? adminSummary({ integrity: { issues: [{ code: 'ORPHANED_PERSONAL_SLOT', id: '8', ownerUserId: '111111111111111111' }] } }) : undefined });
    try {
        assert.equal(f.calls.filter(item => item.route === 'push-capacity/admin').length, 0); await openDiagnostics(f);
        assert.match(f.container.querySelector('[aria-label="全体枠の使用状況"]').textContent, /共用無料枠50491/);
        assert.match(f.container.querySelector('[aria-label="全体枠の使用状況"]').textContent, /支援者優先枠100397/);
        assert.match(f.container.querySelector('[aria-label="利用者の保有支援枠"]').textContent, /1111111111111111115枠23/);
        assert.match(f.container.querySelector('[aria-label="監視登録の割当診断"]').textContent, /支援者優先枠.*品質参照: basic/);
        assert.match(f.container.querySelector('[aria-label="枠管理の整合性"]').textContent, /個人枠が未確認/);
        assert.match(f.container.textContent, /停止・資格失効中も割当済みの全体枠と個人枠を保持/);
        assert.match(f.container.textContent, /空きが戻っても自動移動は行いません/); assert(!f.container.textContent.includes('PRIVATE_AUDIT_SECRET'));
        assert.equal(f.calls.some(item => item.route.includes('rebalance')), false);
    } finally { await f.close(); }
});

test('admin owner/registration cursors append unique rows and history keeps unknown old amounts without recalculating slots', async () => {
    const f = await fixture({ respond: route => {
        if (route === 'push-capacity/admin') return adminSummary({ nextCursor: '111111111111111111', registrationNextCursor: '7' });
        if (route.includes('afterUserId=')) return adminSummary({ owners: [{ userId: '222222222222222222', totalSupporterSlots: 1, legacySlots: 1, paidSlots: 0 }] });
        if (route.includes('afterMonitorId=')) return adminSummary({ registrations: [monitored({ id: '8', accountId: '23456' })] });
        if (route.startsWith('push-capacity/history')) return grantHistory();
    } });
    try {
        await openDiagnostics(f); await f.click('利用者の続きを取得'); await f.click('監視登録の続きを取得');
        assert.match(f.container.textContent, /取得済み2人/); assert.match(f.container.textContent, /取得済み2件/);
        await f.fill(f.field('履歴を確認する利用者ID'), '111111111111111111'); await f.click('履歴を取得');
        assert.match(f.container.textContent, /購入枠1／追加付与0枠 · 金額未記録/);
        assert.match(f.container.textContent, /検証済み · 1,000円 · 完了/); assert(!f.container.textContent.includes('購入枠2／追加付与'));
    } finally { await f.close(); }
});

test('historical admin grant requires explicit source/count/reason and confirmation, supports record-only, and never accepts money claims', async () => {
    const f = await fixture({ respond: (route, method) => route === 'push-capacity/admin' ? adminSummary() : route.startsWith('push-capacity/history') ? grantHistory() : route === 'push-capacity/grants' && method === 'POST' ? { inserted: true } : undefined });
    try {
        await openDiagnostics(f); await enterGrant(f);
        const section = f.container.querySelector('[aria-label="管理者による過去購入枠の記録"]');
        assert.equal(writes(f).length, 0); assert.equal([...section.querySelectorAll('label')].some(item => item.textContent.startsWith('金額')), false);
        await f.act(async () => section.querySelector('input[type=checkbox]').click()); await f.click('購入記録の変更を確認');
        assert.match(section.textContent, /購入枠1 · 追加付与0枠/); await f.click('確認した購入記録を保存');
        assert.deepEqual(writes(f)[0], { route: 'push-capacity/grants', method: 'POST', body: { userId: '111111111111111111', slots: 1, idempotencyKey: 'receipt:historic-1', reason: '確認済みの旧購入記録', alreadyIncludedInLegacy: true } });
        assert.equal(Object.hasOwn(writes(f)[0].body, 'amountYen'), false); assert.equal(Object.hasOwn(writes(f)[0].body, 'isAdmin'), false);
    } finally { await f.close(); }
});

test('an uncertain grant locks edits and retries the same idempotent body rather than issuing another grant', async () => {
    let attempts = 0;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'push-capacity/admin') return adminSummary(); if (route.startsWith('push-capacity/history')) return grantHistory();
        if (route === 'push-capacity/grants' && method === 'POST') { if (++attempts === 1) throw new Error('PRIVATE_UNKNOWN_GRANT'); return { inserted: false }; }
    } });
    try {
        await openDiagnostics(f); await enterGrant(f); await f.click('確認した購入記録を保存');
        assert.equal(f.field('購入で付与された枠数').matches(':disabled'), true); assert(!f.container.textContent.includes('PRIVATE_UNKNOWN_GRANT'));
        const first = writes(f)[0].body; await f.click('同じ購入記録を再試行'); assert.deepEqual(writes(f)[1].body, first);
        assert.match(f.container.textContent, /同じ参照IDの再送で二重付与はしません/);
    } finally { await f.close(); }
});

test('admin diagnostics clear private owner/history records on a server permission denial and retain the operator draft', async () => {
    let denied = false;
    const f = await fixture({ respond: route => {
        if (route === 'push-capacity/admin') { if (denied) throw Object.assign(new Error('PRIVATE_ADMIN_DETAIL'), { status: 403 }); return adminSummary(); }
        if (route.startsWith('push-capacity/history')) return grantHistory();
    } });
    try {
        await openDiagnostics(f); await f.fill(f.field('付与対象の利用者ID'), '111111111111111111'); denied = true; await f.click('使用状況・整合性を更新');
        assert.equal(f.container.querySelector('[aria-label="利用者の保有支援枠"]'), null); assert.match(f.container.textContent, /管理者権限を確認できません/);
        assert(!f.container.textContent.includes('PRIVATE_ADMIN_DETAIL')); assert.equal(f.field('付与対象の利用者ID').value, '111111111111111111');
        assert.equal(f.field('付与対象の利用者ID').matches(':disabled'), true);
    } finally { await f.close(); }
});

test('admin can explicitly move another owner to a later eligible pool while free is available, preserving all monitor metadata', async () => {
    let registration = monitored();
    const f = await fixture({ respond: (route, method, body) => {
        if (route === 'push-capacity/admin') return adminSummary({ registrations: [registration] });
        if (route === 'x-monitors/7/move' && method === 'POST') { registration = { ...registration, poolKind: body.poolKind, revision: 2 }; return registration; }
    } });
    try {
        await openDiagnostics(f); const target = f.container.querySelector('[aria-label="管理者のX監視 7"]');
        await f.clickIn(target, '利用枠の種類を変更'); await f.fill(f.fieldIn(target, '変更先の利用枠') || target.querySelector('select'), 'special');
        await f.clickIn(target, '利用枠の変更を確認'); assert.equal(writes(f).length, 0); await f.clickIn(target, '指定した利用枠へ移動');
        assert.deepEqual(writes(f)[0], { route: 'x-monitors/7/move', method: 'POST', body: { poolKind: 'special', expectedRevision: 1 } });
        assert.deepEqual(registration.quality, monitored().quality); assert.deepEqual(registration.notificationSettings, monitored().notificationSettings); assert.equal(registration.subscriptionState, 'pending');
        assert.equal(f.calls.some(item => item.route.includes('rebalance')), false);
    } finally { await f.close(); }
});

test('optional plan interval leaves legacy bodies untouched, rejects invalid values and can explicitly configure or clear', async () => {
    const f = await fixture({ integrated: true });
    try {
        const normal = f.container.querySelector('article[aria-label="無料の通知設定"]'), interval = f.fieldIn(normal, '確認間隔（分）');
        assert.equal(interval.value, '');
        for (const value of ['0', '4', '5.5', '10081', '1e2']) { await f.fill(interval, value); await f.submitIn(normal); assert.equal(normal.querySelector('[aria-label="変更内容の確認"]'), null); }
        await f.fill(interval, '15'); await f.submitIn(normal); await f.clickIn(normal, 'この内容で保存'); assert.equal(writes(f).at(-1).body.intervalMinutes, 15);
        await f.fill(interval, ''); await f.submitIn(normal); await f.clickIn(normal, 'この内容で保存'); assert.equal(writes(f).at(-1).body.intervalMinutes, null);
        assert.match(normal.textContent, /既存通知の確認間隔・枠配分は保持/);
    } finally { await f.close(); }
});

test('admin audit and payment cursors append complete histories without losing earlier pages or duplicating source identities', async () => {
    const cursor = '1791932400000:fixture-payment';
    const f = await fixture({ respond: route => {
        if (route === 'push-capacity/admin') return adminSummary({ auditNextCursor: '9' });
        if (route.includes('afterAuditId=')) return adminSummary({ audits: [{ id: '8', actor_user_id: '999', entity_id: 'x:7', action: 'x.quota.move', created_at_ms: 1791932300000 }] });
        if (route.startsWith('push-capacity/history') && route.includes('afterPaymentId=')) return grantHistory({ payments: [{ attemptId: 'pay-older', amount: 500, currency: 'JPY', verified: true, state: 'COMPLETED', createdAtMs: 1791932300000 }] });
        if (route.startsWith('push-capacity/history')) return grantHistory({ paymentNextCursor: cursor });
    } });
    try {
        await openDiagnostics(f); await f.click('監査記録の続きを取得'); assert.match(f.container.querySelector('[aria-label="枠変更の監査履歴"]').textContent, /取得済み2件/);
        await f.fill(f.field('履歴を確認する利用者ID'), '111111111111111111'); await f.click('履歴を取得'); await f.click('決済履歴の続きを取得');
        assert.match(f.container.textContent, /支援決済の取得記録: 2件/); assert.match(f.container.textContent, /1,000円/); assert.match(f.container.textContent, /500円/);
        assert(f.calls.some(item => item.route.includes('afterPaymentId=' + encodeURIComponent(cursor))));
        assert.match(f.container.textContent, /購入枠1／追加付与0/);
    } finally { await f.close(); }
});

test('safe invalid registration/holding markers do not hide pool usage or integrity diagnostics and expose no unverified move', async () => {
    const f = await fixture({ respond: route => route === 'push-capacity/admin' ? adminSummary({ registrations: [], owners: [],
        invalidRegistrations: [{ id: '7', ownerUserId: '111111111111111111', errorCode: 'INVALID_REGISTRATION_METADATA' }],
        invalidOwners: [{ userId: '111111111111111111', errorCode: 'INVALID_SUPPORT_HOLDING' }],
        integrity: { issues: [{ code: 'INVALID_NOTIFICATION_SETTINGS', id: '7', ownerUserId: '111111111111111111' }] },
    }) : undefined });
    try {
        await openDiagnostics(f); assert.match(f.container.querySelector('[aria-label="全体枠の使用状況"]').textContent, /共用無料枠50491/);
        const invalid = f.container.querySelector('[aria-label="保存情報が不正なX監視 7"]'); assert(invalid); assert.equal(invalid.querySelector('button'), null);
        assert.match(f.container.textContent, /保有支援枠を確認できません.*0枠としては扱いません/); assert.match(f.container.querySelector('[aria-label="枠管理の整合性"]').textContent, /通知設定が不正/);
        assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});
