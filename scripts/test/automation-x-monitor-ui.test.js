'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const quality = changes => ({ planId: 'basic', priority: 2, minuteLimit: 7, dayLimit: 48, intervalMinutes: 60, ...changes });
const quota = changes => ({ featureEnabled: false, currentPlan: { ...quality(), label: 'ベーシック', tier: 'paid', baseSlotLimit: 5 },
    personal: { totalLimit: 8, registeredCount: 6, used: 6, available: 2, supporterExtraSlots: 3 },
    x: { used: 2, available: 2, specialLimit: 3, specialUsed: 0, reasonCode: 'X_MONITOR_UNAVAILABLE', reason: null },
    pools: { free: { limit: 50, used: 49, available: 1 }, supporter: { limit: 100, used: 1, available: 99 } }, ...changes });
const row = changes => ({ id: 'xm-1', accountId: '18446744073709551615', accountHandle: 'fixture_user', name: '本人のX監視', enabled: true,
    state: 'ready', poolKind: 'free', notificationSettings: { workflowId: 'rule-own', destinationId: 'dm-own' }, subscriptionState: 'unconfigured', revision: 1, quality: quality(), ...changes });
const SUBSCRIPTION_ID = 'cc2cb493-a60d-41d6-936f-2ed33d7ea2c7';
const subscription = changes => ({ id: SUBSCRIPTION_ID, state: 'stored', revision: 1, createdAtMs: 1791921600000, updatedAtMs: 1791921600000, browserVersion: '160.0a1', receiverState: 'awaiting', boundMonitorCount: 0, ...changes });
const setup = changes => ({ available: true, receiverEnabled: false, rollout: { mode: 'public', eligible: true, reasonCode: null, reason: null }, download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.2', sha256: 'a'.repeat(64) }, subscriptions: [], maxFileBytes: 32768, nextCursor: null, ...changes });
const processingQuote = changes => ({ requestedMode: 'realtime', explicitMode: 'realtime', modeSource: 'monitor', effectiveMode: 'realtime', realtimeSource: 'slots', realtimeEligibilitySource: 'slots',
    slotCost: 5, effectiveSlotCost: 5, realtimeSlotCost: 5, canEnableRealtime: true, additionalSlotsNeeded: 4, configured: true, intervalMinutes: 60, reasonCode: null, isPreview: true, ...changes });
const supporterQuote = changes => processingQuote({ realtimeSource: 'supporter', realtimeEligibilitySource: 'supporter', slotCost: 1, effectiveSlotCost: 1, realtimeSlotCost: 1,
    additionalSlotsNeeded: 0, poolKind: 'supporter', eligible: true, available: true, reason: null, ...changes });
async function fixture({ currentQuota = quota(), items = [row()], respond, opened = true, active = true, parent = false, scope = 'private', guildId, compact = false, registrationRequest, hideAddAction = false } = {}) {
    const f = await reactFixture('export { XMonitorManager } from "./components/automation/x-monitor-manager"; export { MonitorManager } from "./components/automation/monitor-manager"; export { parseXQuota,parseXMonitor,xFeedback } from "./components/automation/x-monitor-view";');
    f.calls = []; f.items = items; f.quota = currentQuota; f.setup = setup();
    const destinations = [{ id: 'dm-own', name: '本人のDM', scope: 'private', enabled: true }, { id: 'guild-dest', name: 'サーバー専用通知先', scope: 'guild', enabled: true }];
    const rules = [{ id: 'rule-own', name: '本人のルール', scope: 'private' }, { id: 'guild-rule', name: 'サーバー専用ルール', scope: 'guild' }];
    f.api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body }); const overridden = respond && await respond(route, method, body, f); if (overridden !== undefined) return overridden;
        if (route === 'x-monitor-quota') { if (!f.quota) throw new Error('PRIVATE_QUOTA'); return f.quota; }
        if (route === 'x-setup') return f.setup;
        if (route === 'x-processing-settings') return { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false,
            planId: 'basic', planLabel: 'ベーシック', intervalMinutes: 60, configured: true, reasonCode: null, rollout: f.setup.rollout };
        if (route === 'x-monitors' && method === 'GET') return { items: f.items, ...(f.quota ? { quota: f.quota } : {}) };
        if (route === 'x-monitors' && method === 'POST') { const saved = row({ ...body, accountId: null, id: `xm-new-${f.items.length + 1}`, notificationSettings: body.notificationSettings || {}, revision: 1 }); f.items = [...f.items, saved]; return saved; }
        if (route.startsWith('x-monitors/') && method === 'PATCH') {
            const old = f.items.find(item => route.endsWith('/' + item.id)); const saved = { ...old, ...body, revision: old.revision + 1 };
            f.items = f.items.map(item => item.id === saved.id ? saved : item); return saved;
        }
        if (route.startsWith('x-monitors/') && method === 'DELETE') { const id = route.split('/')[1]; f.items = f.items.filter(item => item.id !== id); return { released: true, id }; }
        if (route === 'providers') return { auto: [], price: [], autoRegistration: { eligible: true } };
        if (route === 'entitlements') return { plan: { name: '従来プラン', dayLimit: 24, minuteLimit: 5, priority: 0 }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } };
        if (route.startsWith('monitors/')) return { items: [], nextCursor: null };
        throw new Error('PRIVATE_UNEXPECTED_REQUEST');
    };
    f.registrationRequest = registrationRequest;
    f.renderManager = async (nextActive = active) => f.render(f.React.createElement(parent ? f.exports.MonitorManager : f.exports.XMonitorManager,
        { api: f.api, active: nextActive, destinations, rules, ...(parent ? { scope, guildId, canEdit: true, refresh: async () => {} } : { registrationRequest: f.registrationRequest, hideAddAction, ...(compact ? { initiallyOpen: true, setupPlacement: 'compact' } : {}) }) }));
    await f.renderManager(); await f.settle();
    if (parent && opened && scope === 'private') { await f.click('X通知'); await f.settle(); }
    if (opened && scope === 'private' && [...f.container.querySelectorAll('button')].some(item => item.textContent === 'Xアカウントの監視を管理')) { await f.click('Xアカウントの監視を管理'); await f.settle(); }
    f.inClick = async (node, text) => { const button = [...node.querySelectorAll('button')].find(item => item.textContent.trim() === text); assert(button, text); await f.act(async () => button.click()); };
    f.form = () => f.container.querySelector('form[aria-label="X監視の登録設定"]');
    f.submitX = async () => f.act(async () => f.form().dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    f.target = () => f.container.querySelector('article[aria-label="本人のX監視のX監視"]');
    return f;
}
const writes = f => f.calls.filter(item => item.method !== 'GET');

test('X owner controls load lazily, show actual plan/personal/supporter/free capacity, and default-off blocks new registration', async () => {
    const f = await fixture({ opened: false });
    try {
        assert.equal(f.calls.length, 0); await f.click('Xアカウントの監視を管理');
        assert.deepEqual(f.calls.map(item => item.route).sort(), ['x-monitor-quota', 'x-monitors', 'x-processing-settings', 'x-setup']);
        assert.match(f.container.textContent, /現在のプラン: ベーシック/); assert.match(f.container.textContent, /8枠（基本5＋支援追加3）/);
        assert.match(f.container.textContent, /現在の登録数6件/); assert.match(f.container.textContent, /現在の使用枠6／8枠（空き2枠）/); assert.match(f.container.textContent, /支援者追加枠の保有数3枠/);
        assert.match(f.container.textContent, /X監視の利用数・空き枠2件／空き2件/); assert.match(f.container.textContent, /無料共有枠の全体空き1／50枠/);
        assert.match(f.container.textContent, /現在プランの確認間隔60分/); assert.match(f.container.textContent, /寄付へのお礼で付与された追加枠.*解約後も引き継ぎ/); assert.match(f.container.textContent, /申込資格と全体枠の空きは、それぞれ確認/); assert(!f.container.textContent.includes('買い切り'));
        assert.match(f.container.textContent, /受信を開始すると通知を随時受け取り.*間隔ごとに.*まとめて処理/);
        assert.match(f.container.textContent, /ルールの条件と送信上限を適用/);
        assert.match(f.container.textContent, /新しい監視の受付は、受信テストの完了後/); assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === 'X監視を追加').disabled, true);
        assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('personal-limit and full-global-pool reasons remain distinct even while receiver provision is off', async () => {
    for (const [code, expected] of [['X_MONITOR_PERSONAL_LIMIT', /個人の上限に達しています/], ['X_MONITOR_POOL_FULL', /全体枠は現在すべて利用中.*全体に空きができると追加/]]) {
        const current = quota(); current.x.reasonCode = code; current.x.available = 0;
        const f = await fixture({ currentQuota: current });
        try { assert.match(f.container.textContent, expected); assert.match(f.container.textContent, /新しい監視の受付は、受信テストの完了後/); assert.equal(writes(f).length, 0); }
        finally { await f.close(); }
    }
});

test('a username alone creates an owner-bound X target with existing destinations/rules and no numeric ID input', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ currentQuota: current, items: [] });
    try {
        await f.click('X監視を追加'); assert.equal(f.form().textContent.includes('XアカウントID'), false); await f.fill(f.field('Xアカウント名'), '@target');
        await f.fill(f.field('監視の表示名'), '自分用の登録'); await f.fill(f.field('通知先'), 'dm-own'); await f.fill(f.field('詳細ルール'), 'rule-own');
        assert(!f.form().textContent.includes('サーバー専用')); await f.submitX(); assert.equal(writes(f).length, 0); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[0], { route: 'x-monitors', method: 'POST', body: { accountHandle: 'target', name: '自分用の登録', notificationSettings: { destinationId: 'dm-own', workflowId: 'rule-own' } } });
        for (const field of ['accountId', 'ownerUserId', 'poolKind', 'planId', 'amountYen', 'priority']) assert.equal(Object.hasOwn(writes(f)[0].body, field), false);
        assert.match(f.container.textContent, /X監視の設定を保存しました/); assert.equal(f.form(), null);
    } finally { await f.close(); }
});

test('a required username keeps invalid and reserved names in the form without creating a registration', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ currentQuota: current });
    try {
        await f.click('X監視を追加');
        assert.equal(f.field('Xアカウント名').required, true);
        for (const value of ['', 'invalid-user', 'a b', 'a'.repeat(16), 'i', 'INTENT']) {
            await f.fill(f.field('Xアカウント名'), value); await f.submitX();
            assert.equal(writes(f).length, 0); assert.equal(f.container.querySelector('[aria-label="X監視の変更確認"]'), null);
            assert.equal(f.field('Xアカウント名').value, value);
        }
        assert.match(f.form().textContent, /相手の現在の@ユーザー名を入力/);
    } finally { await f.close(); }
});

test('a fifteen-character username accepts a leading @ and the saved handle-only monitor exposes no internal identifier', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ currentQuota: current, items: [] });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), '@abcdefghijklmno'); await f.submitX();
        assert.match(f.container.querySelector('[aria-label="X監視の変更確認"]').textContent, /Xアカウント @abcdefghijklmno/);
        await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[0].body, { accountHandle: 'abcdefghijklmno' });
        assert.equal(f.items[0].accountId, null); assert.match(f.container.textContent, /@abcdefghijklmno/);
        assert.doesNotMatch(f.container.textContent, /XアカウントID|ID null|handle:|h:/);
    } finally { await f.close(); }
});

test('monitor parsing accepts public handle-only identity and legacy numeric identity while rejecting opaque server identifiers', async () => {
    const f = await fixture();
    try {
        const parse = f.exports.parseXMonitor;
        assert.equal(parse(row({ accountId: null })).accountId, null);
        assert.equal(parse(row({ accountHandle: null })).accountId, row().accountId);
        for (const accountId of [undefined, 12345, '', 'h:0123456789abcdef01', 'handle:fixture_user', '0', '-1']) {
            assert.throws(() => parse(row({ accountId })));
        }
        assert.throws(() => parse(row({ accountId: null, accountHandle: null })));
        assert.throws(() => parse(row({ accountId: null, accountHandle: '' })));
        assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('a handle-only monitor preserves its required username and explains conflicts without exposing server details', async () => {
    const original = row({ accountId: null });
    const f = await fixture({ items: [original], respond: (_route, method) => {
        if (method === 'PATCH') throw { code: 'X_MONITOR_HANDLE_CONFLICT', status: 409, message: 'PRIVATE_HANDLE_DETAIL' };
    } });
    try {
        await f.inClick(f.target(), 'X監視を編集'); assert.equal(f.field('Xアカウント名').required, true);
        await f.fill(f.field('Xアカウント名'), ''); await f.submitX();
        assert.equal(writes(f).length, 0); assert.equal(f.container.querySelector('[aria-label="X監視の変更確認"]'), null);
        await f.fill(f.field('Xアカウント名'), 'other_handle'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.match(f.container.textContent, /このXアカウントはすでに登録されています.*登録済みの監視を確認/);
        assert.equal(f.field('Xアカウント名').value, 'other_handle'); assert(!f.container.textContent.includes('PRIVATE_HANDLE_DETAIL'));
        assert.equal(f.items[0].accountHandle, original.accountHandle); assert.equal(f.items[0].accountId, null);
        assert.deepEqual(writes(f)[0].body, { expectedRevision: 1, name: original.name, accountHandle: 'other_handle' });
    } finally { await f.close(); }
});

test('registration capacity rejection retains input and a failed refresh never exposes internal exceptions', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    let rejected = false;
    const f = await fixture({ currentQuota: current, respond: (route, method) => {
        if (route === 'x-monitors' && method === 'POST') { rejected = true; throw Object.assign(new Error('PRIVATE_CAPACITY_DETAIL'), { status: 422, code: 'X_MONITOR_POOL_FULL' }); }
        if (rejected && route === 'x-monitor-quota') throw new Error('PRIVATE_READ_DETAIL');
    } });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'example'); await f.fill(f.field('監視の表示名'), '保持する入力');
        await f.submitX(); await f.click('このX監視設定で保存'); assert.match(f.container.textContent, /全体枠は現在すべて利用中/);
        assert.equal(f.field('監視の表示名').value, '保持する入力'); await f.click('X一覧・利用枠を更新');
        assert.equal(f.field('Xアカウント名').value, 'example'); assert(!f.container.textContent.includes('PRIVATE_'));
    } finally { await f.close(); }
});

test('ordinary owner editing keeps quality, allocation and subscription untouched and sends CAS with changed settings only', async () => {
    const f = await fixture();
    try {
        await f.inClick(f.target(), 'X監視を編集'); await f.fill(f.field('監視の表示名'), '改名した監視'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[0], { route: 'x-monitors/xm-1', method: 'PATCH', body: { expectedRevision: 1, name: '改名した監視' } });
        assert.deepEqual(f.items[0].quality, quality()); assert.equal(f.items[0].poolKind, 'free'); assert.equal(f.items[0].subscriptionState, 'unconfigured');
        assert.deepEqual(f.items[0].notificationSettings, row().notificationSettings);
    } finally { await f.close(); }
});

test('an owner CAS conflict retains the draft and refresh uses the latest revision without dropping notifications', async () => {
    let rejected = false;
    const f = await fixture({ respond: (route, method, body, current) => {
        if (route === 'x-monitors/xm-1' && method === 'PATCH' && !rejected) { rejected = true; current.items = [row({ revision: 3 })]; throw Object.assign(new Error('PRIVATE_CONFLICT'), { status: 409 }); }
    } });
    try {
        await f.inClick(f.target(), 'X監視を編集'); await f.fill(f.field('監視の表示名'), '保持された改名'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.match(f.container.textContent, /入力内容を保持/); await f.click('X一覧・利用枠を更新'); assert.equal(f.field('監視の表示名').value, '保持された改名');
        await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f).at(-1).body.expectedRevision, 3);
    } finally { await f.close(); }
});

test('an existing owner corrects only the handle with an explicit review while numeric ID and allocations stay fixed', async () => {
    const original = row({ notificationSettings: { ...row().notificationSettings, subscriptionId: SUBSCRIPTION_ID }, subscriptionState: 'bound' });
    const f = await fixture({ items: [original] });
    try {
        await f.inClick(f.target(), 'X監視を編集');
        assert.equal(f.form().textContent.includes('XアカウントID'), false); assert.equal(f.field('Xアカウント名').disabled, false);
        assert.match(f.target().querySelector('details').textContent, /XアカウントID：18446744073709551615/);
        assert.match(f.form().textContent, /相手の現在の@ユーザー名を入力/); assert.equal(f.field('Xアカウント名').disabled, false);
        await f.fill(f.field('Xアカウント名'), '@correct_handle'); await f.submitX();
        const review = f.container.querySelector('[aria-label="X監視の変更確認"]');
        assert.match(review.textContent, /変更後のXアカウント名：@correct_handle/);
        assert.match(review.textContent, /現在の利用枠と、変更していない通知設定・受信情報を引き継ぎ/);
        assert.equal(writes(f).length, 0); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[0], { route: 'x-monitors/xm-1', method: 'PATCH', body: { expectedRevision: 1, name: original.name, accountHandle: 'correct_handle' } });
        for (const key of ['accountId', 'poolKind', 'notificationSettings', 'subscriptionState', 'quality', 'enabled']) assert.deepEqual(f.items[0][key], original[key]);
        await f.inClick(f.target(), 'X監視を編集'); await f.fill(f.field('Xアカウント名'), ''); await f.submitX();
        assert.match(f.container.querySelector('[aria-label="X監視の変更確認"]').textContent, /変更後のXアカウント名：未設定/);
        await f.click('このX監視設定で保存'); assert.equal(writes(f).at(-1).body.accountHandle, null);
        assert.equal(f.items[0].accountHandle, null); assert.equal(f.items[0].accountId, original.accountId);
    } finally { await f.close(); }
});

test('invalid handle edits do not write and a revision conflict preserves the corrected handle for explicit retry', async () => {
    let conflict = true;
    const f = await fixture({ respond: (route, method, _body, current) => {
        if (route === 'x-monitors/xm-1' && method === 'PATCH' && conflict) {
            conflict = false; current.items = [row({ revision: 3 })]; throw Object.assign(new Error('PRIVATE_HANDLE_CONFLICT'), { status: 409 });
        }
    } });
    try {
        await f.inClick(f.target(), 'X監視を編集');
        for (const handle of ['invalid-user', 'a b', 'a'.repeat(16)]) {
            await f.fill(f.field('Xアカウント名'), handle); await f.submitX();
            assert.equal(f.container.querySelector('[aria-label="X監視の変更確認"]'), null); assert.equal(writes(f).length, 0);
        }
        await f.fill(f.field('Xアカウント名'), 'correct_handle'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.match(f.container.textContent, /入力内容を保持/); assert.equal(f.field('Xアカウント名').value, 'correct_handle');
        assert(!f.container.textContent.includes('PRIVATE_HANDLE_CONFLICT'));
        await f.click('X一覧・利用枠を更新'); assert.equal(f.field('Xアカウント名').value, 'correct_handle');
        await f.submitX(); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f).at(-1).body, { expectedRevision: 3, name: row().name, accountHandle: 'correct_handle' });
    } finally { await f.close(); }
});

test('default-off and missing quota keep stop/delete available and deletion requires confirmation and correct revision', async () => {
    const f = await fixture({ currentQuota: null });
    try {
        assert.match(f.container.textContent, /プランと利用枠を読み直してください/); assert(!f.container.textContent.includes('PRIVATE_QUOTA'));
        await f.inClick(f.target(), 'X監視を停止'); assert.deepEqual(writes(f)[0].body, { expectedRevision: 1, enabled: false });
        const stopped = f.target(); assert.equal([...stopped.querySelectorAll('button')].find(item => item.textContent === 'X監視を再開').disabled, true);
        await f.inClick(stopped, 'X監視を削除'); assert.equal(writes(f).length, 1); await f.inClick(stopped, 'このX監視を削除');
        assert.deepEqual(writes(f).at(-1), { route: 'x-monitors/xm-1', method: 'DELETE', body: { expectedRevision: 2 } }); assert.equal(f.items.length, 0);
    } finally { await f.close(); }
});

test('an already allocated paused monitor can resume at the personal cap without needing an additional slot', async () => {
    const current = quota({ featureEnabled: true, personal: { totalLimit: 8, registeredCount: 8, used: 8, available: 0, supporterExtraSlots: 3 } }); current.x.available = 0; current.x.reasonCode = 'X_MONITOR_PERSONAL_LIMIT';
    const f = await fixture({ currentQuota: current, items: [row({ enabled: false })] });
    try { await f.inClick(f.target(), 'X監視を再開'); assert.deepEqual(writes(f)[0].body, { expectedRevision: 1, enabled: true }); }
    finally { await f.close(); }
});

test('quality/interval follow current paid plan even when free/supporter/special assignment changes', async () => {
    const f = await fixture();
    try {
        for (const poolKind of ['free', 'supporter', 'special']) { f.items = [row({ poolKind })]; await f.click('X一覧・利用枠を更新');
            assert.match(f.target().textContent, /確認間隔60分/); assert.match(f.target().textContent, /1分7通／1日48通/);
            assert.match(f.container.textContent, /確認間隔と送信上限には、現在の契約プランを適用します/); }
        f.items = [row({ quality: quality({ planId: 'free', priority: 0, intervalMinutes: null }) })]; await f.click('X一覧・利用枠を更新');
        assert.match(f.target().textContent, /確認間隔未設定/); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('inactive X views do not fetch or write, and a late fetch after leaving cannot replace current owner data', async () => {
    let release, first = true;
    const f = await fixture({ respond: async route => {
        if (route === 'x-monitors' && first) { first = false; await new Promise(resolve => { release = resolve; }); return { items: [row({ name: '遅れて届くデータ' })], quota: quota() }; }
    } });
    try {
        await f.renderManager(false); const before = f.calls.length; await f.act(async () => release()); assert(!f.container.textContent.includes('遅れて届くデータ'));
        await f.renderManager(true); await f.settle(); assert(f.calls.length > before); assert.match(f.container.textContent, /本人のX監視/);
    } finally { if (release) release(); await f.close(); }
});

test('rapid register clicks write once and use only the returned canonical monitor after commit', async () => {
    let release;
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ currentQuota: current, respond: async (route, method, body, active) => {
        if (route === 'x-monitors' && method === 'POST') { await new Promise(resolve => { release = resolve; }); const saved = row({ ...body, accountId: null, id: 'canonical-row', name: 'サーバーが保存した名称', notificationSettings: {} }); active.items = [saved]; return { item: saved }; }
    } });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'example'); await f.submitX();
        const save = [...f.container.querySelectorAll('button')].find(item => item.textContent === 'このX監視設定で保存'); await f.act(async () => { save.click(); save.click(); });
        assert.equal(writes(f).length, 1); await f.act(async () => release()); assert.match(f.container.textContent, /サーバーが保存した名称/);
    } finally { if (release) release(); await f.close(); }
});

test('existing private monitor workspace exposes lazy X controls while guild-shared scope has no personal owner panel', async () => {
    for (const scope of ['private', 'guild']) {
        const f = await fixture({ parent: true, scope, opened: false });
        try { assert.equal(Boolean(f.container.querySelector('[aria-label="Xアカウントの監視"]')), scope === 'private');
            assert.equal(f.calls.filter(item => item.route.startsWith('x-')).length, 0); assert.match(f.container.textContent, /新着通知/); }
        finally { await f.close(); }
    }
});

test('a free vacancy does not mutate another assignment; owner can manually choose a later eligible pool', async () => {
    const f = await fixture({ respond: (route, method, body, current) => {
        if (route === 'x-monitors/xm-1/move' && method === 'POST') { const saved = { ...current.items[0], poolKind: body.poolKind, revision: 2 }; current.items = [saved]; return saved; }
    } });
    try {
        f.items = [row({ poolKind: 'supporter' })]; await f.click('X一覧・利用枠を更新');
        assert.equal(writes(f).length, 0); assert.equal(f.items[0].poolKind, 'supporter');
        const target = f.target(); await f.inClick(target, '利用枠の種類を変更'); await f.fill(target.querySelector('select'), 'special');
        await f.inClick(target, '利用枠の変更を確認'); assert.equal(writes(f).length, 0); await f.inClick(target, '指定した利用枠へ移動');
        assert.deepEqual(writes(f)[0], { route: 'x-monitors/xm-1/move', method: 'POST', body: { poolKind: 'special', expectedRevision: 1 } });
        assert.deepEqual(f.items[0].notificationSettings, row().notificationSettings); assert.deepEqual(f.items[0].quality, quality()); assert.equal(f.items[0].subscriptionState, 'unconfigured');
        assert.equal(f.calls.some(item => item.route.includes('rebalance')), false);
    } finally { await f.close(); }
});

test('manual move denial keeps the selected pool and suspension visibly retains pool/personal occupation', async () => {
    const f = await fixture({ items: [row({ poolKind: 'special', state: 'suspended' })], respond: (route, method) => {
        if (route.endsWith('/move') && method === 'POST') throw Object.assign(new Error('PRIVATE_MOVE_DENIED'), { status: 422, code: 'X_MONITOR_POOL_FULL' });
    } });
    try {
        const target = f.target(); assert.match(target.textContent, /現在の全体枠と個人枠を保持/);
        await f.inClick(target, '利用枠の種類を変更'); await f.fill(target.querySelector('select'), 'supporter');
        await f.inClick(target, '利用枠の変更を確認'); await f.inClick(target, '指定した利用枠へ移動');
        assert.equal(target.querySelector('select').value, 'supporter'); assert(!target.textContent.includes('PRIVATE_MOVE_DENIED')); assert.match(target.textContent, /全体枠は現在すべて利用中/);
        assert.equal(f.items[0].poolKind, 'special'); assert.equal(f.items[0].state, 'suspended'); assert.deepEqual(f.items[0].notificationSettings, row().notificationSettings);
    } finally { await f.close(); }
});

test('a stale manual move retains selection and requires refreshed CAS confirmation', async () => {
    let rejected = false;
    const f = await fixture({ respond: (route, method, body, current) => {
        if (route.endsWith('/move') && method === 'POST') {
            if (!rejected) { rejected = true; current.items = [row({ revision: 3 })]; throw Object.assign(new Error('PRIVATE_MOVE_CONFLICT'), { status: 409 }); }
            const saved = { ...current.items[0], poolKind: body.poolKind, revision: 4 }; current.items = [saved]; return saved;
        }
    } });
    try {
        const target = f.target(); await f.inClick(target, '利用枠の種類を変更'); await f.fill(target.querySelector('select'), 'supporter');
        await f.inClick(target, '利用枠の変更を確認'); await f.inClick(target, '指定した利用枠へ移動');
        await f.inClick(target, '監視設定を再取得'); assert.equal(target.querySelector('select').value, 'supporter');
        await f.inClick(target, '利用枠の変更を確認'); await f.inClick(target, '指定した利用枠へ移動'); assert.equal(writes(f).at(-1).body.expectedRevision, 3);
    } finally { await f.close(); }
});

test('cadence boost consumption is separate from actual registration count and still exhausts physical personal capacity', async () => {
    const current = quota({ featureEnabled: true, personal: { totalLimit: 8, registeredCount: 3, used: 8, available: 0, supporterExtraSlots: 3 } });
    current.x.available = 0; current.x.reasonCode = 'X_MONITOR_PERSONAL_LIMIT';
    const f = await fixture({ currentQuota: current });
    try {
        const panel = f.container.querySelector('[aria-label="X監視の個人利用枠"]');
        assert.match(panel.textContent, /現在の登録数3件/); assert(!panel.textContent.includes('現在の登録数8件'));
        assert.match(panel.textContent, /現在の使用枠8／8枠（空き0枠）/); assert.match(panel.textContent, /確認間隔の短縮に配分した追加枠も使用枠数に含みます/);
        assert.equal([...f.container.querySelectorAll('button')].find(item => item.textContent === 'X監視を追加').disabled, true);
        assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('private workspace on a guild page links to personal setup without using the guild-bound setup API', async () => {
    const f = await fixture({ parent: true, scope: 'private', guildId: '333333333333333333' });
    try {
        assert.equal(f.container.querySelector('[aria-label="X通知の受信設定"]'), null);
        const link = f.container.querySelector('a[href="/dashboard/automation/x"]'); assert(link); assert.match(link.textContent, /接続を確認/);
        assert.equal(f.calls.some(call => call.route.startsWith('x-setup')), false);
    } finally { await f.close(); }
});

test('an owner selects a stored receiver explicitly for a target and multiple authors can share that receiver', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ currentQuota: current, items: [], respond: route => route === 'x-setup' ? setup({ subscriptions: [subscription()] }) : undefined });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'example');
        assert.match(f.form().textContent, /受信情報を確認/);
        await f.fill(f.field('使用する自分の受信情報'), SUBSCRIPTION_ID); await f.fill(f.field('通知先'), 'dm-own');
        await f.submitX(); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[0].body.notificationSettings, { destinationId: 'dm-own', subscriptionId: SUBSCRIPTION_ID });
        assert.match(f.container.textContent, /サーバー接続待ち.*サーバーとの接続を待っています/);
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'second_author'); await f.fill(f.field('使用する自分の受信情報'), SUBSCRIPTION_ID);
        await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f)[1].body.notificationSettings.subscriptionId, SUBSCRIPTION_ID);
        assert.equal(f.calls.some(call => call.route.includes('subscribe')), false);
    } finally { await f.close(); }
});

test('binding edit preserves notifications and revision, while owner rejection retains chosen receiver', async () => {
    let reject = true;
    const f = await fixture({ respond: (route, method) => {
        if (route === 'x-setup') return setup({ subscriptions: [subscription()] });
        if (method === 'PATCH' && reject) { reject = false; throw { code: 'NOT_FOUND', status: 404, message: 'PRIVATE_OTHER_OWNER' }; }
    } });
    try {
        await f.inClick(f.target(), 'X監視を編集'); await f.fill(f.field('使用する自分の受信情報'), SUBSCRIPTION_ID); await f.submitX(); await f.click('このX監視設定で保存');
        assert.equal(f.field('使用する自分の受信情報').value, SUBSCRIPTION_ID); assert.match(f.container.textContent, /この監視のアクセス権と登録済みの受信情報を確認/); assert(!f.container.textContent.includes('PRIVATE_OTHER_OWNER'));
        await f.submitX(); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[1].body, { expectedRevision: 1, name: row().name, notificationSettings: { ...row().notificationSettings, subscriptionId: SUBSCRIPTION_ID } });
        assert.deepEqual(f.items[0].notificationSettings, { ...row().notificationSettings, subscriptionId: SUBSCRIPTION_ID });
    } finally { await f.close(); }
});

test('a target without a receiver remains visibly pending and a listening receiver never claims successful delivery', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ currentQuota: current, items: [], respond: route => route === 'x-setup' ? setup({ subscriptions: [subscription({ receiverState: 'listening' })] }) : undefined });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'example'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.match(f.container.textContent, /次に、通知を受け取るための受信情報を登録/);
        f.items = [row({ notificationSettings: { ...row().notificationSettings, subscriptionId: SUBSCRIPTION_ID } })]; await f.click('X一覧・利用枠を更新');
        assert.match(f.target().textContent, /割り当て済み.*サーバー接続を確認済み.*投稿通知が届いたら.*配信結果を確認/);
    } finally { await f.close(); }
});

test('rollout denial blocks create and resume even against stale enabled quota and preserves stop/delete/edit', async () => {
    for (const [mode, code] of [['disabled', 'X_ROLLOUT_DISABLED'], ['supporters', 'X_ROLLOUT_SUPPORTERS_ONLY']]) {
        const current = quota({ featureEnabled: true }); current.x.reasonCode = code;
        const f = await fixture({ currentQuota: current, items: [row({ enabled: false })], respond: route => route === 'x-setup' ? setup({ rollout: { mode, eligible: false, reasonCode: code, reason: null } }) : undefined });
        try {
            assert.equal([...f.container.querySelectorAll('button')].find(node => node.textContent === 'X監視を追加').disabled, true);
            assert.equal([...f.target().querySelectorAll('button')].find(node => node.textContent === 'X監視を再開').disabled, true);
            assert.match(f.container.textContent, mode === 'disabled' ? /公開準備中/ : /支援者向けベータ版.*受付対象の拡大待ち/);
            await f.inClick(f.target(), 'X監視を編集'); assert.equal(f.field('使用する自分の受信情報').disabled, true); await f.click('X監視の入力を取り消す');
            assert.equal(writes(f).length, 0); await f.inClick(f.target(), 'X監視を削除'); await f.inClick(f.target(), 'このX監視を削除'); assert.equal(writes(f)[0].method, 'DELETE');
        } finally { await f.close(); }
    }
});

test('failed setup metadata blocks new receiver selection and registration without losing existing binding on ordinary edits', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ currentQuota: current, items: [row({ notificationSettings: { ...row().notificationSettings, subscriptionId: SUBSCRIPTION_ID } })], respond: route => { if (route === 'x-setup') throw new Error('PRIVATE_SETUP_FAILURE'); } });
    try {
        assert.match(f.container.textContent, /受信情報の候補をもう一度読み込んでください/); assert(!f.container.textContent.includes('PRIVATE_SETUP_FAILURE'));
        assert.equal([...f.container.querySelectorAll('button')].find(node => node.textContent === 'X監視を追加').disabled, true);
        await f.inClick(f.target(), 'X監視を編集'); assert.equal(f.field('使用する自分の受信情報').disabled, true);
        await f.fill(f.field('監視の表示名'), '受信設定を維持'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[0].body, { expectedRevision: 1, name: '受信設定を維持' });
        assert.equal(f.items[0].notificationSettings.subscriptionId, SUBSCRIPTION_ID);
    } finally { await f.close(); }
});

test('the compact X tab opens monitoring directly with actual quota and timing summaries and a dedicated connection link', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current });
    try {
        assert.equal(f.container.querySelector('[aria-label="X通知の受信設定"]'), null); assert.equal(f.container.querySelector('input[type="file"]'), null);
        const panel = f.container.querySelector('[aria-label="X監視の個人利用枠"]');
        assert.match(panel.textContent, /X監視の登録数2件/); assert.match(panel.textContent, /1枠利用で追加可能2件/); assert.doesNotMatch(panel.textContent, /個人の総登録上限|無料共有枠|支援者追加枠の保有数/);
        assert(panel.querySelector('a[href="/dashboard/automation/plans"]')); assert(f.container.querySelector('a[href="/dashboard/automation/x"]'));
        assert.match(f.container.querySelector('[aria-label="X通知のタイミング"]').textContent, /通知方法の確認待ち/);
        assert.equal(f.container.querySelector('[aria-label="X通知のタイミング"] form'), null);
        assert.deepEqual(f.calls.map(call => call.route).sort(), ['x-monitor-quota', 'x-monitors', 'x-setup']);
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'compact_user'); await f.fill(f.field('通知先'), 'dm-own'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].body.accountHandle, 'compact_user'); assert.equal(writes(f)[0].body.notificationSettings.destinationId, 'dm-own');
    } finally { await f.close(); }
});

test('compact monitoring preserves a draft across tab inactivity and performs no IO while inactive', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'retained_tab'); await f.fill(f.field('監視の表示名'), 'タブ切替前');
        await f.renderManager(false); const before = f.calls.length; await f.click('X一覧・利用枠を更新'); assert.equal(f.calls.length, before);
        await f.renderManager(true); await f.settle(); assert.equal(f.field('Xアカウント名').value, 'retained_tab'); assert.equal(f.field('監視の表示名').value, 'タブ切替前'); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('the shared registration request waits for the active X panel, prefills a username and focuses its form once', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, active: false, currentQuota: current, registrationRequest: { id: 1, accountHandle: '@shared_entry' } });
    try {
        assert.equal(f.calls.length, 0); assert.equal(f.form(), null); await f.renderManager(true); await f.settle();
        assert.equal(f.field('Xアカウント名').value, 'shared_entry'); assert.equal(f.dom.window.document.activeElement, f.field('Xアカウント名'));
        await f.click('X監視の入力を取り消す'); await f.renderManager(false); await f.renderManager(true); assert.equal(f.form(), null);
        f.registrationRequest = { id: 2, accountHandle: 'next_entry' }; await f.renderManager(true); assert.equal(f.field('Xアカウント名').value, 'next_entry'); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('a repeated shared-entry request resumes an existing X draft without replacing its fields or review', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current, registrationRequest: { id: 1, accountHandle: 'original_entry' } });
    try {
        await f.fill(f.field('監視の表示名'), '保持する入力'); await f.fill(f.field('通知先'), 'dm-own'); await f.submitX();
        f.registrationRequest = { id: 2, accountHandle: 'not_applied' }; await f.renderManager(true);
        assert.equal(f.field('Xアカウント名').value, 'original_entry'); assert.equal(f.field('監視の表示名').value, '保持する入力'); assert.equal(f.field('通知先').value, 'dm-own'); assert(f.container.querySelector('[aria-label="X監視の変更確認"]'));
        assert.equal(f.dom.window.document.activeElement, f.field('Xアカウント名')); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('shared-entry requests keep capacity checks and permit the existing unbound pending registration only when eligible', async () => {
    for (const permitted of [true, false]) {
        const current = quota({ featureEnabled: true }); current.x.reasonCode = permitted ? null : 'X_MONITOR_PERSONAL_LIMIT'; if (!permitted) current.personal.available = 0;
        const f = await fixture({ compact: true, currentQuota: current, registrationRequest: { id: 1, accountHandle: 'pending_entry' } });
        try {
            assert.equal(f.field('Xアカウント名').value, 'pending_entry'); const review = [...f.form().querySelectorAll('button')].find(item => item.textContent === 'X監視の変更を確認'); assert.equal(review.disabled, !permitted);
            if (permitted) { await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f)[0].body.accountHandle, 'pending_entry'); assert.equal(Object.hasOwn(writes(f)[0].body, 'notificationSettings'), false); }
            else { await f.submitX(); assert.match(f.container.textContent, /個人の上限に達しています/); assert.equal(writes(f).length, 0); }
        } finally { await f.close(); }
    }
});

test('new registrations default explicitly to batch when monitor-level quotes are available and never inherit realtime accidentally', async () => {
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote() }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current, items: [] });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'batch_default'); assert(f.form().querySelector('input[name="x-registration-timing"][value="batch"]').checked);
        await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f)[0].body.processingMode, 'batch'); assert.equal(Object.hasOwn(writes(f)[0].body, 'expectedRealtimeSlotCost'), false);
    } finally { await f.close(); }
});

test('new realtime registration displays and confirms its exact five-slot cost before a top-level mode and cost are sent', async () => {
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote() }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current, items: [] });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'five_slots'); await f.act(async () => f.form().querySelector('input[name="x-registration-timing"][value="realtime"]').click());
        assert.match(f.form().textContent, /個人の登録枠を合計5枠.*加えて4枠/); assert.equal(writes(f).length, 0); await f.submitX(); assert.match(f.form().querySelector('[aria-label="X監視の変更確認"]').textContent, /使用する個人枠は合計5枠/); assert.equal(writes(f).length, 0);
        await f.click('このX監視設定で保存'); assert.equal(writes(f)[0].body.processingMode, 'realtime'); assert.equal(writes(f)[0].body.expectedRealtimeSlotCost, 5); assert.equal(writes(f)[0].body.notificationSettings, undefined);
    } finally { await f.close(); }
});

test('a legacy supporter with one personal slot directly registers realtime in the supporter pool while shared free capacity remains open', async () => {
    for (const compact of [false, true]) {
        const current = quota({ featureEnabled: true, registrationProcessing: processingQuote({ canEnableRealtime: false }), supporterRealtimeRegistration: supporterQuote() });
        current.x.reasonCode = null; current.x.available = 1; current.personal.available = 1;
        const f = await fixture({ compact, currentQuota: current, items: [] });
        try {
            await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'supporter_entry'); await f.fill(f.field('通知先'), 'dm-own');
            assert(f.form().querySelector('input[value="batch"]').checked); assert.equal(f.form().querySelector('input[value="realtime"]').disabled, false);
            await f.act(async () => f.form().querySelector('input[value="realtime"]').click());
            assert.match(f.form().textContent, /合計1枠（支援者特典）/); assert.match(f.form().textContent, /支援者優先枠で登録.*個人の登録枠は1枠/);
            assert.doesNotMatch(f.form().textContent, /合計5枠|加えて4枠/); await f.submitX(); assert.equal(writes(f).length, 0); await f.click('このX監視設定で保存');
            assert.deepEqual(writes(f)[0].body, { accountHandle: 'supporter_entry', notificationSettings: { destinationId: 'dm-own' }, processingMode: 'realtime', expectedRealtimeSlotCost: 1, poolPreference: 'supporter' });
            assert.equal(Object.hasOwn(writes(f)[0].body, 'poolKind'), false);
        } finally { await f.close(); }
    }
});

test('batch registration keeps ordinary pool priority even when a direct supporter realtime offer is available', async () => {
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote(), supporterRealtimeRegistration: supporterQuote() }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current, items: [] });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'batch_supporter'); await f.submitX(); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[0].body, { accountHandle: 'batch_supporter', processingMode: 'batch' });
    } finally { await f.close(); }
});

test('a selected supporter pool becoming full retains the one-slot choice and prevents implicit five-slot or shared-free fallback', async () => {
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote(), supporterRealtimeRegistration: supporterQuote() }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current, items: [], respond: (route, method, _body, state) => {
        if (route === 'x-monitors' && method === 'POST') {
            state.quota = { ...current, supporterRealtimeRegistration: supporterQuote({ available: false, canEnableRealtime: false, reasonCode: 'X_MONITOR_SUPPORTER_POOL_FULL', reason: '支援者優先枠は現在すべて利用中です。' }) };
            throw { code: 'X_MONITOR_SUPPORTER_POOL_FULL', status: 409, message: 'PRIVATE_POOL_DETAIL' };
        }
    } });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'keep_supporter'); await f.act(async () => f.form().querySelector('input[value="realtime"]').click());
        await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f)[0].body.poolPreference, 'supporter');
        assert.match(f.container.querySelector('[role="alert"]').textContent, /支援者優先枠は現在すべて利用中.*入力内容は保持/); assert.doesNotMatch(f.container.textContent, /PRIVATE_POOL_DETAIL|監視の設定が更新されています/);
        await f.click('枠数を再確認'); assert.match(f.form().textContent, /支援者優先枠は現在すべて利用中/);
        assert(f.form().querySelector('input[value="realtime"]').checked); assert.equal(f.form().querySelector('input[value="realtime"]').disabled, true);
        assert.match(f.form().textContent, /利用資格と枠数を再確認/); assert.doesNotMatch(f.form().textContent, /合計[15]枠|個人の登録枠は1枠/); await f.submitX(); assert.equal(writes(f).length, 1);
        assert.equal(f.field('Xアカウント名').value, 'keep_supporter');
    } finally { await f.close(); }
});

test('revoked supporter eligibility never displays the returned five-slot quote as the selected supporter price', async () => {
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote(), supporterRealtimeRegistration: supporterQuote() }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current, items: [] });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'revoked_donor'); await f.act(async () => f.form().querySelector('input[value="realtime"]').click()); await f.submitX();
        f.quota = { ...current, supporterRealtimeRegistration: processingQuote({ poolKind: 'supporter', eligible: false, available: false, canEnableRealtime: false, reasonCode: 'X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE', reason: 'この特典の対象となる既存支援者の資格を確認してください。' }) };
        await f.click('X一覧・利用枠を更新'); assert(f.form().querySelector('input[value="realtime"]').checked); assert(f.form().querySelector('input[value="realtime"]').disabled);
        assert.match(f.form().textContent, /対象となる既存支援者の資格を確認/); assert.match(f.form().textContent, /利用資格と枠数を再確認/);
        assert.doesNotMatch(f.form().textContent, /合計[15]枠|個人の登録枠は1枠|追加.*4枠/); await f.submitX(); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('supporter registration errors distinguish ineligible, owned-limit and already registered from edit conflicts without exposing exception text', async () => {
    const f = await fixture();
    try {
        for (const [code, expected] of [['X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE', /既存支援者の資格/], ['X_MONITOR_SUPPORTER_LIMIT', /保有する支援者追加枠をすべて使用/], ['X_MONITOR_REGISTRATION_CONFLICT', /このXアカウントは登録済み.*利用枠と通知方法を変更/]]) {
            const message = f.exports.xFeedback({ code, status: code.includes('INELIGIBLE') ? 403 : 409, message: 'PRIVATE_ERROR' }); assert.match(message, expected); assert.doesNotMatch(message, /PRIVATE_ERROR|監視の設定が更新されています/);
        }
    } finally { await f.close(); }
});

test('malformed, ineligible and unavailable supporter offers never infer a direct registration right', async () => {
    for (const direct of [supporterQuote({ eligible: false }), supporterQuote({ available: 'true' }), supporterQuote({ poolKind: 'free' }), supporterQuote({ realtimeSlotCost: 5 }), supporterQuote({ eligible: false, available: false, canEnableRealtime: false }), supporterQuote({ available: false, canEnableRealtime: false })]) {
        const current = quota({ featureEnabled: true, registrationProcessing: processingQuote({ canEnableRealtime: false }), supporterRealtimeRegistration: direct }); current.x.reasonCode = null;
        const f = await fixture({ compact: true, currentQuota: current, items: [] });
        try { await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'no_right'); assert.equal(f.form().querySelector('input[value="realtime"]').disabled, true); await f.act(async () => f.form().querySelector('input[value="realtime"]').click()); assert.equal(writes(f).length, 0); }
        finally { await f.close(); }
    }
});

test('a directly registered supporter monitor can later switch notification methods and edit its destination without implicit pool movement', async () => {
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote({ canEnableRealtime: false }), supporterRealtimeRegistration: supporterQuote() }); current.x.reasonCode = null; current.personal.available = 1;
    const asProcessing = mode => { const { isPreview: _preview, ...processing } = supporterQuote({ requestedMode: mode, explicitMode: mode, effectiveMode: mode, realtimeSource: mode === 'realtime' ? 'supporter' : null }); return processing; };
    const f = await fixture({ compact: true, currentQuota: current, items: [], respond: (route, method, body, state) => {
        if (route === 'x-monitors' && method === 'POST') { const saved = row({ id: 'supporter-rt', accountId: null, accountHandle: body.accountHandle, poolKind: 'supporter', processing: asProcessing('realtime'), notificationSettings: body.notificationSettings }); state.items = [saved]; return saved; }
        if (route === 'x-monitors/supporter-rt' && method === 'PATCH' && body.processingMode) { const saved = { ...state.items[0], revision: state.items[0].revision + 1, processing: asProcessing(body.processingMode) }; state.items = [saved]; return saved; }
    } });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'lasting_support'); await f.fill(f.field('通知先'), 'dm-own'); await f.act(async () => f.form().querySelector('input[value="realtime"]').click()); await f.submitX(); await f.click('このX監視設定で保存');
        const target = f.target(); assert(target.querySelector('h4').textContent === '通知方法'); await f.inClick(target, '通知方法を変更'); await f.act(async () => target.querySelector('input[value="batch"]').click()); await f.inClick(target, '通知方法の変更を確認'); await f.inClick(target, 'プランの間隔で通知に変更');
        assert.deepEqual(writes(f)[1].body, { expectedRevision: 1, processingMode: 'batch' }); assert.equal(f.items[0].poolKind, 'supporter'); assert.equal(f.items[0].notificationSettings.destinationId, 'dm-own');
        await f.inClick(f.target(), '通知方法を変更'); await f.act(async () => f.target().querySelector('input[value="realtime"]').click()); await f.inClick(f.target(), '通知方法の変更を確認'); await f.inClick(f.target(), '1枠を使って即時通知');
        assert.deepEqual(writes(f)[2].body, { expectedRevision: 2, processingMode: 'realtime', expectedRealtimeSlotCost: 1 });
        await f.inClick(f.target(), 'X監視を編集'); await f.fill(f.field('通知先'), ''); await f.submitX(); await f.click('このX監視設定で保存');
        assert.deepEqual(writes(f)[3].body, { expectedRevision: 3, name: row().name, notificationSettings: {} });
        assert.equal(f.items[0].processing.effectiveMode, 'realtime'); assert.equal(f.items[0].poolKind, 'supporter'); assert.equal(f.items[0].accountHandle, 'lasting_support');
        assert.equal(writes(f).some(call => call.route.endsWith('/move')), false);
    } finally { await f.close(); }
});

test('a one-slot supporter or plan quote is used as returned, while denied or missing metadata never fabricates realtime permission', async () => {
    for (const source of ['supporter', 'plan']) {
        const current = quota({ featureEnabled: true, registrationProcessing: processingQuote({ realtimeSource: source, realtimeEligibilitySource: source, realtimeSlotCost: 1, effectiveSlotCost: 1, slotCost: 1, additionalSlotsNeeded: 0 }) }); current.x.reasonCode = null;
        const f = await fixture({ compact: true, currentQuota: current, items: [] });
        try { await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'benefit_entry'); await f.act(async () => f.form().querySelector('input[name="x-registration-timing"][value="realtime"]').click()); assert.match(f.form().textContent, /合計1枠/); await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f)[0].body.expectedRealtimeSlotCost, 1); }
        finally { await f.close(); }
    }
    for (const quote of [undefined, processingQuote({ realtimeSlotCost: '1' }), processingQuote({ canEnableRealtime: false })]) {
        const current = quota({ featureEnabled: true, ...(quote ? { registrationProcessing: quote } : {}) }); current.x.reasonCode = null;
        const f = await fixture({ compact: true, currentQuota: current, items: [] });
        try { await f.click('X監視を追加'); const radio = f.form().querySelector('input[name="x-registration-timing"][value="realtime"]'); if (quote?.canEnableRealtime === false) assert(radio.disabled); else assert.equal(radio, null); assert.equal(writes(f).length, 0); }
        finally { await f.close(); }
    }
});

test('a realtime registration cost conflict blocks another attempt until the server quote is explicitly refreshed', async () => {
    let conflict = true;
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote({ realtimeSlotCost: 1, slotCost: 1, effectiveSlotCost: 1, realtimeSource: 'plan', realtimeEligibilitySource: 'plan', additionalSlotsNeeded: 0 }) }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, currentQuota: current, items: [], respond: (route, method, _body, state) => {
        if (route === 'x-monitors' && method === 'POST' && conflict) { conflict = false; state.quota = { ...current, registrationProcessing: processingQuote() }; throw { status: 409, code: 'X_REALTIME_COST_CONFLICT' }; }
    } });
    try {
        await f.click('X監視を追加'); await f.fill(f.field('Xアカウント名'), 'changed_cost'); await f.act(async () => f.form().querySelector('input[name="x-registration-timing"][value="realtime"]').click()); await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f)[0].body.expectedRealtimeSlotCost, 1);
        assert.match(f.container.textContent, /必要な枠数が変わりました/); assert([...f.form().querySelectorAll('button')].find(item => item.textContent === 'X監視の変更を確認').disabled);
        await f.click('枠数を再確認'); assert.match(f.form().textContent, /合計5枠/); await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(writes(f)[1].body.expectedRealtimeSlotCost, 5);
    } finally { await f.close(); }
});

test('editing a name or destination preserves per-monitor realtime allocation without including a mode mutation', async () => {
    const current = quota({ featureEnabled: true, registrationProcessing: processingQuote() }); current.x.reasonCode = null;
    const { isPreview: _preview, ...processing } = processingQuote({ requestedMode: 'realtime', explicitMode: 'realtime' });
    const f = await fixture({ compact: true, currentQuota: current, items: [row({ processing })] });
    try { await f.inClick(f.target(), 'X監視を編集'); await f.fill(f.field('監視の表示名'), '改名のみ'); assert.equal(f.form().querySelector('input[name="x-registration-timing"]'), null); await f.submitX(); await f.click('このX監視設定で保存'); assert.equal(Object.hasOwn(writes(f)[0].body, 'processingMode'), false); assert.equal(Object.hasOwn(writes(f)[0].body, 'expectedRealtimeSlotCost'), false); assert.equal(f.items[0].processing.slotCost, 5); }
    finally { await f.close(); }
});

test('a shared registration can hide the duplicate X action and inherit only a fresh draft name and destination', async () => {
    const current = quota({ featureEnabled: true }); current.x.reasonCode = null;
    const f = await fixture({ compact: true, hideAddAction: true, currentQuota: current, registrationRequest: { id: 1, accountHandle: '@shared_target', name: '共通入口の名前', destinationId: 'dm-own' } });
    try {
        assert.equal([...f.container.querySelectorAll('button')].some(item => item.textContent === 'X監視を追加'), false);
        assert.equal(f.field('Xアカウント名').value, 'shared_target'); assert.equal(f.field('監視の表示名').value, '共通入口の名前'); assert.equal(f.field('通知先').value, 'dm-own');
        f.registrationRequest = { id: 2, accountHandle: 'other_target', name: '上書きしない', destinationId: 'different-dm' }; await f.renderManager(true);
        assert.equal(f.field('Xアカウント名').value, 'shared_target'); assert.equal(f.field('監視の表示名').value, '共通入口の名前'); assert.equal(f.field('通知先').value, 'dm-own'); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('compact connection status does not assume no connected receivers when only the first page is loaded', async () => {
    for (const receiverState of ['stopped', 'listening']) {
        const f = await fixture({ compact: true, respond: route => route === 'x-setup' ? setup({ subscriptions: [subscription({ receiverState })], nextCursor: 'next-receiver' }) : undefined });
        try { const summary = f.container.querySelector('[aria-label="Xの接続状況"]'); assert.match(summary.textContent, receiverState === 'listening' ? /サーバー接続を確認済み/ : /続きの受信情報を確認/); assert.doesNotMatch(summary.textContent, /接続の準備・確認中|受信情報を登録しましょう/); assert.equal(writes(f).length, 0); }
        finally { await f.close(); }
    }
});

test('a monitor with no destination or rule accurately shows the existing own-DM default', async () => {
    const f = await fixture({ compact: true, items: [row({ notificationSettings: {} })] });
    try { const facts = f.target().querySelector('.monitor-facts'); assert.match(facts.textContent, /通知先本人のDM/); assert.doesNotMatch(facts.textContent, /通知先設定待ち/); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});

test('a manual pool change discloses realtime requalification and renders the actual returned timing without reserving extra slots', async () => {
    const { isPreview: _preview, ...original } = processingQuote({ realtimeSource: 'supporter', realtimeEligibilitySource: 'supporter', slotCost: 1, effectiveSlotCost: 1, realtimeSlotCost: 1 });
    for (const result of [
        { ...original, effectiveMode: 'batch', realtimeSource: null, effectiveSlotCost: 1, realtimeSlotCost: 5, configured: true },
        { ...original, effectiveMode: 'batch', realtimeSource: null, effectiveSlotCost: 1, realtimeSlotCost: 5, configured: false, intervalMinutes: null },
        { ...original, realtimeSource: 'plan', realtimeEligibilitySource: 'plan' },
    ]) {
        const f = await fixture({ compact: true, items: [row({ poolKind: 'supporter', processing: original })], respond: (route, method, body, current) => {
            if (route.endsWith('/move') && method === 'POST') { const moved = { ...current.items[0], poolKind: body.poolKind, processing: result, revision: 2 }; current.items = [moved]; return moved; }
        } });
        try {
            await f.inClick(f.target(), '利用枠の種類を変更'); await f.fill(f.target().querySelector('select'), 'free'); await f.inClick(f.target(), '利用枠の変更を確認');
            const review = f.target().querySelector('[aria-label="X監視の手動移動確認"]'); assert.match(review.textContent, /移動先でリアルタイムの利用条件を確認/); assert.match(review.textContent, /追加4枠は自動で確保しません/); assert.match(review.textContent, /未設定なら設定待ち/); assert.equal(writes(f).length, 0);
            await f.inClick(f.target(), '指定した利用枠へ移動');
            assert.deepEqual(writes(f)[0].body, { poolKind: 'free', expectedRevision: 1 });
            const feedback = f.target().querySelector('[aria-label="X監視の手動枠変更"] [role="status"]');
            assert.match(feedback.textContent, result.effectiveMode === 'realtime' ? /リアルタイム通知・個人1枠/ : result.configured ? /プランの間隔（60分）で通知/ : /通知方法は設定待ち/);
        } finally { await f.close(); }
    }
});
