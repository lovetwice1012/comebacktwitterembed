'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const makeSetting = (key, kind, value, extra = {}) => ({ key, kind, value, warnings: [], changedFromDefault: false, spec: { key, kind, category: 'provider', label: { ja: key, en: key }, description: { ja: '', en: '' }, ...extra } });
const props = { guildId: '111111', providerId: 'twitter', providerLabel: 'Twitter', scopeLabel: 'My server', canEdit: true, locale: 'ja' };
const entry = 'export { ProviderSettingsForm } from "./components/settings/provider-settings-form";';
const catalog = () => [
    makeSetting('enabled', 'providerEnabled', true, { category: 'basic', recommended: true }),
    makeSetting('display_density', 'choice', 'standard', { category: 'output', recommended: true, choices: ['standard', 'compact', 'detail'].map(value => ({ value, label: value })) }),
    makeSetting('media_display_mode', 'choice', 'embed', { category: 'media', recommended: true, choices: ['embed', 'attachment', 'thumbnail_only', 'link_only'].map(value => ({ value, label: value })) }),
    makeSetting('quote_repost_depth_by_account', 'accountDepthMap', {}, { category: 'advanced', advanced: true }),
    ...['one', 'two', 'three', 'four'].map(key => makeSetting(key, 'bool', false)),
];
const shown = (f, key) => !f.container.querySelector(`#setting-${key}`).closest('[hidden]');

test('all settings includes advanced items, reports the full count and retains edits when switching back to common', async () => {
    const f = await reactFixture(entry);
    try {
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, settings: catalog(), onSaveChanges: async () => ({}) }));
        assert(f.container.textContent.includes('全8件'));
        assert.equal(shown(f, 'quote_repost_depth_by_account'), false);
        await f.act(async () => [...f.container.querySelectorAll('button')].find(button => button.textContent.startsWith('すべての設定')).click());
        for (const setting of catalog()) assert.equal(shown(f, setting.key), true);
        assert(f.container.textContent.includes('8件を表示 全8件'));
        await f.act(async () => f.container.querySelector('#setting-one input').click());
        await f.click('よく使う設定');
        assert.equal(shown(f, 'one'), false);
        await f.act(async () => [...f.container.querySelectorAll('button')].find(button => button.textContent.startsWith('すべての設定')).click());
        assert.equal(f.container.querySelector('#setting-one input').checked, true);
        await f.fill(f.field('設定の種類'), 'common');
        await f.fill(f.field('設定の種類'), 'all');
        assert.equal(shown(f, 'quote_repost_depth_by_account'), true);
    } finally { await f.close(); }
});

test('settings start with common actions and search reveals advanced controls without losing unfinished edits', async () => {
    const f = await reactFixture(entry);
    try {
        const writes = [];
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, settings: catalog(), onSaveChanges: async changes => writes.push(changes) }));
        assert.equal(shown(f, 'enabled'), true);
        assert.equal(shown(f, 'quote_repost_depth_by_account'), false);
        assert.equal(shown(f, 'one'), false);
        const search = f.container.querySelector('section[aria-label="設定を探す"] input');
        await f.fill(search, 'アカウント別');
        assert.equal(shown(f, 'quote_repost_depth_by_account'), true);
        await f.click('アカウントを追加');
        await f.fill(f.container.querySelector('input[aria-label="アカウント名 1"]'), 'sample');
        await f.click('よく使う設定');
        assert.equal(shown(f, 'quote_repost_depth_by_account'), false);
        await f.act(async () => f.field('編集中の設定だけ').click());
        assert.equal(shown(f, 'quote_repost_depth_by_account'), true);
        assert.equal(f.container.querySelector('input[aria-label="アカウント名 1"]').value, 'sample');
        assert(f.container.querySelector('[data-settings-save-bar]').textContent.includes('My server'));
        await f.click('変更を保存');
        assert.deepEqual(writes, [{ quote_repost_depth_by_account: { sample: 1 } }]);
    } finally { await f.close(); }
});

test('advanced deep links reveal and focus exact controls even when the default view is common settings', async () => {
    const f = await reactFixture(entry);
    try {
        f.dom.window.history.replaceState({}, '', '/dashboard/111111/providers/twitter?setting=quote_repost_depth_by_account');
        const settings = catalog(); settings[3].value = { sample: 2 };
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, settings }));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(shown(f, 'quote_repost_depth_by_account'), true);
        assert.equal(f.dom.window.document.activeElement.getAttribute('aria-label'), 'アカウント名 1');
    } finally { await f.close(); }
});

test('Discord examples are opt-in and render current unsaved values; reset sits behind a separate disclosure', async () => {
    const f = await reactFixture(entry);
    try {
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, settings: catalog() }));
        assert.equal(f.container.querySelector('#settings-preview-twitter'), null);
        const reset = [...f.container.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === '設定を初期値に戻す');
        assert.equal(reset.open, false);
        await f.click('Discordの表示例を見る');
        assert(f.container.querySelector('#settings-preview-twitter'));
        await f.fill(f.container.querySelector('select[aria-label="画像・動画の表示方法"]'), 'link_only');
        assert(f.container.querySelector('#settings-preview-twitter').textContent.includes('https://x.com/'));
        assert(f.container.querySelector('[data-settings-save-bar]').textContent.includes('1'));
        await f.click('表示例を閉じる');
        assert.equal(f.container.querySelector('#settings-preview-twitter'), null);
    } finally { await f.close(); }
});

test('preset review names every changed value and cannot write until apply; service discovery links to exact settings', async () => {
    const f = await reactFixture('export { CrossSettingsView } from "./components/settings/cross-settings-view";');
    try {
        const requests = [];
        f.set('fetch', async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify({})); });
        const items = catalog().map(setting => ({ providerId: 'twitter', providerLabel: 'Twitter', setting }));
        await f.render(f.React.createElement(f.exports.CrossSettingsView, { guildId: '111111', guildName: 'My server', items, canManage: true, locale: 'ja', onSaved() {} }));
        const groups = [...f.container.querySelectorAll('details')].filter(node => node.querySelector('summary')?.textContent.includes('Twitter'));
        assert.equal(groups[0].open, false);
        await f.act(async () => f.container.querySelector('button[aria-label="コンパクト表示を確認"]').click());
        const review = f.container.querySelector('[aria-label="表示変更の確認"]');
        assert(review.textContent.includes('My serverの全サービス'));
        assert.equal(review.querySelectorAll('dl dt').length, 3);
        assert(review.textContent.includes('少なめ')); assert(review.textContent.includes('小さな画像')); assert(review.textContent.includes('何も送らない'));
        assert.equal(requests.length, 0);
        await f.click('全サービスに適用');
        assert.deepEqual(requests, [{ url: '/api/guilds/111111/providers/bulk', body: { changes: { display_density: 'compact', failure_display_policy: 'silent', media_display_mode: 'thumbnail_only' } } }]);
        assert.equal(f.container.querySelector('[aria-label="表示変更の確認"]'), null);
        const search = f.container.querySelector('input[placeholder]');
        await f.fill(search, 'アカウント別');
        assert.equal(f.container.querySelector('details:has(a[href*="quote_repost_depth_by_account"])').open, true);
        assert.deepEqual([...f.container.querySelectorAll('a')].map(link => link.getAttribute('href')), ['/dashboard/111111/providers/twitter?setting=quote_repost_depth_by_account']);
    } finally { await f.close(); }
});

test('service filters combine with domain search and recover with a clear action', async () => {
    const f = await reactFixture('export { ProviderList } from "./components/providers/provider-list";');
    try {
        const providers = [{ providerId: 'twitter', label: 'Twitter', domain: 'x.com / twitter.com', enabled: true, changedFromDefault: false, customizedSettingCount: 0, warnings: [] }, { providerId: 'youtube', label: 'YouTube', domain: 'youtube.com / youtu.be', enabled: false, changedFromDefault: true, customizedSettingCount: 1, warnings: [] }];
        await f.render(f.React.createElement(f.exports.ProviderList, { guildId: '111111', providers, locale: 'ja' }));
        await f.fill(f.container.querySelector('input'), 'YOUTU.BE');
        assert.deepEqual([...f.container.querySelectorAll('a')].map(link => link.getAttribute('href')), ['/dashboard/111111/providers/youtube']);
        await f.act(async () => [...f.container.querySelectorAll('[role="group"] button')][1].click());
        assert.equal(f.container.querySelectorAll('a').length, 0);
        await f.click('検索条件をクリア');
        assert.equal(f.container.querySelectorAll('a').length, 2);
    } finally { await f.close(); }
});

test('overview customized-setting links open only saved deviations from defaults', async () => {
    const f = await reactFixture('export { CrossSettingsView } from "./components/settings/cross-settings-view";');
    try {
        f.dom.window.history.replaceState({}, '', '/dashboard/111111/settings?changed=1');
        const settings = catalog(); settings[2].changedFromDefault = true;
        await f.render(f.React.createElement(f.exports.CrossSettingsView, { guildId: '111111', items: settings.map(setting => ({ providerId: 'twitter', providerLabel: 'Twitter', setting })), canManage: true, locale: 'ja' }));
        assert.deepEqual([...f.container.querySelectorAll('a')].map(link => link.getAttribute('href')), ['/dashboard/111111/providers/twitter?setting=media_display_mode']);
        assert.equal(f.field('初期値から変更した設定だけ').checked, true);
    } finally { await f.close(); }
});

test('preview shows one chosen service and its matching edit destination', async () => {
    const f = await reactFixture('export { ProviderPreviewBrowser } from "./components/settings/provider-preview-browser"; export { buildPreview } from "./lib/settings-preview";');
    try {
        const items = ['twitter', 'youtube'].map((providerId, index) => ({ providerId, label: providerId === 'twitter' ? 'Twitter' : 'YouTube', enabled: index === 1, preview: f.exports.buildPreview(providerId, [], 'ja') }));
        await f.render(f.React.createElement(f.exports.ProviderPreviewBrowser, { guildId: '111111', items, locale: 'ja' }));
        assert.equal(f.field('表示を確認するサービス').value, 'youtube');
        assert(f.container.querySelector('a[href="/dashboard/111111/providers/youtube?setting=display_density"]'));
        assert.equal([...f.container.querySelectorAll('a')].filter(link => link.href.includes('x.com')).length, 0);
        await f.fill(f.field('表示を確認するサービス'), 'twitter');
        assert(f.container.querySelector('a[href="/dashboard/111111/providers/twitter?setting=display_density"]'));
        assert(f.container.textContent.includes('このサーバーでは展開オフ'));
    } finally { await f.close(); }
});

test('reset adopts server defaults, clears unsaved values, and requires native manage permission', async () => {
    const f = await reactFixture(entry);
    try {
        const settings = [makeSetting('enabled', 'providerEnabled', false, { category: 'basic' })];
        f.set('confirm', () => true);
        const requests = []; f.set('fetch', async url => { requests.push(url); return new Response(JSON.stringify({ settings })); });
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, canReset: false, settings }));
        const resetButton = [...f.container.querySelectorAll('details button')].find(button => button.textContent.includes('初期値'));
        assert(resetButton.disabled); assert(f.container.textContent.includes('サーバー管理権限が必要'));
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, canReset: true, settings }));
        await f.act(async () => f.container.querySelector('input[aria-label="リンクを展開"]').click()); await f.settle();
        assert(f.dom.window.localStorage.getItem('dashboard:draft:111111:twitter'));
        await f.act(async () => resetButton.click()); await f.settle();
        assert.deepEqual(requests, ['/api/guilds/111111/providers/twitter/reset']);
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, false);
        assert.equal(f.dom.window.localStorage.getItem('dashboard:draft:111111:twitter'), null);
        assert(f.container.querySelector('[role="status"]').textContent.includes('初期値'));
    } finally { await f.close(); }
});

test('button visibility review names changed buttons even when the hidden count is unchanged', async () => {
    const f = await reactFixture(entry);
    try {
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, settings: [makeSetting('button_invisible', 'buttonVisibility', { translate: true, delete: false }, { category: 'buttons' })] }));
        const inputs = f.container.querySelectorAll('#setting-button_invisible input');
        await f.act(async () => { inputs[0].click(); inputs[1].click(); });
        const values = f.container.querySelectorAll('aside dl dd');
        assert.equal(values.length, 2);
        assert(values[0].textContent.includes('翻訳')); assert(values[1].textContent.includes('削除'));
        assert.notEqual(values[0].textContent, values[1].textContent);
    } finally { await f.close(); }
});
