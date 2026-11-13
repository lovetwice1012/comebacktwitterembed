'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const subscriptionId = 'cc2cb493-a60d-41d6-936f-2ed33d7ea2c7';
const quality = { planId: 'basic', priority: 2, minuteLimit: 7, dayLimit: 48, intervalMinutes: 60 };
const quota = { featureEnabled: true, currentPlan: { ...quality, label: 'ベーシック', tier: 'paid', baseSlotLimit: 5 },
    personal: { totalLimit: 8, registeredCount: 3, used: 3, available: 5, supporterExtraSlots: 3 },
    x: { used: 3, available: 3, specialLimit: 3, specialUsed: 0, reasonCode: null, reason: null },
    pools: { free: { limit: 50, used: 3, available: 47 }, supporter: { limit: 100, used: 1, available: 99 } } };
const setup = { available: true, receiverEnabled: true, chromeEnabled: true, braveEnabled: true,
    rollout: { mode: 'supporters', eligible: true, reasonCode: null, reason: null },
    download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) },
    subscriptions: [{ id: subscriptionId, state: 'stored', revision: 1, createdAtMs: 1791921600000, updatedAtMs: 1791921600000,
        browserVersion: '160.0a1', receiverState: 'listening', boundMonitorCount: 1 }], maxFileBytes: 32768, nextCursor: null };
const makeRow = changes => ({ id: '1', accountId: null, accountHandle: 'fixture_user', name: 'X通知', enabled: true,
    state: 'ready', poolKind: 'free', notificationSettings: { subscriptionId }, subscriptionState: 'bound', revision: 1, quality, ...changes });

async function fixture({ failList = false, failSetup = false, delayed = false, currentQuota = quota, listQuota = currentQuota, failQuota = false, initialItems, setupData = setup } = {}) {
    const f = await reactFixture('export { XMonitorManager } from "./components/automation/x-monitor-manager";');
    f.items = initialItems ?? [makeRow({ id: '1', name: '受信中' }), makeRow({ id: '2', name: '接続待ち', notificationSettings: {} }),
        makeRow({ id: '3', name: '停止中', enabled: false })];
    f.calls = []; f.latestRows = []; f.latestStatus = null; f.failSetup = failSetup; f.delayReads = delayed;
    f.api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body });
        if (route === 'x-monitor-quota') { if (failQuota) throw new Error('PRIVATE_QUOTA_FAILURE'); return currentQuota; }
        if (route === 'x-setup') { if (f.failSetup) throw new Error('PRIVATE_SETUP_FAILURE'); return setupData; }
        if (route === 'x-monitors' && method === 'GET') {
            if (f.delayReads || f.blockReads) await new Promise(resolve => { f.release = resolve; });
            if (failList) throw new Error('PRIVATE_TEST_FAILURE');
            return { items: f.items, ...(listQuota === undefined ? {} : { quota: listQuota }) };
        }
        if (route.startsWith('x-monitors/') && method === 'PATCH') {
            if (f.blockMutation) await new Promise(resolve => { f.releaseMutation = resolve; });
            const id = route.split('/')[1], old = f.items.find(item => item.id === id);
            const saved = { ...old, ...body, revision: old.revision + 1 };
            f.items = f.items.map(item => item.id === id ? saved : item); return saved;
        }
        throw new Error('PRIVATE_UNEXPECTED_REQUEST');
    };
    f.search = ''; f.active = true; f.suppressReadErrors = false; f.listFilter = 'all';
    f.renderer = (rows, status) => {
        f.latestRows = rows; f.latestStatus = status;
        return f.React.createElement('div', { 'aria-label': '共通通知一覧' }, rows.filter(item => item.searchText.includes(f.search)).map(item => item.node));
    };
    f.renderManager = () => f.render(f.React.createElement(f.exports.XMonitorManager,
        { api: f.api, active: f.active, unified: true, setupPlacement: 'compact', renderUnifiedList: f.renderer, suppressReadErrors: f.suppressReadErrors, listFilter: f.listFilter, registrationRequest: f.registrationRequest }));
    await f.renderManager();
    return f;
}

test('unified X rows expose stable kind-prefixed keys, readiness and cards without duplicating X-only sections', async () => {
    const f = await fixture();
    try {
        await f.settle(); assert.deepEqual(f.latestRows.map(item => item.key), ['x:1', 'x:2', 'x:3']);
        assert.deepEqual(f.latestRows.map(item => item.filterState), ['active', 'attention', 'paused']);
        assert.match(f.latestRows[0].searchText, /@fixture_user/); assert.match(f.latestRows[0].searchText, /https:\/\/x\.com\/fixture_user/);
        assert.equal(f.latestStatus.loading, false); assert.equal(f.latestStatus.failed, false);
        assert.equal(f.calls.filter(call => call.route === 'x-monitor-quota').length, 0);
        assert.equal(f.container.querySelectorAll('[aria-label="共通通知一覧"] article').length, 3);
        assert.equal(f.container.querySelector('[aria-label="X監視の個人利用枠"]'), null);
        assert.equal(f.container.querySelector('[aria-label="Xの接続状況"]'), null);
        assert.doesNotMatch(f.container.textContent, /X一覧・利用枠を更新|Xアカウントの監視を管理/);
        const reads = f.calls.filter(call => call.method === 'GET' && call.route.startsWith('x-')).length;
        f.search = '@fixture_user'; await f.renderManager(); await f.settle();
        assert.equal(f.calls.filter(call => call.method === 'GET' && call.route.startsWith('x-')).length, reads);
        const first = f.container.querySelector('[aria-label="受信中のX監視"]'); assert(first);
        assert.match(first.querySelector('header').textContent, /X\s+@fixture_user/);
        const details = first.querySelector('[aria-label="X通知の接続と利用状況"]');
        assert(details && details.tagName === 'DETAILS' && !details.open);
        assert.match(details.textContent, /使用枠.*接続.*通知データの受信.*Discordへの送信.*利用枠/);
        assert.equal(first.querySelector('.monitor-facts').textContent.includes('使用枠'), false);
        const stop = [...first.querySelectorAll('button')].find(button => button.textContent === '停止');
        await f.act(async () => stop.click()); await f.settle();
        assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').map(call => ({ route: call.route, body: call.body })),
            [{ route: 'x-monitors/1', body: { expectedRevision: 1, enabled: false } }]);
        assert.equal(f.latestRows.find(item => item.key === 'x:1').filterState, 'paused');
    } finally { await f.close(); }
});

test('inactive unified X data stays private while a draft survives a scope switch without network requests', async () => {
    const f = await fixture();
    try {
        await f.settle();
        const target = f.container.querySelector('[aria-label="受信中のX監視"]');
        const edit = [...target.querySelectorAll('button')].find(button => button.textContent === '設定を変更');
        await f.act(async () => edit.click());
        const name = f.field('監視の表示名'); await f.fill(name, '編集中の名前');
        const calls = f.calls.length;
        f.active = false; await f.renderManager(); await f.settle();
        assert.equal(f.calls.length, calls); assert.equal(f.latestRows.length, 0);
        assert.equal(f.latestStatus.loading, false); assert.equal(f.latestStatus.failed, false); assert.equal(typeof f.latestStatus.reload, 'function');
        assert.equal(f.container.querySelector('[aria-label="X監視の登録設定"]'), null);
        assert.doesNotMatch(f.container.textContent, /受信中のX監視|編集中の設定を開く/);
        f.active = true; await f.renderManager(); await f.settle();
        assert.equal(f.field('監視の表示名').value, '編集中の名前');
        assert.equal(f.dom.window.document.activeElement, f.field('Xアカウント名'));
    } finally { await f.close(); }
});

test('unified reload coalesces concurrent requests and does not start while inactive or a mutation is pending', async () => {
    const f = await fixture();
    try {
        await f.settle(); const count = () => f.calls.filter(call => call.route === 'x-monitors' && call.method === 'GET').length;
        const initial = count(); f.blockReads = true;
        let first, second;
        await f.act(async () => { first = f.latestStatus.reload(); second = f.latestStatus.reload(); });
        assert.equal(count(), initial + 1); assert(f.release);
        f.blockReads = false; await f.act(async () => { f.release(); await Promise.all([first, second]); });
        f.active = false; await f.renderManager(); const inactive = count(); await f.latestStatus.reload(); assert.equal(count(), inactive);
        f.active = true; await f.renderManager(); await f.settle();
        const active = count(); f.blockMutation = true;
        const target = f.container.querySelector('[aria-label="受信中のX監視"]');
        const stop = [...target.querySelectorAll('button')].find(button => button.textContent === '停止');
        await f.act(async () => { stop.click(); void f.latestStatus.reload(); });
        assert.equal(count(), active); assert(f.releaseMutation);
        f.blockMutation = false; await f.act(async () => f.releaseMutation()); await f.settle();
        assert.equal(count(), active + 1);
    } finally { if (f.release) f.release(); if (f.releaseMutation) f.releaseMutation(); await f.close(); }
});

test('a retry requested during initial X loading waits and performs only one fresh read', async () => {
    const f = await fixture({ delayed: true });
    try {
        const count = () => f.calls.filter(call => call.route === 'x-monitors' && call.method === 'GET').length;
        assert.equal(count(), 1); let first, second;
        await f.act(async () => { first = f.latestStatus.reload(); second = f.latestStatus.reload(); });
        assert.equal(count(), 1); assert(f.release);
        f.delayReads = false;
        await f.act(async () => { f.release(); await Promise.all([first, second]); });
        assert.equal(count(), 2); assert.equal(f.latestStatus.failed, false);
        assert.equal(f.calls.filter(call => call.route === 'x-monitor-quota').length, 0);
    } finally { if (f.release) f.release(); await f.close(); }
});

test('a stale in-flight X read cannot block a refresh after the active scope changes', async () => {
    const f = await fixture({ delayed: true });
    try {
        const count = () => f.calls.filter(call => call.route === 'x-monitors' && call.method === 'GET').length;
        const releaseOld = f.release; let oldRetry;
        await f.act(async () => { oldRetry = f.latestStatus.reload(); });
        f.active = false; await f.renderManager(); f.delayReads = false;
        f.active = true; await f.renderManager(); await f.settle(); assert.equal(count(), 2);
        await f.act(async () => f.latestStatus.reload()); assert.equal(count(), 3);
        await f.act(async () => { releaseOld(); await oldRetry; });
        assert.equal(count(), 3);
    } finally { if (f.release) f.release(); await f.close(); }
});

test('unified list reports loading and failed X data without treating it as an empty completed list', async () => {
    const f = await fixture({ failList: true, delayed: true });
    try {
        assert.equal(f.latestStatus.loading, true); assert.equal(f.latestStatus.failed, false);
        await f.act(async () => f.release()); await f.settle();
        assert.equal(f.latestStatus.loading, false); assert.equal(f.latestStatus.failed, true);
        assert.equal(f.calls.filter(call => call.route === 'x-monitor-quota').length, 1);
        assert.match(f.container.textContent, /X監視の一覧をもう一度読み込んでください/);
        assert.doesNotMatch(f.container.textContent, /PRIVATE_TEST_FAILURE|登録済みのX監視はありません/);
        const callCount = f.calls.length;
        f.suppressReadErrors = true; await f.renderManager();
        assert.equal(f.latestStatus.failed, true); assert.equal(f.calls.length, callCount);
        assert.doesNotMatch(f.container.textContent, /X監視の一覧をもう一度読み込んでください/);
    } finally { if (f.release) f.release(); await f.close(); }
});

test('unified list uses a guarded quota fallback only when the list quota is malformed', async () => {
    const f = await fixture({ listQuota: { invalid: true } });
    try {
        await f.settle(); assert.equal(f.latestStatus.failed, false); assert.equal(f.latestRows.length, 3);
        assert.equal(f.calls.filter(call => call.route === 'x-monitors').length, 1);
        assert.equal(f.calls.filter(call => call.route === 'x-monitor-quota').length, 1);
        assert.doesNotMatch(f.container.textContent, /X監視の一覧をもう一度読み込んでください|現在のプランと利用枠を読み直して/);
    } finally { await f.close(); }
    const unavailable = await fixture({ listQuota: null, failQuota: true });
    try {
        await unavailable.settle(); assert.equal(unavailable.latestStatus.failed, true); assert.equal(unavailable.latestRows.length, 3);
        assert.match(unavailable.container.textContent, /現在のプランと利用枠を読み直して/);
        assert.doesNotMatch(unavailable.container.textContent, /PRIVATE_QUOTA_FAILURE/);
        const first = unavailable.container.querySelector('[aria-label="受信中のX監視"]');
        assert.equal([...first.querySelectorAll('button')].find(button => button.textContent === '停止').disabled, false);
    } finally { await unavailable.close(); }
});

test('unified connection errors point to the common refresh and disappear after a successful retry', async () => {
    const f = await fixture({ failSetup: true });
    try {
        await f.settle(); assert.match(f.container.textContent, /受信情報を取得できませんでした。［更新］で再確認/);
        assert.doesNotMatch(f.container.textContent, /X一覧・利用枠を更新|PRIVATE_SETUP_FAILURE/);
        f.failSetup = false; await f.act(async () => f.latestStatus.reload());
        assert.doesNotMatch(f.container.textContent, /受信情報を取得できませんでした/);
    } finally { await f.close(); }
});

test('X availability is shown only in relevant list views and when a denied registration is attempted', async () => {
    const deniedQuota = { ...quota, featureEnabled: false, x: { ...quota.x, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY' } };
    const deniedSetup = { ...setup, available: false, receiverEnabled: false, chromeEnabled: false, braveEnabled: false,
        rollout: { mode: 'supporters', eligible: false, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY', reason: null } };
    const f = await fixture({ currentQuota: deniedQuota, setupData: deniedSetup, initialItems: [] });
    try {
        await f.settle(); assert.doesNotMatch(f.container.textContent, /受付対象となっている既存の寄付者/);
        f.listFilter = 'x'; await f.renderManager(); assert.match(f.container.textContent, /受付対象となっている既存の寄付者/);
        f.listFilter = 'other'; await f.renderManager(); assert.doesNotMatch(f.container.textContent, /受付対象となっている既存の寄付者/);
        f.listFilter = 'all'; f.registrationRequest = { id: 1 }; await f.renderManager(); await f.settle();
        const dialog = f.container.querySelector('dialog[aria-label="Xアカウントを登録"]') || f.container.querySelector('dialog[open]');
        assert(dialog); assert.match(dialog.textContent, /受付対象となっている既存の寄付者/);
    } finally { await f.close(); }
    const existing = await fixture({ currentQuota: deniedQuota, setupData: deniedSetup });
    try {
        await existing.settle(); assert.match(existing.container.textContent, /受付対象となっている既存の寄付者/);
        existing.listFilter = 'other'; await existing.renderManager(); assert.doesNotMatch(existing.container.textContent, /受付対象となっている既存の寄付者/);
    } finally { await existing.close(); }
});

test('the X registration dialog explains personal and shared capacity failures', async () => {
    for (const [deniedQuota, reason] of [
        [{ ...quota, personal: { ...quota.personal, available: 0 } }, /個人の上限/],
        [{ ...quota, x: { ...quota.x, available: 0 } }, /全体枠は現在すべて利用中/],
    ]) {
        const f = await fixture({ currentQuota: deniedQuota, initialItems: [] });
        try {
            await f.settle(); f.registrationRequest = { id: 1 }; await f.renderManager(); await f.settle();
            const dialog = f.container.querySelector('dialog[open]'); assert(dialog); assert.match(dialog.textContent, reason);
        } finally { await f.close(); }
    }
});

test('unavailable eligibility data is not presented as a definite supporter denial', async () => {
    const f = await fixture({ failSetup: true, initialItems: [] });
    try {
        await f.settle(); f.registrationRequest = { id: 1 }; await f.renderManager(); await f.settle();
        const dialog = f.container.querySelector('dialog[open]'); assert(dialog);
        assert.match(dialog.textContent, /利用資格を確認できません/);
        assert.doesNotMatch(dialog.textContent, /受付対象となっている既存の寄付者/);
    } finally { await f.close(); }
});

test('new X registration presents its connection first and labels review and registration clearly', async () => {
    const f = await fixture({ initialItems: [] });
    try {
        await f.settle(); f.registrationRequest = { id: 1, accountHandle: 'new_account' }; await f.renderManager(); await f.settle();
        const form = f.container.querySelector('form[aria-label="X監視の登録設定"]'); assert(form);
        const receiver = f.field('使用する自分の受信情報'), account = f.field('Xアカウント名'), destination = f.field('通知先');
        assert(receiver && account && destination);
        assert.equal(f.dom.window.document.activeElement, receiver); assert.equal(form.closest('dialog').scrollTop, 0);
        assert(receiver.compareDocumentPosition(account) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
        assert(account.compareDocumentPosition(destination) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.match(form.textContent, /使う接続を選択/); assert.equal(receiver.value, '');
        const review = [...form.querySelectorAll('button')].find(button => button.textContent === '登録内容を確認'); assert(review);
        assert.equal(review.disabled, true);
        await f.act(async () => form.querySelector('.nx-firefox-ack input').click());
        assert.equal(review.disabled, false); await f.submit();
        assert(form.querySelector('[aria-label="X監視の変更確認"]'));
        assert([...form.querySelectorAll('button')].some(button => button.textContent === '通知を登録'));
        assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
    } finally { await f.close(); }
});

test('connection focus waits for metadata and does not interrupt an early interaction', async () => {
    for (const interact of [false, true]) {
        const f = await fixture({ delayed: true, initialItems: [] });
        try {
            f.registrationRequest = { id: 1, accountHandle: 'early_input' }; await f.renderManager(); await f.settle();
            const account = f.field('Xアカウント名'); assert(account);
            if (interact) await f.act(async () => { account.focus(); account.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true })); });
            f.delayReads = false; await f.act(async () => f.release()); await f.settle();
            assert.equal(f.dom.window.document.activeElement, interact ? account : f.field('使用する自分の受信情報'));
            assert.equal(account.value, 'early_input');
        } finally { if (f.release) f.release(); await f.close(); }
    }
});

test('a disabled receiver selector does not receive focus when X registration is unavailable', async () => {
    const deniedQuota = { ...quota, featureEnabled: false, x: { ...quota.x, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY' } };
    const deniedSetup = { ...setup, available: false, receiverEnabled: false, chromeEnabled: false, braveEnabled: false,
        rollout: { mode: 'supporters', eligible: false, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY', reason: null } };
    const f = await fixture({ currentQuota: deniedQuota, setupData: deniedSetup, initialItems: [] });
    try {
        await f.settle(); f.registrationRequest = { id: 1 }; await f.renderManager(); await f.settle();
        assert.equal(f.field('使用する自分の受信情報').disabled, true);
        assert.equal(f.dom.window.document.activeElement.textContent, 'PCの通知データを登録');
        assert([...f.container.querySelectorAll('button')].find(button => button.textContent === '登録内容を確認').disabled);
    } finally { await f.close(); }
});
