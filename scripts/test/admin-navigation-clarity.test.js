'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('server name search selects exact identity, keyboard selection works, and reset clears the applied scope', async () => {
    const f = await reactFixture('export { AdminContextBar } from "./components/admin/workspace-shell"; export { updateAdminLocation } from "./lib/admin-workspace";');
    f.dom.reconfigure({ url: 'http://127.0.0.1/admin?section=investigation&guildId=111&channelId=222&userId=333&messageId=444&outcome=E&from=2026-10-13T10:00' });
    const requests = [];
    f.set('fetch', async url => { requests.push(String(url)); return json({ items: String(url).includes('guildId=') ? [{ id: '888', name: '相談', type: 0 }] : [{ id: '111', name: '開発チーム' }, { id: '555', name: '運用チーム' }] }); });
    try {
        await f.render(f.React.createElement(f.exports.AdminContextBar)); await f.settle();
        const field = f.field('サーバー名・ID');
        await f.act(async () => field.focus()); await f.settle();
        await f.fill(field, '運用');
        assert.equal(new URL(f.dom.window.location.href).searchParams.get('guildId'), '111', 'typing a name does not apply an invalid server ID');
        const options = f.container.querySelectorAll('[role=option]');
        assert.equal(options.length, 1); assert.match(options[0].textContent, /運用チーム555/);
        await f.act(async () => field.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
        assert.equal(f.dom.window.document.activeElement, options[0]);
        await f.act(async () => options[0].dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
        await f.settle();
        assert.equal(new URL(f.dom.window.location.href).searchParams.get('guildId'), '555');
        assert.equal(field.value, '運用チーム'); assert.equal(field.getAttribute('aria-expanded'), 'false');
        assert.equal(new URL(f.dom.window.location.href).searchParams.has('channelId'), false);
        assert(requests.some(url => url.includes('guildId=555')));
        await f.act(async () => f.exports.updateAdminLocation({ guildId: '111' }));
        assert.equal(field.value, '開発チーム', 'an external navigation updates the displayed server');
        await f.fill(field, '999');
        assert.equal(new URL(f.dom.window.location.href).searchParams.get('guildId'), '999');
        await f.click('絞り込みを解除');
        const query = new URL(f.dom.window.location.href).searchParams;
        for (const key of ['guildId', 'channelId', 'userId', 'messageId', 'outcome', 'from']) assert.equal(query.has(key), false);
        assert.equal(query.get('section'), 'investigation');
    } finally { await f.close(); }
});

test('a pasted Discord post clears unrelated user/time filters before searching the exact post', async () => {
    const f = await reactFixture('export { AdminContextBar } from "./components/admin/workspace-shell";');
    f.dom.reconfigure({ url: 'http://127.0.0.1/admin?section=investigation&userId=999&from=2026-10-13T10:00&to=2026-10-13T11:00&outcome=E' });
    f.set('fetch', async () => json({ items: [] }));
    try {
        await f.render(f.React.createElement(f.exports.AdminContextBar));
        await f.fill(f.field('Discordの投稿リンク'), 'https://discord.com/channels/123/456/789'); await f.submit(); await f.settle();
        const q = new URL(f.dom.window.location.href).searchParams;
        assert.equal(q.get('guildId'), '123'); assert.equal(q.get('channelId'), '456'); assert.equal(q.get('messageId'), '789');
        for (const key of ['userId', 'from', 'to', 'outcome']) assert.equal(q.has(key), false);
    } finally { await f.close(); }
});

test('server directory failure keeps direct ID entry and gives a retry without exposing raw response errors', async () => {
    const f = await reactFixture('export { AdminContextBar } from "./components/admin/workspace-shell";');
    f.dom.reconfigure({ url: 'http://127.0.0.1/admin?section=servers' });
    let reads = 0;
    f.set('fetch', async () => ++reads === 1 ? json({ error: 'token=fixture-sensitive-value' }, 503) : json({ items: [{ id: '123', name: '検証サーバー' }] }));
    try {
        await f.render(f.React.createElement(f.exports.AdminContextBar));
        await f.act(async () => f.field('サーバー名・ID').focus()); await f.settle();
        assert.doesNotMatch(f.container.textContent, /fixture-sensitive-value/);
        await f.fill(f.field('サーバー名・ID'), '123');
        assert.equal(new URL(f.dom.window.location.href).searchParams.get('guildId'), '123');
        await f.click('サーバー候補を再取得'); await f.settle();
        assert.equal(reads, 2); assert.equal(new URL(f.dom.window.location.href).searchParams.get('guildId'), '123');
        assert(f.container.querySelector('[role=option]'));
    } finally { await f.close(); }
});

test('routine navigation stays visible while advanced management opens for a bookmarked advanced task', async () => {
    const f = await reactFixture('export { AdminSidebar } from "./components/admin/workspace-shell"; export { navigateAdmin } from "./lib/admin-workspace";');
    try {
        await f.render(f.React.createElement(f.exports.AdminSidebar));
        const advanced = f.container.querySelector('details'); assert.equal(advanced.open, false);
        assert.equal(f.container.querySelector('[aria-current=page]').textContent.trim(), 'サービスの状態');
        await f.act(async () => f.exports.navigateAdmin('operations', 'recovery'));
        assert.equal(advanced.open, true); assert.equal(f.container.querySelector('[aria-current=page]').textContent.trim(), 'Bot操作・復旧');
        await f.click('サーバー設定');
        assert.equal(new URL(f.dom.window.location.href).searchParams.get('tab'), 'settings'); assert.equal(advanced.open, false);
    } finally { await f.close(); }
});

test('Bot operation search/category changes preserve the selected draft and never dispatch an operation', async () => {
    const f = await reactFixture('export { ManagementConsole } from "./components/admin/management-console";');
    f.dom.reconfigure({ url: 'http://127.0.0.1/admin?section=operations&tab=operations' });
    f.set('sessionStorage', f.dom.window.sessionStorage);
    const requests = [];
    const actions = [{ type: 'service.restart', label: 'Botを再起動', mutating: true, inputExample: { reason: '' }, description: '実行中の処理が一時停止します。' }, { type: 'settings.get', label: '設定を確認', inputExample: { guildId: '' } }];
    f.set('fetch', async (url, options = {}) => { requests.push({ url: String(url), method: options.method || 'GET' }); if (String(url) === '/api/admin/catalog') return json({ providers: [] }); if (String(url).endsWith('/catalog')) return json({ actions }); if (String(url).endsWith('/health')) return json({ ok: true }); throw new Error(`Unexpected request ${url}`); });
    try {
        await f.render(f.React.createElement(f.exports.ManagementConsole)); await f.settle();
        await f.fill(f.field('実行する操作'), 'service.restart');
        await f.fill(f.field('操作理由'), 'fixture draft');
        await f.fill(f.field('Bot操作を検索'), '設定');
        const selector = f.field('実行する操作'); assert.equal(selector.value, 'service.restart');
        assert.match(selector.selectedOptions[0].textContent, /選択中 Botを再起動/);
        assert.equal(f.field('操作理由').value, 'fixture draft');
        await f.click('設定・アクセス');
        assert.equal(selector.value, 'service.restart'); assert.equal(f.field('操作理由').value, 'fixture draft');
        assert(requests.every(request => request.method === 'GET'));
        const submit = [...f.container.querySelectorAll('button')].find(button => button.textContent.trim() === 'Botを再起動');
        assert.equal(submit.disabled, true, 'mutating drafts remain gated by the confirmation');
    } finally { await f.close(); }
});

test('a report render failure presents recovery without displaying its raw exception', async () => {
    const f = await reactFixture('export { ReportErrorBoundary } from "./components/admin/report-error-boundary";');
    f.set('console', { ...console, error() {} });
    function Broken() { throw new Error('token=fixture-sensitive-value'); }
    try {
        await f.render(f.React.createElement(f.exports.ReportErrorBoundary, null, f.React.createElement(Broken)));
        assert.match(f.container.textContent, /レポートを表示できませんでした/);
        assert.doesNotMatch(f.container.textContent, /fixture-sensitive-value/);
        assert([...f.container.querySelectorAll('button')].some(button => button.textContent === 'レポートを再表示'));
    } finally { await f.close(); }
});
