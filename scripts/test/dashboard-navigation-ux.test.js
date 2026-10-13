'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

const guild = (id, name, canManageGuild = true) => ({ guildId: id, name, iconUrl: null, canEdit: canManageGuild, canManageGuild,
    permissions: { administrator: false, manageGuild: canManageGuild, manageChannels: false }, providerSummary: { enabled: 5, total: 12, disabled: 7 } });

test('one navigation identifies exactly the current server page while retaining personal destinations', async () => {
    let pathname = '/dashboard/111111/providers/twitter';
    const f = await reactFixture('export { DashboardWorkspace } from "./components/dashboard/dashboard-workspace";', { moduleOverrides: { 'next/navigation': { usePathname: () => pathname, useRouter: () => ({ push() {}, refresh() {} }) } } });
    try {
        const props = { locale: 'ja', initialGuildIds: ['111111'], defaultLayout: 'server', defaultGuildId: '111111', guildName: '設定対象のサーバー' };
        await f.render(f.React.createElement(f.exports.DashboardWorkspace, props, 'Content'));
        assert.equal(f.container.querySelectorAll('a[aria-current="page"]').length, 1);
        assert.equal(f.container.querySelector('a[aria-current="page"]').getAttribute('href'), '/dashboard/111111/providers');
        assert(f.container.querySelector('a[href="/dashboard/personal-links"]'));
        pathname = '/dashboard/222222/logs';
        await f.render(f.React.createElement(f.exports.DashboardWorkspace, { ...props, initialGuildIds: ['222222'], defaultGuildId: '222222', guildName: '新しいサーバー' }, 'New content'));
        assert.equal(f.container.querySelector('a[aria-current="page"]').getAttribute('href'), '/dashboard/222222/logs');
        assert(f.container.querySelector('.dashboard-navigation-tools').open);
        assert(![...f.container.querySelectorAll('a')].some(link => link.getAttribute('href').includes('/111111')));
        assert(f.container.querySelector('.dashboard-navigation-server').textContent.includes('新しいサーバー'));
    } finally { await f.close(); }
});

test('mobile menu closes on Escape with focus restored and closes after choosing a destination', async () => {
    const f = await reactFixture('export { DashboardWorkspace } from "./components/dashboard/dashboard-workspace";');
    try {
        await f.render(f.React.createElement(f.exports.DashboardWorkspace, { locale: 'ja', initialGuildIds: [], defaultLayout: 'plain' }, 'Content'));
        const trigger = f.container.querySelector('.dashboard-mobile-menu');
        await f.act(async () => trigger.click());
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        await f.act(async () => trigger.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(f.dom.window.document.activeElement, trigger);
        await f.act(async () => trigger.click());
        const destination = f.container.querySelector('nav a');
        destination.addEventListener('click', event => event.preventDefault());
        await f.act(async () => destination.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    } finally { await f.close(); }
});

test('server list opens link settings directly and recovers an empty search without exposing bulk selection', async () => {
    const f = await reactFixture('export { GuildList } from "./components/dashboard/guild-list";');
    try {
        await f.render(f.React.createElement(f.exports.GuildList, { locale: 'ja', guilds: [guild('111111', '活動サーバー'), guild('222222', '閲覧サーバー', false)] }));
        assert.equal(f.container.querySelectorAll('input[type="checkbox"]').length, 0);
        assert(f.container.querySelector('.guild-directory-actions a[href="/dashboard/111111/providers"]'));
        assert(!f.container.textContent.includes('Administrator'));
        await f.fill(f.container.querySelector('input[type="search"]'), 'missing');
        assert.equal(f.container.querySelectorAll('.guild-directory-row').length, 0);
        await f.click('検索をクリア');
        assert.equal(f.container.querySelectorAll('.guild-directory-row').length, 2);
    } finally { await f.close(); }
});

test('copying settings requires explicit source and manageable targets, confirmation, and keeps selection after failure', async () => {
    const f = await reactFixture('export { GuildList } from "./components/dashboard/guild-list";');
    try {
        const writes = []; let accept = false, fail = true;
        f.set('confirm', () => accept);
        f.set('fetch', async (_url, options) => { writes.push(JSON.parse(options.body)); return new Response(JSON.stringify(fail ? { error: 'private-token-raw-error' } : { targetCount: 1 }), { status: fail ? 500 : 200 }); });
        await f.render(f.React.createElement(f.exports.GuildList, { locale: 'ja', guilds: [guild('111111', 'コピー元'), guild('222222', 'コピー先'), guild('333333', '閲覧のみ', false)] }));
        await f.act(async () => f.container.querySelector('summary').click());
        await f.click('この設定を他のサーバーへコピー');
        const boxes = [...f.container.querySelectorAll('input[type="checkbox"]')];
        assert.equal(boxes[0].disabled, true); assert.equal(boxes[2].disabled, true);
        await f.act(async () => boxes[1].click());
        await f.click('設定をコピー'); assert.equal(writes.length, 0);
        accept = true; await f.click('設定をコピー');
        assert.deepEqual(writes[0], { sourceGuildId: '111111', targetGuildIds: ['222222'] });
        assert(f.container.querySelector('[role="alert"]'));
        assert(!f.container.textContent.includes('private-token'));
        assert.equal(f.container.querySelectorAll('input[type="checkbox"]')[1].checked, true);
        fail = false; await f.click('設定をコピー');
        assert.equal(f.container.querySelectorAll('input[type="checkbox"]').length, 0);
        assert(f.container.querySelector('[role="status"]').textContent.includes('1'));
    } finally { await f.close(); }
});

test('bulk server selection retains targets across search and blocks view-only targets', async () => {
    const pushes = [];
    const f = await reactFixture('export { GuildList } from "./components/dashboard/guild-list";', { moduleOverrides: { 'next/navigation': { useRouter: () => ({ push: href => pushes.push(href), refresh() {} }) } } });
    try {
        await f.render(f.React.createElement(f.exports.GuildList, { locale: 'ja', guilds: [guild('111111', 'Alpha'), guild('222222', 'Beta'), guild('333333', 'Read only', false)] }));
        await f.click('複数サーバーを変更');
        assert.equal(f.container.querySelectorAll('input[type="checkbox"]')[2].disabled, true);
        await f.act(async () => f.container.querySelectorAll('input[type="checkbox"]')[0].click());
        await f.fill(f.container.querySelector('input[type="search"]'), 'Beta');
        await f.act(async () => f.container.querySelector('input[type="checkbox"]').click());
        let target;
        f.dom.window.addEventListener('dashboard:guild-navigation', event => { target = event.detail.href; event.preventDefault(); });
        await f.click('選択したサーバーの設定を開く');
        assert.equal(target, '/dashboard/bulk?guildIds=111111%2C222222');
    } finally { await f.close(); }
});

test('single server selection replaces the previous target and opens its home without implicitly entering bulk mode', async () => {
    const pushes = [];
    const f = await reactFixture('export { GuildSwitcher } from "./components/dashboard/guild-switcher";', { moduleOverrides: { 'next/navigation': { useRouter: () => ({ push: href => pushes.push(href) }) } } });
    try {
        await f.render(f.React.createElement(f.exports.GuildSwitcher, { locale: 'ja', selectedGuildIds: ['111111'], guilds: [{ guildId: '111111', name: 'Alpha' }, { guildId: '222222', name: 'Beta' }] }));
        await f.act(async () => f.container.querySelector('button[aria-haspopup="dialog"]').click());
        assert.equal(f.container.querySelectorAll('input[type="checkbox"]').length, 0);
        await f.act(async () => f.container.querySelectorAll('input[type="radio"]')[1].click());
        assert.equal(pushes.length, 0);
        await f.click('サーバーを開く');
        assert.deepEqual(pushes, ['/dashboard/222222']);
    } finally { await f.close(); }
});

test('closing an unconfirmed server choice keeps the header bound to the displayed server and blocks unmanageable bulk targets', async () => {
    const pushes = [];
    const f = await reactFixture('export { GuildSwitcher } from "./components/dashboard/guild-switcher";', { moduleOverrides: { 'next/navigation': { useRouter: () => ({ push: href => pushes.push(href) }) } } });
    try {
        await f.render(f.React.createElement(f.exports.GuildSwitcher, { locale: 'ja', selectedGuildIds: ['111111'], guilds: [{ guildId: '111111', name: 'Displayed server', canManageGuild: true }, { guildId: '222222', name: 'Other server', canManageGuild: false }] }));
        const trigger = f.container.querySelector('button[aria-haspopup="dialog"]');
        await f.act(async () => trigger.click());
        await f.act(async () => f.container.querySelectorAll('input[type="radio"]')[1].click());
        assert(trigger.textContent.includes('Displayed server'));
        await f.act(async () => trigger.click());
        assert(trigger.textContent.includes('Displayed server'));
        assert.equal(pushes.length, 0);
        await f.act(async () => trigger.click());
        assert.equal(f.container.querySelectorAll('input[type="radio"]')[0].checked, true);
        await f.click('複数サーバーを変更');
        assert.equal(f.container.querySelectorAll('input[type="checkbox"]')[1].disabled, true);
        assert(f.container.textContent.includes('管理権限が必要'));
    } finally { await f.close(); }
});

test('page error recovery offers retry and server selection without rendering private diagnostic details', async () => {
    const f = await reactFixture('export { default as DashboardError } from "./app/dashboard/error"; export { DashboardUIProvider } from "./components/dashboard/dashboard-ui-provider";');
    try {
        let resets = 0;
        await f.render(f.React.createElement(f.exports.DashboardUIProvider, { version: 'preview' }, f.React.createElement(f.exports.DashboardError, { error: new Error('mysql://private-password@server'), reset: () => { resets++; } })));
        assert(!f.container.textContent.includes('private-password'));
        await f.click('もう一度読み込む'); assert.equal(resets, 1);
        assert(f.container.querySelector('a[href="/dashboard?mode=user"]'));
    } finally { await f.close(); }
});
