'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const setting = (key, kind, value, extra = {}) => ({ key, kind, value, warnings: [], spec: { key, kind, category: 'basic', label: { ja: key === 'enabled' ? 'リンクを展開' : key, en: key === 'enabled' ? 'Expand links' : key }, description: { ja: '', en: '' }, ...extra } });
const formProps = { guildId: '111111', providerId: 'twitter', providerLabel: 'Twitter', canEdit: true, locale: 'ja' };
const formEntry = 'export { ProviderSettingsForm } from "./components/settings/provider-settings-form";';

test('account rows retain input identity, focus and unfinished siblings; unfinished rows cannot be silently saved', async () => {
    const f = await reactFixture(formEntry);
    try {
        const writes = [], settings = [setting('quote_repost_depth_by_account', 'accountDepthMap', {})];
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...formProps, settings, onSaveChanges: async changes => { writes.push(changes); } }));
        await f.click('アカウントを追加'); await f.click('アカウントを追加');
        const input = f.container.querySelector('input[aria-label="アカウント名 1"]'); input.focus();
        for (const value of ['a', 'al', 'alpha']) {
            await f.fill(input, value); await f.settle();
            assert.equal(f.container.querySelector('input[aria-label="アカウント名 1"]'), input);
            assert.equal(f.dom.window.document.activeElement, input);
        }
        assert.equal(f.container.querySelector('input[aria-label="アカウント名 2"]').value, '');
        assert.equal([...f.container.querySelectorAll('button')].find(button => button.textContent.trim() === '変更を保存').disabled, true);
        const remove = f.container.querySelectorAll('button[aria-label="アカウントを削除"]')[1];
        await f.act(async () => remove.click()); await f.click('変更を保存');
        assert.deepEqual(writes, [{ quote_repost_depth_by_account: { alpha: 1 } }]);
    } finally { await f.close(); }
});

test('locale and server refetch retain dirty values and browser draft while untouched fields adopt refreshed values', async () => {
    const f = await reactFixture(formEntry);
    try {
        const initial = [setting('enabled', 'providerEnabled', false), setting('display_density', 'choice', 'standard', { choices: [{ value: 'standard', label: 'Standard' }, { value: 'compact', label: 'Compact' }] })];
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...formProps, settings: initial }));
        await f.act(async () => f.container.querySelector('input[aria-label="リンクを展開"]').click()); await f.settle();
        const refreshed = structuredClone(initial); refreshed[1].value = 'compact';
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...formProps, settings: refreshed, locale: 'en' })); await f.settle();
        assert.equal(f.container.querySelector('input[aria-label="Expand links"]').checked, true);
        assert.equal(f.container.querySelector('#setting-display_density select').value, 'compact');
        assert.deepEqual(JSON.parse(f.dom.window.localStorage.getItem('dashboard:draft:111111:twitter')), { enabled: true });
        const event = new f.dom.window.Event('beforeunload', { cancelable: true });
        f.dom.window.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
        await f.click('Discard changes'); await f.settle();
        assert.equal(f.container.querySelector('input[aria-label="Expand links"]').checked, false);
        assert.equal(f.dom.window.localStorage.getItem('dashboard:draft:111111:twitter'), null);
    } finally { await f.close(); }
});

test('mount restores only this server draft and save errors remain actionable', async () => {
    const f = await reactFixture(formEntry);
    try {
        f.dom.window.localStorage.setItem('dashboard:draft:111111:twitter', JSON.stringify({ enabled: true }));
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...formProps, settings: [setting('enabled', 'providerEnabled', false)], onSaveChanges: async () => { throw new Error('再試行してください。'); } })); await f.settle();
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, true);
        await f.click('変更を保存');
        assert.equal(f.container.querySelector('[role="alert"]').textContent, '再試行してください。');
        assert(f.dom.window.localStorage.getItem('dashboard:draft:111111:twitter'));
        assert(f.container.querySelector('[data-settings-save-bar]').className.includes('fixed'));
    } finally { await f.close(); }
});

test('storage denial does not loop or lose edits when a setting is hidden by filtering', async () => {
    const f = await reactFixture(formEntry);
    try {
        for (const method of ['getItem', 'setItem', 'removeItem']) f.dom.window.Storage.prototype[method] = () => { throw new Error('storage unavailable'); };
        const writes = [], settings = [setting('enabled', 'providerEnabled', false), setting('silent_expansion', 'bool', false, { category: 'output' })];
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...formProps, settings, onSaveChanges: async changes => { writes.push(changes); }, onSaved() {} }));
        await f.act(async () => f.container.querySelector('input[aria-label="silent_expansion"]').click());
        await f.fill(f.field('設定の種類'), 'basic');
        assert(f.container.querySelector('input[aria-label="silent_expansion"]').closest('[hidden]'));
        await f.fill(f.field('設定の種類'), 'all');
        assert.equal(f.container.querySelector('input[aria-label="silent_expansion"]').checked, true);
        await f.click('変更を保存'); assert.deepEqual(writes, [{ silent_expansion: true }]);
    } finally { await f.close(); }
});

test('authenticated settings drafts are isolated by viewer and do not import legacy unowned drafts', async () => {
    const f = await reactFixture(formEntry);
    try {
        const props = { ...formProps, settings: [setting('enabled', 'providerEnabled', false)] };
        f.dom.window.localStorage.setItem('dashboard:draft:111111:twitter', JSON.stringify({ enabled: true }));
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, viewerId: 'owner-a' })); await f.settle();
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, false);
        await f.act(async () => f.container.querySelector('input[aria-label="リンクを展開"]').click()); await f.settle();
        assert.deepEqual(JSON.parse(f.dom.window.localStorage.getItem('dashboard:draft:owner-a:111111:twitter')), { enabled: true });
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, viewerId: 'owner-b' })); await f.settle();
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, false);
        assert.equal(f.dom.window.localStorage.getItem('dashboard:draft:owner-b:111111:twitter'), null);
        assert(f.dom.window.localStorage.getItem('dashboard:draft:owner-a:111111:twitter'));
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...props, viewerId: 'owner-a' })); await f.settle();
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, true);
    } finally { await f.close(); }
});

test('targeted settings link focuses the exact named input', async () => {
    const f = await reactFixture(formEntry);
    try {
        f.dom.window.history.replaceState({}, '', '/dashboard/111111/providers/twitter?setting=display_density');
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, { ...formProps, settings: [setting('enabled', 'providerEnabled', false), setting('display_density', 'choice', 'standard', { choices: [{ value: 'standard', label: 'Standard' }] })] }));
        await new Promise(resolve => setTimeout(resolve, 25));
        assert(f.dom.window.document.activeElement === f.container.querySelector('#setting-display_density select'));
        assert(f.dom.window.document.activeElement.getAttribute('aria-label'));
        assert(f.container.querySelector('#setting-display_density'));
    } finally { await f.close(); }
});

test('server selection uses a canonical router transition and returned navigation belongs to the new server', async () => {
    const pushes = [];
    const f = await reactFixture('export { DashboardWorkspace } from "./components/dashboard/dashboard-workspace"; export { pushGuildSelection } from "./components/dashboard/guild-options";', { moduleOverrides: { 'next/navigation': { usePathname: () => '/dashboard/111111/settings', useRouter: () => ({ push: href => pushes.push(href), refresh() {} }) } } });
    try {
        const props = { locale: 'ja', defaultLayout: 'server', initialGuildIds: ['111111'], defaultGuildId: '111111' };
        await f.render(f.React.createElement(f.exports.DashboardWorkspace, props, 'Server A'));
        const before = f.dom.window.location.href;
        await f.act(async () => f.exports.pushGuildSelection(['222222']));
        assert.deepEqual(pushes, ['/dashboard/222222']);
        assert.equal(f.dom.window.location.href, before, 'navigation must not mutate only the URL while retaining the old shell');
        await f.render(f.React.createElement(f.exports.DashboardWorkspace, { ...props, initialGuildIds: ['222222'], defaultGuildId: '222222' }, 'Server B'));
        const hrefs = [...f.container.querySelectorAll('nav a')].map(link => link.getAttribute('href'));
        assert(hrefs.some(href => href.startsWith('/dashboard/222222')));
        assert(!hrefs.some(href => href.startsWith('/dashboard/111111')));
    } finally { await f.close(); }
});

test('server selector has keyboard dismissal and applies multiple selections only after confirmation', async () => {
    const pushes = [];
    const f = await reactFixture('export { GuildSwitcher } from "./components/dashboard/guild-switcher";', { moduleOverrides: { 'next/navigation': { useRouter: () => ({ push: href => pushes.push(href) }) } } });
    try {
        const guilds = [{ guildId: '111111', name: 'Server A' }, { guildId: '222222', name: 'Server B' }];
        await f.render(f.React.createElement(f.exports.GuildSwitcher, { selectedGuildIds: ['111111'], guilds, locale: 'ja' }));
        const trigger = f.container.querySelector('button[aria-haspopup="dialog"]');
        await f.act(async () => trigger.click());
        assert.equal(f.dom.window.document.activeElement.type, 'search');
        await f.click('複数サーバーを変更');
        await f.act(async () => f.container.querySelectorAll('input[type="checkbox"]')[1].click());
        assert.equal(pushes.length, 0);
        await f.act(async () => f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        assert.equal(f.container.querySelector('[role="dialog"]'), null);
        assert.equal(f.dom.window.document.activeElement, trigger);
        await f.act(async () => trigger.click());
        const boxes = f.container.querySelectorAll('input[type="checkbox"]');
        assert.equal(boxes[0].checked, true); assert.equal(boxes[1].checked, false);
        await f.act(async () => boxes[1].click());
        await f.click('選択した2サーバーの設定を開く');
        assert.deepEqual(pushes, ['/dashboard/bulk?guildIds=111111%2C222222']);
    } finally { await f.close(); }
});

test('clearing server selection opens the user dashboard rather than the admin redirect target', async () => {
    const pushes = [];
    const f = await reactFixture('export { GuildSwitcher } from "./components/dashboard/guild-switcher";', { moduleOverrides: { 'next/navigation': { useRouter: () => ({ push: href => pushes.push(href) }) } } });
    try {
        await f.render(f.React.createElement(f.exports.GuildSwitcher, { selectedGuildIds: ['111111'], guilds: [{ guildId: '111111', name: 'Server A' }, { guildId: '222222', name: 'Server B' }], locale: 'ja' }));
        await f.act(async () => f.container.querySelector('button[aria-haspopup="dialog"]').click());
        await f.click('選択を解除'); await f.click('サーバー一覧を開く');
        assert.deepEqual(pushes, ['/dashboard?mode=user']);
        const load = require('./helpers/load-dashboard.cjs'); let redirected = false;
        const page = load('app/dashboard/page.tsx', {
            '@/lib/server-session': { requireDashboardSession: async () => ({ user: { id: 'admin-owner', isAdmin: true } }) },
            '@/lib/server-locale': { getDashboardLocale: async () => 'ja' },
            '@/lib/discord': { listVisibleGuilds: async () => [] },
            'next/navigation': { redirect: () => { redirected = true; throw new Error('unexpected admin redirect'); } },
        });
        await page.default({ searchParams: Promise.resolve({ mode: 'user' }) });
        assert.equal(redirected, false);
    } finally { await f.close(); }
});

test('reverting desired values after a partial save remains saveable for known success and an unknown applied failure', async () => {
    const f = await reactFixture('export { MultiGuildBulkSettingsView } from "./components/settings/multi-guild-bulk-settings-view";');
    try {
        const values = { '111111': false, '222222': false }, writes = [], attempts = new Map();
        f.set('confirm', () => true);
        f.set('fetch', async (url, options = {}) => {
            const id = url.split('/')[3];
            if (url.endsWith('/providers')) return new Response(JSON.stringify([{ providerId: 'twitter', label: 'Twitter' }]));
            if (options.method !== 'PATCH') return new Response(JSON.stringify({ settings: [setting('enabled', 'providerEnabled', values[id])] }));
            const changes = JSON.parse(options.body).changes; writes.push({ id, changes }); values[id] = changes.enabled;
            const attempt = (attempts.get(id) || 0) + 1; attempts.set(id, attempt);
            if (id === '222222' && attempt === 1) throw new Error('response lost after the server applied the write');
            return new Response(JSON.stringify({}));
        });
        const guilds = Object.keys(values).map(guildId => ({ guildId, name: guildId, canManageGuild: true }));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds, locale: 'ja', viewerId: 'owner' })); await f.settle();
        const toggle = () => f.act(async () => f.container.querySelector('input[aria-label="リンクを展開"]').click());
        await toggle(); await f.click('変更を保存'); await f.settle();
        assert.deepEqual(values, { '111111': true, '222222': true });
        assert(f.container.textContent.includes('結果不明'));
        await toggle(); await f.settle();
        const save = [...f.container.querySelectorAll('button')].find(button => button.textContent.trim() === '現在の値で保存を完了');
        assert(save && !save.disabled);
        await f.click('現在の値で保存を完了'); await f.settle();
        assert.deepEqual(values, { '111111': false, '222222': false });
        assert.deepEqual(writes.slice(2), [{ id: '111111', changes: { enabled: false } }, { id: '222222', changes: { enabled: false } }]);
    } finally { await f.close(); }
});

test('editing another field after partial success carries the unfinished enabled intent into the next save', async () => {
    const f = await reactFixture('export { MultiGuildBulkSettingsView } from "./components/settings/multi-guild-bulk-settings-view";');
    try {
        const values = { '111111': { enabled: false, display_density: 'standard' }, '222222': { enabled: false, display_density: 'standard' } }, writes = [], attempts = new Map();
        f.set('confirm', () => true);
        f.set('fetch', async (url, options = {}) => {
            const id = url.split('/')[3];
            if (url.endsWith('/providers')) return new Response(JSON.stringify([{ providerId: 'twitter', label: 'Twitter' }]));
            if (options.method !== 'PATCH') return new Response(JSON.stringify({ settings: [setting('enabled', 'providerEnabled', values[id].enabled), setting('display_density', 'choice', values[id].display_density, { choices: [{ value: 'standard', label: 'Standard' }, { value: 'compact', label: 'Compact' }] })] }));
            const changes = JSON.parse(options.body).changes; writes.push({ id, changes }); const attempt = (attempts.get(id) || 0) + 1; attempts.set(id, attempt);
            if (id === '222222' && attempt === 1) return new Response(JSON.stringify({ error: '保存できませんでした。' }), { status: 500 });
            Object.assign(values[id], changes); return new Response(JSON.stringify({}));
        });
        const guilds = Object.keys(values).map(guildId => ({ guildId, name: guildId, canManageGuild: true }));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds, locale: 'ja', viewerId: 'owner' })); await f.settle();
        await f.act(async () => f.container.querySelector('input[aria-label="リンクを展開"]').click()); await f.click('変更を保存'); await f.settle();
        await f.fill(f.container.querySelector('#setting-display_density select'), 'compact');
        await f.click('現在の値で保存を完了'); await f.settle();
        assert.deepEqual(values, { '111111': { enabled: true, display_density: 'compact' }, '222222': { enabled: true, display_density: 'compact' } });
        assert.deepEqual(writes.at(-1), { id: '222222', changes: { enabled: true, display_density: 'compact' } });
        assert.equal(f.dom.window.localStorage.getItem('dashboard:bulk-pending:owner:twitter:111111,222222'), null);
    } finally { await f.close(); }
});

test('an unfinished desired value equal to the baseline remains saveable after reload', async () => {
    const f = await reactFixture('export { MultiGuildBulkSettingsView } from "./components/settings/multi-guild-bulk-settings-view";');
    try {
        const values = { '111111': false, '222222': true }, writes = [];
        f.dom.window.localStorage.setItem('dashboard:bulk-draft:owner:twitter:111111,222222', JSON.stringify({ enabled: false }));
        f.dom.window.localStorage.setItem('dashboard:bulk-pending:owner:twitter:111111,222222', JSON.stringify(['enabled']));
        f.set('confirm', () => true);
        f.set('fetch', async (url, options = {}) => {
            const id = url.split('/')[3];
            if (url.endsWith('/providers')) return new Response(JSON.stringify([{ providerId: 'twitter', label: 'Twitter' }]));
            if (options.method !== 'PATCH') return new Response(JSON.stringify({ settings: [setting('enabled', 'providerEnabled', values[id])] }));
            values[id] = JSON.parse(options.body).changes.enabled; writes.push(id); return new Response(JSON.stringify({}));
        });
        const guilds = Object.keys(values).map(guildId => ({ guildId, name: guildId, canManageGuild: true }));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds, locale: 'ja', viewerId: 'owner' })); await f.settle();
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, false);
        await f.click('現在の値で保存を完了'); await f.settle();
        assert.deepEqual(values, { '111111': false, '222222': false }); assert.deepEqual(writes, ['111111', '222222']);
        assert.equal(f.dom.window.localStorage.getItem('dashboard:bulk-pending:owner:twitter:111111,222222'), null);
    } finally { await f.close(); }
});

test('permission restriction includes a precise requirement and usable server recovery links', async () => {
    const f = await reactFixture('export { AccessDenied } from "./components/dashboard/access-denied";');
    try {
        await f.render(f.React.createElement(f.exports.AccessDenied, { locale: 'ja', guildId: '111111', required: 'サーバーの管理 または 管理者' }));
        assert(f.container.textContent.includes('サーバーの管理 または 管理者'));
        assert(!f.container.textContent.includes('Manage Channels'));
        assert.deepEqual([...f.container.querySelectorAll('a')].map(link => link.getAttribute('href')), ['/dashboard/111111/providers', '/dashboard?mode=user']);
    } finally { await f.close(); }
});

test('single-server preset failures are visible and retry succeeds without an unhandled event rejection', async () => {
    const f = await reactFixture('export { CrossSettingsView } from "./components/settings/cross-settings-view";');
    try {
        let calls = 0, saved = 0;
        f.set('confirm', () => true);
        f.set('fetch', async () => { calls++; return new Response(JSON.stringify(calls === 1 ? { error: '保存に失敗しました。' } : {}), { status: calls === 1 ? 500 : 200 }); });
        await f.render(f.React.createElement(f.exports.CrossSettingsView, { guildId: '111111', items: [], canManage: true, locale: 'ja', onSaved: () => saved++ }));
        await f.act(async () => f.container.querySelector('.settings-preset-choice').click());
        await f.click('全サービスに適用');
        assert(f.container.querySelector('[role="alert"]').textContent.includes('保存に失敗'));
        assert.equal(saved, 0);
        await f.click('失敗したサーバーだけ再試行');
        assert.equal(calls, 2); assert.equal(saved, 1);
        assert(f.container.textContent.includes('保存済み 1件'));
    } finally { await f.close(); }
});

test('bulk presets keep successful, HTTP-failed and network-failed receipts and retry only failed targets', async () => {
    const f = await reactFixture('export { MultiGuildBulkSettingsView } from "./components/settings/multi-guild-bulk-settings-view";');
    try {
        const writes = [], attempts = new Map();
        f.set('confirm', () => true);
        f.set('fetch', async (url, options = {}) => {
            if (url.endsWith('/providers')) return new Response(JSON.stringify([{ providerId: 'twitter', label: 'Twitter' }]));
            if (options.method !== 'POST') return new Response(JSON.stringify({ settings: [setting('enabled', 'providerEnabled', false)] }));
            const id = url.split('/')[3]; writes.push(id); const attempt = (attempts.get(id) || 0) + 1; attempts.set(id, attempt);
            if (id === '222222' && attempt === 1) return new Response(JSON.stringify({ error: '権限を確認してください。' }), { status: 403 });
            if (id === '333333' && attempt === 1) throw new Error('socket internals must not be displayed');
            return new Response(JSON.stringify({ warnings: id === '111111' ? ['元投稿を削除する設定です。'] : [] }));
        });
        const guilds = ['111111', '222222', '333333'].map(guildId => ({ guildId, name: `Server ${guildId}`, canManageGuild: true }));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds, locale: 'ja' })); await f.settle();
        await f.click('コンパクト表示を適用'); await f.settle();
        assert(f.container.textContent.includes('保存済み 1件 失敗 2件'));
        assert(f.container.textContent.includes('元投稿を削除する設定です。'));
        assert(!f.container.textContent.includes('socket internals'));
        await f.click('失敗したサーバーだけ再試行'); await f.settle();
        assert.deepEqual(writes, ['111111', '222222', '333333', '222222', '333333']);
        assert(f.container.textContent.includes('保存済み 3件 失敗 0件'));
    } finally { await f.close(); }
});

test('partial provider saves retain the draft until failed-only retry completes', async () => {
    const f = await reactFixture('export { MultiGuildBulkSettingsView } from "./components/settings/multi-guild-bulk-settings-view";');
    try {
        const writes = [], attempts = new Map(); let baselineValue = false;
        f.set('confirm', () => true);
        f.set('fetch', async (url, options = {}) => {
            if (url.endsWith('/providers')) return new Response(JSON.stringify([{ providerId: 'twitter', label: 'Twitter' }]));
            if (options.method !== 'PATCH') return new Response(JSON.stringify({ settings: [setting('enabled', 'providerEnabled', baselineValue)] }));
            const id = url.split('/')[3]; writes.push(id); const attempt = (attempts.get(id) || 0) + 1; attempts.set(id, attempt);
            if (id === '222222' && attempt === 1) return new Response(JSON.stringify({ error: '一時的に失敗しました。' }), { status: 500 });
            if (id === '111111') baselineValue = true;
            return new Response(JSON.stringify({}));
        });
        const guilds = ['111111', '222222'].map(guildId => ({ guildId, name: `Server ${guildId}`, canManageGuild: true }));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds, locale: 'ja' })); await f.settle();
        await f.act(async () => f.container.querySelector('input[aria-label="リンクを展開"]').click()); await f.click('変更を保存'); await f.settle();
        const draftKey = 'dashboard:bulk-draft:twitter:111111,222222';
        assert.deepEqual(JSON.parse(f.dom.window.localStorage.getItem(draftKey)), { enabled: true });
        await f.click('失敗したサーバーだけ再試行'); await f.settle();
        assert.deepEqual(writes, ['111111', '222222', '222222']);
        assert.equal(f.dom.window.localStorage.getItem(draftKey), null);
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, true);
    } finally { await f.close(); }
});

test('late batch responses cannot overwrite another server selection receipt', async () => {
    const f = await reactFixture('export { MultiGuildBulkSettingsView } from "./components/settings/multi-guild-bulk-settings-view";');
    try {
        const deferred = [];
        f.set('confirm', () => true);
        f.set('fetch', async (url, options = {}) => {
            if (url.endsWith('/providers')) return new Response(JSON.stringify([{ providerId: 'twitter', label: 'Twitter' }]));
            if (options.method !== 'POST') return new Response(JSON.stringify({ settings: [setting('enabled', 'providerEnabled', false)] }));
            if (url.includes('/111111/') || url.includes('/222222/')) return new Promise(resolve => deferred.push(resolve));
            return new Response(JSON.stringify({}));
        });
        const guilds = ids => ids.map(guildId => ({ guildId, name: `Server ${guildId}`, canManageGuild: true }));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds: guilds(['111111', '222222']), locale: 'ja' })); await f.settle();
        await f.click('コンパクト表示を適用'); assert.equal(deferred.length, 2);
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds: guilds(['333333', '444444']), locale: 'ja' })); await f.settle();
        await f.act(async () => { for (const resolve of deferred) resolve(new Response(JSON.stringify({}))); }); await f.settle();
        assert(!f.container.querySelector('[aria-label="サーバー別の保存結果"]'));
        await f.click('コンパクト表示を適用');
        const receipt = f.container.querySelector('[aria-label="サーバー別の保存結果"]');
        assert(receipt.textContent.includes('Server 333333')); assert(receipt.textContent.includes('Server 444444'));
        assert(!receipt.textContent.includes('Server 111111'));
    } finally { await f.close(); }
});

test('bulk drafts and result receipts are isolated when the authenticated viewer changes', async () => {
    const f = await reactFixture('export { MultiGuildBulkSettingsView } from "./components/settings/multi-guild-bulk-settings-view";');
    try {
        f.set('confirm', () => true);
        f.set('fetch', async (url, options = {}) => url.endsWith('/providers') ? new Response(JSON.stringify([{ providerId: 'twitter', label: 'Twitter' }])) : options.method === 'POST' ? new Response(JSON.stringify({ error: '保存できませんでした。' }), { status: 500 }) : new Response(JSON.stringify({ settings: [setting('enabled', 'providerEnabled', false)] })));
        const guilds = ['111111', '222222'].map(guildId => ({ guildId, name: guildId, canManageGuild: true }));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds, locale: 'ja', viewerId: 'owner-a' })); await f.settle();
        await f.act(async () => f.container.querySelector('input[aria-label="リンクを展開"]').click()); await f.settle();
        assert(f.dom.window.localStorage.getItem('dashboard:bulk-draft:owner-a:twitter:111111,222222'));
        await f.click('コンパクト表示を適用'); assert(f.container.querySelector('[aria-label="サーバー別の保存結果"]'));
        await f.render(f.React.createElement(f.exports.MultiGuildBulkSettingsView, { guilds, locale: 'ja', viewerId: 'owner-b' })); await f.settle();
        assert(!f.container.querySelector('[aria-label="サーバー別の保存結果"]'));
        assert.equal(f.container.querySelector('input[aria-label="リンクを展開"]').checked, false);
        assert.equal(f.dom.window.localStorage.getItem('dashboard:bulk-draft:owner-b:twitter:111111,222222'), null);
    } finally { await f.close(); }
});
