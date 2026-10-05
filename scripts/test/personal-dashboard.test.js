'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const load = require('./helpers/load-dashboard.cjs');
const { createFixture } = require('../lib/personal-dashboard-fixture.cjs');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const user = '111111111111111111', other = '222222222222222222', guild = '333333333333333333';

test('personal dashboard HTTP boundary requires session, same-origin JSON and bounded input; errors reveal no backend details', async t => {
    const original = process.env.NEXTAUTH_URL; delete process.env.NEXTAUTH_URL;
    t.after(() => { if (original === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = original; });
    let signedIn = false, calls = 0;
    class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
    const actual = load('lib/personal-links-server.ts');
    const route = load('app/api/personal-links/[...path]/route.ts', {
        '@/lib/api': { ApiError, requireSession: async () => { if (!signedIn) throw new ApiError(401, 'login required'); return { user: { id: user, isAdmin: true } }; },
            json: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }) },
        '@/lib/server-locale': { getDashboardLocaleFromRequest: () => 'ja' },
        '@/lib/personal-links-server': { ...actual, personalLinkServices: () => { calls++; throw new Error('DB password=private internal information'); } },
    });
    function request(method, body, origin = 'http://local.test') {
        const req = new Request('http://local.test/api/personal-links/saved', { method, headers: { origin, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
        req.nextUrl = new URL(req.url); return req;
    }
    const context = { params: Promise.resolve({ path: ['saved'] }) };
    assert.equal((await route.GET(request('GET'), context)).status, 401);
    assert.equal(calls, 0);
    signedIn = true;
    assert.equal((await route.POST(request('POST', {}, 'http://foreign.test'), context)).status, 403);
    assert.equal((await route.POST(request('POST', { note: 'x'.repeat(17000) }), context)).status, 413);
    assert.equal(calls, 0);
    const failed = await route.GET(request('GET'), context);
    assert.equal(failed.status, 500); assert.equal(failed.headers.get('cache-control'), 'private, no-store');
    assert.doesNotMatch(await failed.text(), /password|private internal/);
});

test('web API exposes display fields only and rejects forged ownership', async () => {
    const api = load('lib/personal-links-server.ts');
    const calls = [];
    const services = { model: require('../../src/personalLinks/model'), store: { listNotifications: async (owner, kind) => {
        calls.push(owner); return [{ id: 'a'.repeat(32), kind, url: 'https://x.com/a/status/123', title: 'Saved', status: 'pending', updated_at_ms: 12, user_id: other, lease_token: 'private', request_key: 'private' }];
    }, save: async () => assert.fail('forged body reached the store') } };
    const result = await api.dispatchPersonalLinks({ method: 'GET', path: ['reminder'], search: new URLSearchParams() }, user, 'ja', services);
    assert.deepEqual(calls, [user]);
    assert.doesNotMatch(JSON.stringify(result), /lease_token|request_key|user_id|private/);
    await assert.rejects(api.dispatchPersonalLinks({ method: 'POST', path: ['saved'], search: new URLSearchParams(), body: { url: 'https://x.com/a/status/123', userId: other } }, user, 'ja', services));
});

test('restock options and direct dashboard writes only accept targets confirmed sold out', async () => {
    const api = load('lib/personal-links-server.ts');
    const stored = [];
    const services = { model: require('../../src/personalLinks/model'), stockOptions: async () => ({ options: [
        { id: '7', name: 'Red', state: 'sold_out' },
    ] }), store: { createNotification: async (_owner, _entry, options) => stored.push(options) } };
    const valid = { url: 'https://booth.pm/ja/items/123', title: 'Item', variationId: '7', variationName: 'forged', requestId: crypto.randomUUID() };
    await api.dispatchPersonalLinks({ method: 'POST', path: ['restock'], search: new URLSearchParams(), body: valid }, user, 'ja', services);
    assert.equal(stored[0].variationName, 'Red');
    await assert.rejects(api.dispatchPersonalLinks({ method: 'POST', path: ['restock'], search: new URLSearchParams(), body: { ...valid, variationId: '8', requestId: crypto.randomUUID() } }, user, 'ja', services), /INVALID_VARIATION/);
    const result = await api.dispatchPersonalLinks({ method: 'POST', path: ['restock', 'options'], search: new URLSearchParams(), body: { url: valid.url } }, user, 'ja', services);
    assert.deepEqual(result.options, [{ id: '7', name: 'Red', state: 'sold_out' }]);
});

test('gallery preview follows the chosen layout and leaves restricted media modes unchanged', () => {
    const { buildPreview } = load('lib/settings-preview.ts');
    const states = (values) => Object.entries(values).map(([key, value]) => ({ key, value }));
    const normal = buildPreview('pixiv', states({ gallery_display_mode: 'normal' }));
    const paged = buildPreview('pixiv', states({ gallery_display_mode: 'gallery' }));
    assert.equal(normal.gallery, false); assert.equal(paged.gallery, true);
    assert.match(paged.image, /1ページ目/);
    for (const media_display_mode of ['thumbnail_only', 'link_only']) {
        const preview = buildPreview('instagram', states({ gallery_display_mode: 'gallery', media_display_mode }));
        assert.equal(preview.gallery, false); assert.equal(preview.image, null);
    }
});

test('real SQL web management shares Discord records, protects other owners, detects conflicts and reschedules safely', { skip: !port }, async () => {
    const f = await createFixture(port);
    try {
        const call = (method, path, body, actor = user, query = '') => f.api.dispatchPersonalLinks({ method, path: path.split('/'), body, search: new URLSearchParams(query) }, actor, 'ja', f.services);
        const saved = await f.store.save(user, f.services.model.link('https://x.com/a/status/123', 'Discordで保存'), { tags: '元のタグ', note: 'Discordのメモ' });
        let list = await call('GET', 'saved'); assert.equal(list.items[0].id, saved.id);
        assert.equal((await call('GET', 'saved', undefined, other)).items.length, 0);
        await assert.rejects(call('PATCH', `saved/${saved.id}`, { title: '偽', tags: [], note: '', revision: list.items[0].updatedAt }, other), /NOT_FOUND/);
        const revision = list.items[0].updatedAt;
        await call('PATCH', `saved/${saved.id}`, { title: 'Webで編集', tags: ['更新'], note: 'Webのメモ', revision });
        assert.equal((await f.store.getSaved(user, saved.id)).title, 'Webで編集');
        await assert.rejects(call('PATCH', `saved/${saved.id}`, { title: '古い編集', tags: [], note: '', revision }), /EDIT_CONFLICT/);
        assert.equal((await call('GET', 'saved', undefined, user, 'query=Web&tag=更新')).items.length, 1);
        const reminder = { url: 'https://x.com/a/status/123', when: '1h', title: '予約', requestId: crypto.randomUUID() };
        await call('POST', 'reminder', reminder); await call('POST', 'reminder', reminder);
        list = await call('GET', 'reminder'); assert.equal(list.items.length, 1);
        const item = list.items[0], due = item.dueAt;
        const claim = await f.store.claim(due + 1); assert.ok(claim);
        await call('PATCH', `reminder/${item.id}`, { url: item.url, title: '日時変更', when: '2h', timeZone: 'Asia/Tokyo', revision: item.updatedAt });
        assert.equal(await f.store.beginSend(claim, due + 2), false);
        const changed = (await call('GET', 'reminder')).items[0]; assert.ok(changed.dueAt > due);
        const next = await f.store.claim(changed.dueAt + 1); assert.ok(await f.store.beginSend(next, changed.dueAt + 2));
        await assert.rejects(call('PATCH', `reminder/${item.id}`, { url: item.url, title: '送信中変更', when: '3h', timeZone: 'Asia/Tokyo', revision: changed.updatedAt }), /NOT_EDITABLE/);
        await call('POST', 'restock', { url: 'https://booth.pm/ja/items/123', title: '商品', variationId: '7', requestId: crypto.randomUUID() });
        const watch = (await call('GET', 'restock')).items[0];
        await call('PATCH', `restock/${watch.id}`, { url: 'https://booth.pm/ja/items/456', title: '別の商品', variationId: '8', revision: watch.updatedAt });
        const watchRow = (await f.store.listNotifications(user, 'restock'))[0];
        assert.equal(watchRow.item_id, '456'); assert.equal(watchRow.variation_id, '8'); assert.equal(watchRow.last_stock_state, null);
        await assert.rejects(call('DELETE', `restock/${watch.id}`, {}, other), /NOT_FOUND/);
        await call('DELETE', `restock/${watch.id}`, {});
        assert.equal((await call('GET', 'restock')).items[0].status, 'cancelled');
        await call('DELETE', `saved/${saved.id}`, {});
        assert.equal(await f.store.getSaved(user, saved.id), null);
    } finally { await f.close(); }
});

test('real dashboard settings persist gallery, previous-share and silent-send choices; production Bot reader sees all', { skip: !port }, async () => {
    const f = await createFixture(port);
    try {
        const provider = { id: 'pixiv', enabledByDefault: false };
        const initial = await f.botSettings.getProviderSettings(provider, guild);
        assert.equal(initial.gallery_display_mode, 'normal'); assert.equal(initial.show_previous_shares, true);
        assert.equal(initial.silent_expansion, false);
        const states = await f.settings.getProviderSettingsState('pixiv', guild, 'ja');
        assert.deepEqual(states.find(s => s.key === 'gallery_display_mode').spec.choices.map(c => c.value), ['normal', 'gallery']);
        assert.ok(states.some(s => s.key === 'show_previous_shares' && s.kind === 'bool'));
        assert.ok(states.some(s => s.key === 'silent_expansion' && s.kind === 'bool' && s.spec.category === 'output'));
        await f.settings.saveProviderSettings(guild, 'pixiv', { changes: { gallery_display_mode: 'gallery', show_previous_shares: false, silent_expansion: true } }, { id: user, username: 'Fixture' });
        const fresh = await f.botSettings._internal.loadProviderSettings(provider, guild);
        assert.equal(fresh.gallery_display_mode, 'gallery'); assert.equal(fresh.show_previous_shares, false);
        assert.equal(fresh.silent_expansion, true);
        assert.equal((await f.db.queryDatabase('SELECT * FROM provider_settings_cache_invalidations')).length, 1);
        const readBack = await f.settings.getProviderSettingsState('pixiv', guild, 'ja');
        assert.equal(readBack.find(s => s.key === 'show_previous_shares').value, false);
        assert.equal(readBack.find(s => s.key === 'silent_expansion').value, true);
        let sent = 0;
        const history = require('../../src/sharedPostHistory').createHistory({ queryDatabase: async () => assert.fail('disabled history accessed storage') });
        await history.run({ id: '1', guildId: guild }, [{ content: '今回も展開' }], { sharedHistory: true, presentationSettings: fresh }, async steps => { assert.equal(steps[0].content, '今回も展開'); sent++; });
        assert.equal(sent, 1);
        await f.settings.saveProviderSettings(guild, 'pixiv', { changes: { gallery_display_mode: 'normal', show_previous_shares: true, silent_expansion: false } }, { id: user, username: 'Fixture' });
        const reverted = await f.botSettings._internal.loadProviderSettings(provider, guild);
        assert.equal(reverted.gallery_display_mode, 'normal'); assert.equal(reverted.show_previous_shares, true);
        assert.equal(reverted.silent_expansion, false);
    } finally { await f.close(); }
});
