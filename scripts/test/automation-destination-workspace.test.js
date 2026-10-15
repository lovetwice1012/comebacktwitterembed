'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { catalog } = require('../../src/automation/catalog');
const USER = '222222222222222222';
const destination = index => ({ id: `destination-${index}`, name: `通知先${index}`, kind: 'dm', scope: 'private', enabled: true, revision: 1 });
const quota = { featureEnabled: true, currentPlan: { planId: 'basic', label: 'ベーシック', tier: 'paid', priority: 2, minuteLimit: 7, dayLimit: 48, intervalMinutes: 5, baseSlotLimit: 5 },
    personal: { totalLimit: 8, registeredCount: 1, used: 1, available: 7, supporterExtraSlots: 3 }, x: { used: 1, available: 7, specialLimit: 3, specialUsed: 0, reasonCode: null },
    pools: { free: { limit: 50, used: 1, available: 49 }, supporter: { limit: 100, used: 0, available: 100 } } };
const rollout = { mode: 'public', eligible: true, reasonCode: null, reason: null };
async function fixture({ list = () => ({ items: [], nextCursor: null }), failIndividualRefresh = false } = {}) {
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
    f.set('sessionStorage', f.dom.window.sessionStorage); f.set('confirm', () => true);
    f.set('SVGElement', f.dom.window.SVGElement); f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    f.calls = []; f.saved = null;
    f.set('fetch', async (address, options = {}) => {
        const url = new URL(address, 'http://fixture'), route = url.pathname.slice('/api/automation/'.length), method = options.method || 'GET', body = options.body && JSON.parse(options.body);
        f.calls.push({ route, method, body, afterId: url.searchParams.get('afterId') });
        let result;
        if (route === 'catalog') result = catalog();
        else if (route === 'providers') result = { auto: [], price: [], autoRegistration: { eligible: true } };
        else if (route === 'entitlements') result = { plan: { name: '無料プラン', priority: 0, dayLimit: 24, minuteLimit: 5 }, slots: { used: 1, max: 8, available: 7 }, usage: { entries: [] } };
        else if (route === 'workflows' || route === 'dictionaries' || route.startsWith('monitors/')) result = { items: [], nextCursor: null };
        else if (route === 'destinations' && method === 'GET') result = await list(url.searchParams.get('afterId'));
        else if (route === 'destinations' && method === 'POST') { f.saved = { ...destination('new'), name: body.name }; result = { id: f.saved.id }; }
        else if (route === 'destinations/destination-new') {
            if (failIndividualRefresh) return new Response(JSON.stringify({ code: 'DESTINATION_REFRESH_FAILED', error: '一覧を再読み込みしてください。' }), { status: 503 });
            assert(f.saved); result = f.saved;
        } else if (route === 'x-monitor-quota') result = quota;
        else if (route === 'x-monitors') result = { items: [] };
        else if (route === 'x-setup') result = { available: true, receiverEnabled: true, rollout, download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) }, subscriptions: [], maxFileBytes: 32768, nextCursor: null };
        else if (route === 'x-processing-settings') result = { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'basic', planLabel: 'ベーシック', intervalMinutes: 5, configured: true, reasonCode: null, rollout };
        else assert.fail(`Unexpected workspace request ${route}`);
        return new Response(JSON.stringify(result), { status: 200 });
    });
    await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: USER })); await f.settle();
    f.destinationWrites = () => f.calls.filter(call => call.route === 'destinations' && call.method === 'POST');
    return f;
}
async function openXDraft(f) {
    await f.click('X通知'); await f.settle(); await f.click('通知を追加'); await f.fill(f.field('Xアカウント名'), 'workspace_x');
}
const choices = f => f.container.querySelector('form[aria-label="X監視の登録設定"] select');
async function saveXDestination(f) {
    await f.click('チャンネル・Webhookを追加'); await f.fill(f.field('通知先の名前'), '今回追加する通知先');
    await f.act(async () => f.container.querySelector('form[aria-label="通知先の登録設定"]').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
}

test('the real workspace loads all paginated destinations and offers second-page choices in an X draft', async () => {
    const rows = Array.from({ length: 103 }, (_, index) => destination(index));
    const f = await fixture({ list: afterId => afterId ? { items: rows.slice(100), nextCursor: null } : { items: rows.slice(0, 100), nextCursor: 'destination-99' } });
    try {
        await openXDraft(f); assert.deepEqual(f.calls.filter(call => call.route === 'destinations').map(call => call.afterId), [null, 'destination-99']);
        assert.equal(choices(f).options.length, 104); assert(choices(f).querySelector('option[value="destination-102"]'));
        await f.fill(choices(f), 'destination-102'); assert.equal(choices(f).value, 'destination-102'); assert.equal(f.destinationWrites().length, 0);
    } finally { await f.close(); }
});

test('an individually refreshed saved destination survives a late initial workspace list response', async () => {
    let finishInitial;
    const f = await fixture({ list: () => new Promise(resolve => { finishInitial = resolve; }) });
    try {
        assert.equal(typeof finishInitial, 'function'); await openXDraft(f); await saveXDestination(f);
        assert.equal(f.destinationWrites().length, 1); assert(f.calls.some(call => call.route === 'destinations/destination-new' && call.method === 'GET'));
        assert.equal(choices(f).value, 'destination-new'); assert.equal(choices(f).querySelector('option[value="destination-new"]').disabled, false);
        await f.act(async () => finishInitial({ items: [destination('old')], nextCursor: null })); await f.settle();
        assert.equal(choices(f).value, 'destination-new'); assert.equal(choices(f).querySelector('option[value="destination-new"]').disabled, false);
        assert.equal(f.field('Xアカウント名').value, 'workspace_x'); assert.equal(f.destinationWrites().length, 1);
    } finally { await f.close(); }
});

test('an individual workspace refresh failure keeps the destination saved and offers no repeated POST retry', async () => {
    const f = await fixture({ failIndividualRefresh: true });
    try {
        await openXDraft(f); await saveXDestination(f); assert.equal(f.destinationWrites().length, 1);
        assert.equal(f.container.querySelector('form[aria-label="通知先の登録設定"]'), null); assert.match(f.container.textContent, /通知先は保存済みです/);
        await f.settle(); await f.click('X一覧・利用枠を更新'); await f.settle(); assert.equal(f.destinationWrites().length, 1); assert.equal(f.field('Xアカウント名').value, 'workspace_x');
    } finally { await f.close(); }
});

test('a repeated destination page cursor stops with a visible retry message instead of looping or offering a partial list', async () => {
    const f = await fixture({ list: () => ({ items: [destination('page')], nextCursor: 'same-cursor' }) });
    try {
        assert.equal(f.calls.filter(call => call.route === 'destinations' && call.method === 'GET').length, 2); assert.match(f.container.textContent, /通知先一覧を再読み込みしてください/);
        await openXDraft(f); assert.equal(choices(f).options.length, 1); assert.equal(f.destinationWrites().length, 0);
    } finally { await f.close(); }
});
