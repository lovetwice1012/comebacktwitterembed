'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

async function fixture({ scope = 'private', hash = '' } = {}) {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager"; export { xRegistrationHandle } from "./components/automation/notification-registration-source";');
    f.calls = [];
    if (hash) f.dom.window.history.replaceState({}, '', hash);
    const quality = { planId: 'free', priority: 0, minuteLimit: 5, dayLimit: 24, intervalMinutes: 5 };
    const api = async (path, method = 'GET', body) => {
        f.calls.push({ path, method, body });
        if (path === 'providers') return { auto: [{ id: 'github' }], price: [{ id: 'steam' }], autoRegistration: { eligible: true } };
        if (path === 'entitlements') return { plan: { name: '無料', priority: 0, minuteLimit: 5, dayLimit: 24 }, slots: { used: 0, max: 5, available: 5 }, usage: { entries: [] } };
        if (path.startsWith('monitors/')) return { items: [], nextCursor: null };
        if (path === 'x-monitors') return { items: [] };
        if (path === 'x-monitor-quota') return { featureEnabled: true, currentPlan: { ...quality, label: '無料', tier: 'free', baseSlotLimit: 5 },
            personal: { totalLimit: 5, registeredCount: 0, used: 0, available: 5, supporterExtraSlots: 0 },
            x: { used: 0, available: 5, reasonCode: null, reason: null, specialLimit: 0, specialUsed: 0 },
            pools: { free: { limit: 50, used: 0, available: 50 }, supporter: { limit: 100, used: 0, available: 100 } } };
        if (path === 'x-setup') return { available: true, receiverEnabled: true, rollout: { mode: 'public', eligible: true, reasonCode: null, reason: null },
            download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) }, subscriptions: [], maxFileBytes: 32768, nextCursor: null };
        if (path === 'x-processing-settings') return { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'free', planLabel: '無料', intervalMinutes: 5, configured: true, reasonCode: null, rollout: { mode: 'public', eligible: true } };
        throw new Error('Unexpected fixture request');
    };
    await f.render(f.React.createElement(f.exports.MonitorManager, { api, scope, canEdit: scope !== 'guild', guildId: scope === 'guild' ? '111111111111111111' : undefined, destinations: [], rules: [], refresh: async () => {} }));
    await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    return f;
}
const selected = f => f.container.querySelector('[role="tab"][aria-selected="true"]');
const press = (f, key) => f.act(async () => selected(f).dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

test('notification tabs expose their panels and support arrow, Home and End keys with one focus target', async () => {
    const f = await fixture();
    try {
        const tabs = [...f.container.querySelectorAll('[role="tab"]')]; assert.equal(tabs.length, 3);
        assert.deepEqual(tabs.map(tab => tab.textContent), ['新着通知', '価格通知', 'X通知']);
        assert.equal(tabs.filter(tab => tab.tabIndex === 0).length, 1);
        for (const tab of tabs) assert(f.dom.window.document.getElementById(tab.getAttribute('aria-controls')));
        selected(f).focus(); await press(f, 'ArrowRight'); assert.equal(selected(f).textContent, '価格通知');
        await press(f, 'End'); assert.equal(selected(f).textContent, 'X通知'); assert.equal(f.dom.window.document.activeElement, selected(f));
        await press(f, 'Home'); assert.equal(selected(f).textContent, '新着通知');
        await press(f, 'ArrowLeft'); assert.equal(selected(f).textContent, 'X通知');
    } finally { await f.close(); }
});

test('X belongs to its own active tab and keeps its draft across normal views without background X requests', async () => {
    const f = await fixture();
    try {
        const xCalls = () => f.calls.filter(call => call.path.startsWith('x-')).length;
        assert.equal(xCalls(), 0); await f.click('X通知'); await f.settle(); assert(xCalls() > 0);
        await f.click('通知を追加'); await f.fill(f.field('Xアカウント名'), 'keep_my_target');
        const draft = f.container.querySelector('form[aria-label="X監視の登録設定"]'); assert(draft);
        await f.click('価格通知'); await f.settle(); const before = xCalls();
        assert.equal(draft.closest('[role="tabpanel"]').hidden, true);
        await f.click('更新'); await f.settle(); assert.equal(xCalls(), before);
        await f.click('X通知'); await f.settle(); assert.equal(f.field('Xアカウント名').value, 'keep_my_target');
        assert.equal(draft.closest('[role="tabpanel"]').hidden, false);
        assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
    } finally { await f.close(); }
});

test('the connection page return link opens the X tab while shared notifications remain separately scoped', async () => {
    const f = await fixture({ hash: '#x-notifications' });
    try { assert.equal(selected(f).textContent, 'X通知'); assert.equal(f.container.querySelector('a[href="/dashboard/automation/x"]').textContent, '接続を確認'); }
    finally { await f.close(); }
    const shared = await fixture({ scope: 'guild', hash: '#x-notifications' });
    try { assert.equal(shared.container.querySelectorAll('[role="tab"]').length, 2); assert.equal(shared.container.querySelector('[aria-label="Xアカウントの監視"]'), null); assert.equal(shared.calls.filter(call => call.path.startsWith('x-')).length, 0); }
    finally { await shared.close(); }
});

test('the common add action routes an X profile URL to its editor without ordinary preview calls and keeps its name', async () => {
    const f = await fixture();
    try {
        await f.click('通知を追加');
        await f.fill(f.field('対象のURL・ID'), 'https://x.com/Example_User');
        await f.fill(f.field('名前（省略可）'), '共通入口の監視');
        await f.click('対象を確認'); await f.settle();
        assert.equal(selected(f).textContent, 'X通知');
        assert.equal(f.field('Xアカウント名（@ユーザー名）').value, 'Example_User');
        assert.equal(f.field('監視の表示名').value, '共通入口の監視');
        assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
        assert.equal([...f.container.querySelectorAll('button')].filter(node => node.textContent === '通知を追加').length, 1);
        assert.equal([...f.container.querySelectorAll('button')].filter(node => node.textContent === 'X監視を追加').length, 0);
    } finally { await f.close(); }
});

test('choosing X in the common registration accepts a handle and preserves an existing X draft', async () => {
    const f = await fixture();
    try {
        await f.click('X通知'); await f.settle(); await f.click('通知を追加');
        await f.fill(f.field('Xアカウント名'), 'retained_x');
        await f.click('新着通知'); await f.click('通知を追加');
        await f.fill(f.field('サービス'), 'twitter');
        await f.fill(f.field('Xアカウント名・プロフィールURL'), '@new_candidate');
        await f.click('対象を確認'); await f.settle();
        assert.equal(selected(f).textContent, 'X通知'); assert.equal(f.field('Xアカウント名（@ユーザー名）').value, 'retained_x');
        assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
    } finally { await f.close(); }
});

test('X profile input validation rejects nonprofile, credentialed and misleading URLs before any API write', async () => {
    const f = await fixture();
    try {
        for (const value of ['@valid_user', 'valid_user', 'https://x.com/valid_user', 'https://www.twitter.com/valid_user/?ref=profile'])
            assert.equal(f.exports.xRegistrationHandle(value), 'valid_user');
        for (const value of ['https://x.com/i/web/status/123', 'https://x.com/user/status/123', 'https://x.com/home', 'https://user@x.com/valid_user', 'https://x.com.attacker.test/valid_user', 'https://attacker.x.com/valid_user', 'http://x.com/valid_user', '@this_handle_is_far_too_long'])
            assert.throws(() => f.exports.xRegistrationHandle(value), /プロフィール/);
        await f.click('通知を追加'); await f.fill(f.field('対象のURL・ID'), 'https://x.com/user/status/123');
        await f.click('対象を確認'); await f.settle();
        assert.equal(selected(f).textContent, '新着通知'); assert.match(f.container.textContent, /プロフィールのURLを入力/);
        assert.equal(f.field('Xアカウント名・プロフィールURL').value, 'https://x.com/user/status/123');
        assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
    } finally { await f.close(); }
});
