'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { fetchSource } = require('../../src/providers/autoWatch');

// Generate the irrelevant payload a chunk at a time. The mocked .text() must
// never be called, which also catches accidentally restoring whole-page reads.
function streamedResponse(prefix, suffix, { status = 200, filler = 'x'.repeat(8192), repeats = 1024, headers = {} } = {}) {
    const values = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const chunks = async function* () {
        // Split UTF-8 characters and token boundaries, as real sockets can do.
        const head = Buffer.from(prefix);
        for (let i = 0; i < head.length; i += 7) yield head.subarray(i, i + 7);
        for (let i = 0; i < repeats; i++) yield Buffer.from(filler);
        const tail = Buffer.from(suffix);
        for (let i = 0; i < tail.length; i += 11) yield tail.subarray(i, i + 11);
    };
    return {
        status, ok: status >= 200 && status < 300,
        headers: { get: key => values[String(key).toLowerCase()] || null },
        body: Readable.from(chunks()),
        text: async () => { throw new Error('Whole-response reads are forbidden in streaming adapter tests.'); },
    };
}

async function acquire(provider_id, source_key, response) {
    return fetchSource({ provider_id, source_key, state_json: '{}' }, { config: {}, fetch: async () => response });
}

test('GitHub streaming keeps all notification fields after a large irrelevant commit payload', async () => {
    const result = await acquire('github', 'octocat', streamedResponse('[{"payload":{"commits":[{"patch":"',
        '"}],"release":{"html_url":"https://github.com/octocat/repo/releases/tag/v1","body":"release body 😀"}},"id":"event-1","type":"ReleaseEvent","created_at":"2026-10-13T00:00:00Z","repo":{"name":"octocat/repo"},"actor":{"login":"octocat"}}]', { headers: { etag: 'new-etag' } }));
    assert.deepEqual(result.items, [{
        contentId: 'event-1', url: 'https://github.com/octocat/repo/releases/tag/v1',
        publishedAtMs: Date.parse('2026-10-13T00:00:00Z'), title: 'ReleaseEvent', kind: 'ReleaseEvent',
        author: 'octocat', body: 'release body 😀',
    }]);
    assert.equal(result.etag, 'new-etag');
});

test('GitHub release body remains complete beyond the former metadata token size', async () => {
    const body = 'release details 😀\n'.repeat(6000);
    const events = [{ id: 'release-2', type: 'ReleaseEvent', repo: { name: 'octocat/repo' }, payload: { release: { html_url: 'https://github.com/octocat/repo/releases/tag/v2', body } } }];
    const result = await acquire('github', 'octocat', streamedResponse('', JSON.stringify(events), { repeats: 0 }));
    assert.equal(result.items[0].body.length, body.length);
    assert.equal(result.items[0].body, body);
});

test('Twitch streaming preserves offline/null state and live metadata past unrelated large JSON', async () => {
    const live = await acquire('twitch', 'sample', streamedResponse('{"ignored":"',
        '","data":{"user":{"id":"1","login":"sample","stream":{"id":"stream-1","title":"配信 😀","createdAt":"2026-10-13T00:00:00Z"}}}}'));
    assert.equal(live.items[0].title, '配信 😀');
    assert.equal(live.items[0].publishedAtMs, Date.parse('2026-10-13T00:00:00Z'));
    const offline = await acquire('twitch', 'sample', streamedResponse('{"ignored":"', '","data":{"user":{"id":"1","stream":null}}}'));
    assert.deepEqual(offline.items, []);
    await assert.rejects(acquire('twitch', 'sample', streamedResponse('{"data":{"user":{"id":"1"}},"ignored":"', '"}')), { code: 'AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE' });
    await assert.rejects(acquire('twitch', 'sample', streamedResponse('{"errors":[{}],"data":{"user":{"stream":null}},"ignored":"', '"}')), { code: 'AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE' });
});

test('Pixiv streaming keeps null index entries, timestamps, and empty manga index', async () => {
    const result = await acquire('pixiv', '123', streamedResponse('{"error":false,"body":{"irrelevant":"',
        '","illusts":{"101":null,"102":{"title":"作品 😀","createDate":"2026-10-13T00:00:00Z","description":"discarded"}},"manga":{}}}'));
    assert.deepEqual(result.items.map(item => item.contentId), ['102', '101']);
    assert.equal(result.items[0].title, '作品 😀');
    assert.equal(result.items[0].publishedAtMs, Date.parse('2026-10-13T00:00:00Z'));
    assert.equal(result.items[1].title, null);
    assert.equal(result.items[1].publishedAtMs, null);
});

test('Spotify streaming ignores large assets and preserves release section membership and metadata', async () => {
    const album = 'A'.repeat(22), unrelated = 'B'.repeat(22);
    const result = await acquire('spotify', '0TnOYISbd1XYRBk9myaseg', streamedResponse('<style>/*',
        `*/</style><h2>Popular releases</h2><a href="/album/${unrelated}">unrelated</a><h2>Albums</h2><a href="/album/${album}"><span class="encore-text-body-small-bold">新作 😀</span><div>Album • 2026</div></a><h2>Featuring artist</h2><a href="/album/${unrelated}">unrelated</a><script type="application/ld+json">{"@graph":[{"@type":"MusicAlbum","url":"https://open.spotify.com/album/${album}","datePublished":"2026-10-13T00:00:00Z"}]}</script>`));
    assert.deepEqual(result.items.map(item => item.contentId), [album]);
    assert.equal(result.items[0].title, '新作 😀');
    assert.equal(result.items[0].publishedAtMs, Date.parse('2026-10-13T00:00:00Z'));
});

test('Spotify keeps release cards when optional JSON-LD metadata is malformed', async () => {
    const album = 'A'.repeat(22);
    for (const invalidJson of ['{"@type":"MusicAlbum",bad}', '{"@type":"MusicAlbum"']) {
        const result = await acquire('spotify', '0TnOYISbd1XYRBk9myaseg', streamedResponse('',
            `<h2>Albums</h2><a href="/album/${album}">valid card</a><script type="application/ld+json">${invalidJson}</script>`, { repeats: 0 }));
        assert.deepEqual(result.items.map(item => item.contentId), [album]);
        assert.equal(result.items[0].title, 'valid card');
    }
});

test('BOOTH streaming keeps owner-qualified hydration cards after large script assets', async () => {
    const cards = [{ id: 101, shop_item_url: 'https://sample.booth.pm/items/101', name: '新作 😀', published_at: '2026-10-13T00:00:00Z' },
        { id: 999, shop_item_url: 'https://other.booth.pm/items/999', name: 'unrelated' }];
    const encoded = JSON.stringify(cards).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const result = await acquire('booth', 'sample', streamedResponse('<script>/*',
        `*/</script><div data-items="${encoded}"></div><a href="/items/102"><span itemprop="name">次の新作</span><time datetime="2026-10-13T01:00:00Z"></time></a>`));
    assert.deepEqual(result.items.map(item => item.contentId), ['102', '101']);
    assert.equal(result.items[1].title, '新作 😀');
    assert.equal(result.items[1].publishedAtMs, Date.parse('2026-10-13T00:00:00Z'));
    assert.equal(result.items[0].title, '次の新作');
    assert.equal(result.items[0].publishedAtMs, Date.parse('2026-10-13T01:00:00Z'));
});

test('BOOTH streams huge irrelevant card attributes and preserves every card in a large shop', async () => {
    const cards = Array.from({ length: 900 }, (_, index) => ({
        id: 1000 + index, shop_item_url: `https://sample.booth.pm/items/${1000 + index}`,
        name: `作品 ${index} 😀`, published_at: '2026-10-13T00:00:00Z',
    }));
    const encoded = JSON.stringify(cards).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const result = await acquire('booth', 'sample', streamedResponse('<div data-item="{&quot;description&quot;:&quot;',
        `&quot;,&quot;id&quot;:999,&quot;shop_item_url&quot;:&quot;https://sample.booth.pm/items/999&quot;,&quot;name&quot;:&quot;前の作品&amp;夏&quot;}"></div><div data-items="${encoded}"></div>`));
    assert.equal(result.items.length, cards.length + 1);
    assert.equal(result.items[0].contentId, '1899');
    assert.equal(result.items[899].contentId, '1000');
    assert.equal(result.items[900].contentId, '999');
    assert.equal(result.items[900].title, '前の作品&夏');
});

test('BOOTH attribute projection retains credential and protocol rejection semantics', async () => {
    const cards = [
        { id: 1, shop_item_url: 'https://user:secret@sample.booth.pm/items/1', name: 'credentials' },
        { id: 2, shop_item_url: 'http://sample.booth.pm/items/2', name: 'insecure' },
        { id: 3, shop_item_url: 'https://sample.booth.pm/items/3?tracking=1#hash', name: 'valid' },
    ];
    const encoded = JSON.stringify(cards).replaceAll('"', '&quot;');
    const result = await acquire('booth', 'sample', streamedResponse('', `<div data-items="${encoded}"></div>`, { repeats: 0 }));
    assert.deepEqual(result.items.map(item => item.contentId), ['3']);
});

test('streaming JSON keeps rate limit errors, with malformed and incomplete bodies rejected', async () => {
    await assert.rejects(acquire('github', 'octocat', streamedResponse('{"ignored":"', '","message":"API rate limit exceeded"}',
        { status: 403, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0' } })), { code: 'AUTO_WATCH_RATE_LIMITED' });
    await assert.rejects(acquire('pixiv', '123', streamedResponse('{"ignored":"', '","error":true,"body":{"illusts":{},"manga":{}}}')), { code: 'AUTO_WATCH_UPSTREAM_ERROR' });
    await assert.rejects(acquire('pixiv', '123', streamedResponse('{"ignored":"', '","error":false,"body":{"illusts":{}}}')), { code: 'AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE' });
    await assert.rejects(acquire('github', 'octocat', streamedResponse('[{"ignored":"', '","id":"event-1"}')), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
});
