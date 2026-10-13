'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const entry = 'export { PersonalLinksWorkspace } from "./components/personal-links/personal-links-workspace";';
const props = { viewerId: '222222222222222222', locale: 'ja', displayName: 'Fixture' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const link = (id, tags = ['作品']) => ({ id, kind: 'saved', url: `https://example.test/${id}`, title: `リンク ${id}`, tags, note: '', updatedAt: 12, editable: true, cancellable: true });
const registration = f => f.container.querySelector('form[aria-label="リンク・通知を登録"]');
const submitSearch = f => f.act(async () => f.container.querySelector('form[aria-label="保存を検索"]').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));

test('personal library starts with the list on desktop and opens a minimal URL form only when requested', async () => {
    const f = await reactFixture(entry);
    try {
        const writes = [];
        f.dom.window.matchMedia = query => ({ matches: query.includes('min-width') });
        f.set('fetch', async (_url, options) => {
            if (options.method === 'GET') return response({ items: [link('existing')], hasMore: false });
            writes.push(JSON.parse(options.body)); return response({});
        });
        await f.render(f.React.createElement(f.exports.PersonalLinksWorkspace, props)); await f.settle();
        assert(registration(f).classList.contains('hidden'));
        assert(!registration(f).classList.contains('lg:block'));
        assert(f.container.querySelector('article').textContent.includes('リンク existing'));
        assert(!f.container.textContent.includes('1 ページ'));
        await f.click('リンクを追加');
        assert(!registration(f).classList.contains('hidden'));
        assert.equal(f.dom.window.document.activeElement, f.field('URL'));
        const metadata = registration(f).querySelector('details');
        assert.equal(metadata.open, false);
        await f.fill(f.field('URL'), 'https://example.test/new');
        assert.equal(writes.length, 0);
        await f.act(async () => metadata.querySelector('summary').click());
        await f.fill(f.field('タイトル'), '読みたい作品');
        await f.fill(f.field('タグ（'), '作品, 動画, 作品');
        await f.fill(f.field('メモ'), 'あとで比較する');
        await f.submit(); await f.settle();
        assert.deepEqual(writes, [{ url: 'https://example.test/new', title: '読みたい作品', tags: ['作品', '動画'], note: 'あとで比較する' }]);
        assert(registration(f).classList.contains('hidden'));
        assert(f.container.textContent.includes('リンクを保存しました。'));
    } finally { await f.close(); }
});

test('tag chips query the saved library, reset paging and retain the submitted search until filters are cleared', async () => {
    const f = await reactFixture(entry);
    try {
        const reads = [];
        f.set('fetch', async url => {
            const parsed = new URL(url, 'http://127.0.0.1'); reads.push(parsed);
            return response({ items: [link(parsed.searchParams.get('page'), ['作品'])], hasMore: !parsed.searchParams.get('tag') });
        });
        await f.render(f.React.createElement(f.exports.PersonalLinksWorkspace, props)); await f.settle();
        await f.fill(f.container.querySelector('input[aria-label="タイトル・URL・メモを検索"]'), '  読みたい  ');
        await submitSearch(f); await f.settle();
        assert.equal(reads.at(-1).searchParams.get('query'), '読みたい');
        await f.click('次へ'); await f.settle(); assert.equal(reads.at(-1).searchParams.get('page'), '2');
        await f.act(async () => f.container.querySelector('button[aria-label="タグ「作品」で絞り込む"]').click()); await f.settle();
        assert.equal(reads.at(-1).searchParams.get('page'), '1');
        assert.equal(reads.at(-1).searchParams.get('query'), '読みたい');
        assert.equal(reads.at(-1).searchParams.get('tag'), '作品');
        assert.equal(f.container.querySelector('input[aria-label="タグで絞り込み"]').value, '作品');
        assert(![...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '次へ'));
        await f.click('検索条件をクリア'); await f.settle();
        assert.equal(reads.at(-1).searchParams.get('page'), '1');
        assert.equal(reads.at(-1).searchParams.get('query'), '');
        assert.equal(reads.at(-1).searchParams.get('tag'), '');
        assert.equal(f.container.querySelector('input[aria-label="タイトル・URL・メモを検索"]').value, '');
    } finally { await f.close(); }
});

test('link deletion keeps its consequence and requires a second explicit action; cancelling keeps the link', async () => {
    const f = await reactFixture(entry);
    try {
        let deleted = false; const writes = [];
        f.set('fetch', async (url, options) => {
            if (options.method === 'GET') return response({ items: deleted ? [] : [link('delete-me')], hasMore: false });
            writes.push([url, options.method]); deleted = true; return response({});
        });
        await f.render(f.React.createElement(f.exports.PersonalLinksWorkspace, props)); await f.settle();
        await f.click('リンクを削除');
        assert.equal(writes.length, 0);
        assert(f.container.textContent.includes('削除すると元に戻せません。'));
        await f.click('削除しない'); assert.equal(writes.length, 0); assert(f.container.querySelector('article'));
        await f.click('リンクを削除'); await f.click('リンクを削除'); await f.settle();
        assert.deepEqual(writes, [['/api/personal-links/saved/delete-me', 'DELETE']]);
        assert.equal(f.container.querySelector('article'), null);
        assert(f.container.textContent.includes('リンクを追加'));
        assert(!f.container.textContent.includes('登録は0件'));
    } finally { await f.close(); }
});

test('search recovery keeps the query and a failed list can be retried without opening registration', async () => {
    const f = await reactFixture(entry);
    try {
        const reads = []; let fail = false;
        f.set('fetch', async url => {
            reads.push(new URL(url, 'http://127.0.0.1'));
            return fail ? response({ error: '一覧を取得できませんでした。' }, 503) : response({ items: [link('retry')], hasMore: false });
        });
        await f.render(f.React.createElement(f.exports.PersonalLinksWorkspace, props)); await f.settle();
        await f.fill(f.container.querySelector('input[aria-label="タイトル・URL・メモを検索"]'), '読みたい');
        fail = true; await submitSearch(f); await f.settle();
        assert(f.container.querySelector('[role="alert"]').textContent.includes('一覧を取得できませんでした。'));
        assert(registration(f).classList.contains('hidden'));
        fail = false; await f.click('再読み込み'); await f.settle();
        assert.equal(reads.at(-1).searchParams.get('query'), '読みたい');
        assert(f.container.querySelector('article').textContent.includes('リンク retry'));
        assert(registration(f).classList.contains('hidden'));
    } finally { await f.close(); }
});
