'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

test('registration validates without saving, fetches channel choices automatically, and retains a created destination on retry', async () => {
    const f = await reactFixture('export { MonitorRegistration } from "./components/automation/monitor-registration";');
    try {
        const { React, exports: { MonitorRegistration } } = f;
        const calls = [], saved = []; let error = '', saveFails = true;
        let destination = null;
        const api = async (route, method, body) => {
            calls.push({ route, method, body });
            if (route.endsWith('/preview')) return { providerId: 'github', source: 'https://github.com/octocat', intervalMinutes: 360, description: '初回は基準を記録します。', verified: 'format_only' };
            if (route === 'channels') return { items: [{ id: 'channel', name: '通知', canCreateWebhook: true }, { id: 'denied', name: '権限なし', canCreateWebhook: false }] };
            if (route === 'destinations') { destination = { id: 'destination', name: '#通知', kind: 'webhook', scope: 'private', enabled: true }; return destination; }
            assert.fail(`Unexpected API ${route}`);
        };
        function Fixture() {
            const [monitor, setMonitor] = React.useState({ name: '新着', source: 'https://github.com/octocat', providerId: 'github', locale: 'ja', destinationId: '', mode: 'change', maxPriceAmount: '', minDiscountPercent: '', workflowId: '' });
            const [destinations, setDestinations] = React.useState([]), [message, setMessage] = React.useState('');
            return React.createElement('div', null, React.createElement('p', { role: 'alert' }, message), React.createElement(MonitorRegistration, {
                api, monitor, kind: 'auto', scope: 'private', guildId: 'guild', destinations, rules: [], busy: false,
                catalog: { auto: [{ id: 'github' }], autoRegistration: { eligible: true } },
                onChange: setMonitor, onSourceChange: source => setMonitor({ ...monitor, source }),
                onSave: async value => { saved.push(value); if (saveFails) throw new Error('fixture monitor failure'); },
                run: async work => { try { await work(); setMessage(''); } catch (cause) { error = cause.message; setMessage(error); } },
                refresh: async () => setDestinations([destination]),
            }));
        }
        await f.render(React.createElement(Fixture));
        await f.submit();
        assert.equal(calls.length, 1); assert.equal(calls[0].route, 'monitors/auto/preview');
        assert(f.container.textContent.includes('URL形式を確認')); assert.equal(saved.length, 0);
        await f.fill(f.field('通知先の種類'), 'channel'); await f.settle();
        assert.equal(calls.at(-1).route, 'channels');
        await f.submit(); assert.match(error, /チャンネルを選んで/); assert.equal(saved.length, 0);
        await f.fill(f.field('チャンネル'), 'channel'); await f.submit();
        assert(f.container.querySelector('[aria-label="保存する通知の確認"]')); assert(!calls.some(call => call.route === 'destinations'));
        assert(f.container.textContent.includes('通知はチャンネルを見られる人に届きます'));
        assert.equal(f.dom.window.document.activeElement.getAttribute('aria-label'), '保存する通知の確認');
        await f.submit(); assert.match(error, /fixture monitor failure/);
        assert.equal(calls.filter(call => call.route === 'destinations').length, 1); assert.equal(saved[0].destinationId, 'destination');
        saveFails = false; await f.submit();
        assert.equal(calls.filter(call => call.route === 'destinations').length, 1); assert.equal(saved[1].destinationId, 'destination');
    } finally { await f.close(); }
});

test('personal link and reminder drafts survive tab changes without being submitted', async () => {
    const f = await reactFixture('export { PersonalLinksWorkspace } from "./components/personal-links/personal-links-workspace";');
    try {
        const writes = [];
        f.set('fetch', async (_url, options) => { if (options.method !== 'GET') writes.push(options); return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }); });
        await f.render(f.React.createElement(f.exports.PersonalLinksWorkspace, { locale: 'ja', displayName: 'Fixture' })); await f.settle();
        await f.fill(f.field('URL'), 'https://example.test/saved'); await f.fill(f.field('メモ'), '途中の長いメモ');
        await f.click('見返す通知'); await f.fill(f.field('URL'), 'https://example.test/reminder');
        await f.fill(f.field('通知する日時'), '2026-10-15T10:30');
        await f.click('あとで見る'); assert.equal(f.field('URL').value, 'https://example.test/saved'); assert.equal(f.field('メモ').value, '途中の長いメモ');
        await f.click('見返す通知'); assert.equal(f.field('URL').value, 'https://example.test/reminder'); assert.equal(f.field('通知する日時').value, '2026-10-15T10:30');
        assert.equal(writes.length, 0);
    } finally { await f.close(); }
});

test('task navigation links private features directly and identifies the current page', async () => {
    const f = await reactFixture('export { TaskNavigation } from "./components/dashboard/task-navigation";');
    try {
        await f.render(f.React.createElement(f.exports.TaskNavigation, { locale: 'ja', overview: true }));
        assert.deepEqual([...f.container.querySelectorAll('a')].map(link => link.getAttribute('href')), ['/dashboard?mode=user', '/dashboard/automation', '/dashboard/personal-links']);
        assert.equal(f.container.querySelector('a[aria-current="page"]').getAttribute('href'), '/dashboard/automation');
        await f.render(f.React.createElement(f.exports.TaskNavigation, { locale: 'en', guildId: 'guild' }));
        assert.equal(f.container.querySelectorAll('a')[1].getAttribute('href'), '/dashboard/guild/automation');
    } finally { await f.close(); }
});

test('obsolete list responses cannot overwrite a refresh or a newer server search', async () => {
    const f = await reactFixture('export { MonitorManager } from "./components/automation/monitor-manager";');
    try {
        let finishFirst, finishRefresh, reads = 0;
        const row = name => ({ id: '1', kind: 'auto', name, scope: 'private', providerId: 'github', source: 'https://github.com/octocat', enabled: true });
        const api = async route => {
            if (route === 'providers') return { autoRegistration: { eligible: true }, auto: [{ id: 'github' }] };
            if (route === 'entitlements') return { plan: { name: '無料プラン', priority: 0, slotLimit: 5, dayLimit: 24, minuteLimit: 5 }, slots: { used: 1, max: 5, available: 4 }, usage: { entries: [] } };
            reads++;
            if (reads === 1) return new Promise(resolve => { finishFirst = resolve; });
            if (reads === 3) return new Promise(resolve => { finishRefresh = resolve; });
            if (new URLSearchParams(route.split('?')[1]).get('query') === 'none') return { items: [], nextCursor: null };
            return { items: [row(reads === 2 ? '最新の登録' : '検索された最新の通知')], nextCursor: null };
        };
        await f.render(f.React.createElement(f.exports.MonitorManager, { api, guildId: 'guild', scope: 'private', canEdit: true, destinations: [], rules: [], refresh: async () => {} }));
        await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        assert.equal(reads, 1);
        await f.click('更新'); await f.settle(); assert(f.container.textContent.includes('最新の登録'));
        await f.act(async () => finishFirst({ items: [row('古い一覧')], nextCursor: null }));
        assert(!f.container.textContent.includes('古い一覧'));
        await f.click('更新'); await f.fill(f.field('通知を検索'), '最新');
        await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
        assert(f.container.textContent.includes('検索された最新の通知'));
        await f.act(async () => finishRefresh({ items: [row('古い更新')], nextCursor: null }));
        assert(!f.container.textContent.includes('古い更新')); assert(f.container.textContent.includes('検索された最新の通知'));
        await f.fill(f.field('通知を検索'), 'none');
        await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
        assert([...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '検索条件をクリア'));
        assert(!f.container.textContent.includes('通知はまだありません'));
        await f.click('検索条件をクリア');
        await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        assert(f.container.textContent.includes('検索された最新の通知'));
    } finally { await f.close(); }
});

test('dialogs focus the input and restore background scrolling only after the last nested dialog closes', async () => {
    const f = await reactFixture('export { AutomationDialog } from "./components/automation/automation-dialog";');
    try {
        f.dom.window.document.body.style.overflow = 'auto';
        const element = nested => f.React.createElement(f.React.Fragment, null,
            f.React.createElement(f.exports.AutomationDialog, { title: 'outer', onCancel() {} }, f.React.createElement('input', { 'aria-label': 'first' })),
            nested && f.React.createElement(f.exports.AutomationDialog, { title: 'inner', onCancel() {} }, f.React.createElement('input', { 'aria-label': 'second' })));
        await f.render(element(true));
        assert.equal(f.dom.window.document.body.style.overflow, 'hidden');
        assert.equal(f.dom.window.document.activeElement.getAttribute('aria-label'), 'second');
        await f.render(element(false)); assert.equal(f.dom.window.document.body.style.overflow, 'hidden');
        await f.render(null); assert.equal(f.dom.window.document.body.style.overflow, 'auto');
    } finally { await f.close(); }
});

test('settings can be filtered by category without losing hidden edits; unavailable browser storage does not crash', async () => {
    const f = await reactFixture('export { ProviderSettingsForm } from "./components/settings/provider-settings-form";');
    try {
        const states = [
            { key: 'enabled', kind: 'providerEnabled', value: true, warnings: [], spec: { key: 'enabled', kind: 'providerEnabled', label: { ja: '展開を有効にする', en: 'Enable' }, description: {}, category: 'basic', impactLevel: 'low' } },
            { key: 'silent_expansion', kind: 'bool', value: false, warnings: [], spec: { key: 'silent_expansion', kind: 'bool', label: { ja: '通知音なし', en: 'Silent' }, description: {}, category: 'output', impactLevel: 'low' } },
        ];
        f.dom.window.Storage.prototype.getItem = () => { throw new Error('fixture storage denied'); };
        f.dom.window.Storage.prototype.setItem = () => { throw new Error('fixture quota'); };
        f.dom.window.Storage.prototype.removeItem = () => { throw new Error('fixture storage denied'); };
        const saved = [];
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { guildId: 'guild', providerId: 'twitter', providerLabel: 'Twitter', canEdit: true,
            settings: states, locale: 'ja', showResetProvider: false, onSaveChanges: async changes => { saved.push(structuredClone(changes)); return {}; }, onSaved() {} })); await f.settle();
        assert(f.container.textContent.includes('ブラウザに下書きを保存できません'));
        assert(f.container.textContent.includes('通知音なし'));
        await f.act(async () => f.container.querySelector('input[aria-label="通知音なし"]').click());
        assert.equal(f.container.querySelector('input[aria-label="通知音なし"]').checked, true);
        await f.fill(f.field('設定の種類'), 'basic');
        const basicControl = f.container.querySelector('#setting-enabled input'); assert(basicControl, 'basic setting remains available');
        assert.equal(!!basicControl.closest('[hidden]'), false); assert.equal(!!f.container.querySelector('input[aria-label="通知音なし"]')?.closest('[hidden]'), true);
        await f.fill(f.field('設定の種類'), 'all'); assert.equal(f.container.querySelector('input[aria-label="通知音なし"]').checked, true);
        await f.click('変更を保存');
        assert.deepEqual(saved, [{ silent_expansion: true }]);
        assert(f.container.textContent.includes('保存しました。'));
        assert(!f.container.textContent.includes('fixture storage denied'));
    } finally { await f.close(); }
});
