'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { xFixtureResponse } = require('./helpers/notification-registration-fixture.cjs');

const row = name => ({ id: '1', kind: 'auto', scope: 'private', name, revision: 1, enabled: true,
    providerId: 'github', source: 'https://github.com/example', locale: 'ja', destinationId: 'dm-one', workflowId: '',
    intervalMinutes: 30, mode: 'change', maxPriceAmount: null, minDiscountPercent: null });
const tick = f => f.act(async () => new Promise(resolve => setTimeout(resolve, 40)));
const nameInput = f => [...f.container.querySelectorAll('form.monitor-registration label')]
    .find(label => label.firstChild?.textContent.trim() === '名前（省略可）')?.querySelector('input');

test('a saved edit from a previous API context cannot replace the new account list or its same-ID row', async () => {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    f.set('confirm', () => true); let release, committed = false, writesNew = 0;
    const api = (name, delayed) => async (route, method = 'GET', body) => {
        if (route === 'providers') return { auto: [{ id: 'github' }], price: [], autoRegistration: { eligible: true } };
        if (route === 'entitlements') return { plan: { name: '無料', priority: 0, dayLimit: 24, minuteLimit: 5 }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } };
        if (method === 'GET' && route.startsWith('monitors/auto?')) return { items: [row(name)], nextCursor: null };
        if (method === 'GET' && route.startsWith('monitors/price?')) return { items: [], nextCursor: null };
        if (method === 'PATCH' && route === 'monitors/auto/1') {
            if (!delayed) { writesNew++; return { id: '1', revision: 2 }; }
            assert.equal(body.name, '前の画面で保存した名前');
            await new Promise(resolve => { release = resolve; }); committed = true; return { id: '1', revision: 2 };
        }
        const response = xFixtureResponse(route); if (response !== undefined) return response;
        if (route.startsWith('jobs')) return { items: [], nextCursor: null };
        throw new Error(`Unexpected fixture request: ${method} ${route}`);
    };
    const oldApi = api('前のアカウント', true), newApi = api('新しいアカウント', false);
    const props = apiValue => ({ api: apiValue, scope: 'private', canEdit: true, active: true,
        destinations: [{ id: 'dm-one', name: '本人DM', kind: 'dm', enabled: true, scope: 'private' }], rules: [], refresh: async () => {} });
    try {
        await f.render(f.React.createElement(f.exports.MonitorManager, props(oldApi))); await tick(f);
        await f.click('設定を変更'); await f.fill(nameInput(f), '前の画面で保存した名前'); await f.click('変更を保存');
        assert.equal(typeof release, 'function');
        await f.render(f.React.createElement(f.exports.MonitorManager, props(newApi))); await tick(f);
        await f.act(async () => release()); await tick(f);
        const list = f.container.querySelector('.monitor-list[aria-label="登録した通知"]');
        assert.equal(committed, true); assert.equal(writesNew, 0);
        assert.match(list.textContent, /新しいアカウント/); assert.doesNotMatch(list.textContent, /前の画面で保存した名前|前のアカウント/);
        assert.equal(nameInput(f).value, '前の画面で保存した名前');
    } finally { await f.close(); }
});
