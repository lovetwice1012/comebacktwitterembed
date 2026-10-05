'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { effectivePollIntervalMs, fetchSource, normalizeSource, ratePolicy } = require('../../src/providers/autoWatch');

function response(status, body, headers = {}) {
    const values = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: key => values[String(key).toLowerCase()] || null },
        text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    };
}

test('guest source normalization accepts only account-shaped inputs', () => {
    assert.deepEqual(normalizeSource('youtube', 'UC_x5XG1OV2P6uZZ5FSM9Ttw'), {
        sourceKey: 'channel:UC_x5XG1OV2P6uZZ5FSM9Ttw',
        sourceUrl: 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    });
    assert.equal(normalizeSource('github', 'https://github.com/octocat').sourceKey, 'octocat');
    assert.equal(normalizeSource('twitch', 'https://www.twitch.tv/twitch').sourceKey, 'twitch');
    assert.equal(normalizeSource('spotify', 'https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg').sourceKey, '0TnOYISbd1XYRBk9myaseg');
    assert.equal(normalizeSource('pixiv', 'https://www.pixiv.net/users/123').sourceKey, '123');
    assert.equal(normalizeSource('booth', 'example.booth.pm').sourceKey, 'example');
    assert.throws(() => normalizeSource('github', 'https://github.com/octocat/Hello-World'));
});

test('YouTube watcher consumes the public Atom feed without an API key', async () => {
    const calls = [];
    const result = await fetchSource({
        provider_id: 'youtube',
        source_key: 'channel:UC_x5XG1OV2P6uZZ5FSM9Ttw',
        state_json: '{}',
        etag: 'old-etag',
    }, {
        fetch: async (url, options) => {
            calls.push({ url, options });
            return response(200, `<?xml version="1.0"?><feed><entry><yt:videoId>abc_DEF-123</yt:videoId><title>New &amp; public</title><published>2026-09-16T00:00:00+00:00</published></entry></feed>`, { etag: 'new-etag' });
        },
        config: {},
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /feeds\/videos\.xml\?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw/);
    assert.equal(calls[0].options.headers['If-None-Match'], 'old-etag');
    assert.deepEqual(result.items.map(item => ({ id: item.contentId, url: item.url, title: item.title })), [{
        id: 'abc_DEF-123', url: 'https://www.youtube.com/watch?v=abc_DEF-123', title: 'New & public',
    }]);
});

test('GitHub watcher remains anonymous and maps a public push event to a commit URL', async () => {
    let received;
    const result = await fetchSource({ provider_id: 'github', source_key: 'octocat', state_json: '{}' }, {
        fetch: async (_url, options) => {
            received = options;
            return response(200, [{
                id: 'event-1', type: 'PushEvent', created_at: '2026-09-16T00:00:00Z',
                repo: { name: 'octocat/Hello-World' }, payload: { head: 'abcdef0123456789' },
            }], { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1780000000' });
        },
        config: {},
    });
    assert.equal(received.headers.Authorization, undefined);
    assert.equal(result.items[0].url, 'https://github.com/octocat/Hello-World/commit/abcdef0123456789');
    assert.equal(result.rateLimit.limit, 60);
});

test('Twitch and Spotify watchers use guest web routes without OAuth headers', async () => {
    const calls = [];
    const twitch = await fetchSource({ provider_id: 'twitch', source_key: 'twitch', state_json: '{}' }, {
        fetch: async (url, options) => {
            calls.push({ url, options });
            return response(200, { data: { user: { id: '1', login: 'twitch', stream: { id: 'stream-1', title: 'Live now', createdAt: '2026-09-16T00:00:00Z' } } } });
        },
        config: {},
    });
    assert.equal(twitch.items[0].url, 'https://www.twitch.tv/twitch');
    assert.equal(calls[0].options.headers.Authorization, undefined);

    const spotify = await fetchSource({ provider_id: 'spotify', source_key: '0TnOYISbd1XYRBk9myaseg', state_json: '{}' }, {
        fetch: async (_url, options) => response(200, '<h2>Albums</h2><a href="/album/2up3OPMp9Tb4dAKM2erWXQ">release</a>'),
        config: {},
    });
    assert.equal(spotify.items[0].url, 'https://open.spotify.com/album/2up3OPMp9Tb4dAKM2erWXQ');
});

test('rate policy leaves material headroom in the anonymous GitHub bucket', () => {
    const policy = ratePolicy('github', {});
    assert.equal(policy.hourlyRequestBudget, 30);
    assert.equal(policy.globalSpacingMs, 120000);
    assert.equal(effectivePollIntervalMs('github', 175, 0, {}), 6 * 60 * 60 * 1000);
    assert.equal(effectivePollIntervalMs('youtube', 175, 0, {}), 30 * 60 * 1000);
});

test('BOOTH guest hydration discovers owner-qualified cards and excludes unrelated recommendations', async () => {
    const json = JSON.stringify([{ shop_item_url: 'https://sample.booth.pm/items/123' }, { shop_item_url: 'https://other.booth.pm/items/456' }]).replaceAll('"', '&quot;');
    const html = `<div data-items="${json}"></div><a href="https://other.booth.pm/items/789">recommendation</a><a href="/items/234">owned</a><a href="/items/555/wish_list">not an item page</a>`;
    const result = await fetchSource({ provider_id: 'booth', source_key: 'sample', state_json: '{}' }, { config: {}, fetch: async () => response(200, html) });
    assert.deepEqual(result.items.map(item => item.contentId), ['234', '123']);
    assert(result.items.every(item => item.url.startsWith('https://sample.booth.pm/items/')));
});

test('guest acquisition does not seed an empty baseline from malformed or incomplete successful responses', async () => {
    for (const [provider_id, source_key, body] of [['github', 'octocat', {}], ['pixiv', '11', { error: false }], ['twitch', 'twitch', { data: { user: { id: '1' } } }], ['spotify', '0TnOYISbd1XYRBk9myaseg', '<html>guest page unavailable</html>']]) {
        await assert.rejects(fetchSource({ provider_id, source_key, state_json: '{}' }, { config: {}, fetch: async () => response(200, body) }), { code: 'AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE' });
    }
});

test('Spotify release discovery excludes popular recommendations and featuring sections', async () => {
    const a = 'A'.repeat(22), b = 'B'.repeat(22), c = 'C'.repeat(22), d = 'D'.repeat(22);
    const html = `<h2>Popular releases</h2><a href="/album/${a}">popular</a><h2>Albums</h2><a href="/album/${b}">album</a><h2>Singles and EPs</h2><a href="/album/${c}">single</a><h2>Featuring artist</h2><a href="/album/${d}">unrelated</a>`;
    const result = await fetchSource({ provider_id: 'spotify', source_key: '0TnOYISbd1XYRBk9myaseg', state_json: '{}' }, { config: {}, fetch: async () => response(200, html) });
    assert.deepEqual(result.items.map(item => item.contentId), [b, c]);
});

test('BOOTH guest cards preserve owned title and explicit publication time without inventing missing metadata', async () => {
    const cards = [
        { id: 123, shop_item_url: 'https://sample.booth.pm/items/123', name: '新作 <限定> & "夏"', published_at: '2026-09-22T08:00:00+09:00' },
        { id: 124, shop_item_url: 'https://sample.booth.pm/items/124', name: '年だけ2026', published_at: '2026', sale_starts_at: '2026-09-22T08:00:00Z' },
        { id: 125, shop_item_url: 'https://sample.booth.pm/items/125', name: '日時不明', published_at: '2026-02-30T00:00:00Z' },
        { id: 126, shop_item_url: 'https://other.booth.pm/items/126', name: '他ショップ' },
    ];
    const html = cards.map(card => `<div data-item="${JSON.stringify(card).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></div>`).join('')
        + '<a href="/items/127">名前 &#x1f600; &amp; 字</a><a href="/items/128"><img src="/image.png"></a>';
    let requests = 0;
    const result = await fetchSource({ provider_id: 'booth', source_key: 'sample', state_json: '{}' }, { config: {}, fetch: async (_url, init) => {
        requests++; assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined);
        return response(200, html);
    } });
    const byId = new Map(result.items.map(item => [item.contentId, item]));
    assert.equal(requests, 1); assert.equal(byId.has('126'), false);
    assert.equal(byId.get('123').title, '新作 <限定> & "夏"');
    assert.equal(byId.get('123').publishedAtMs, Date.parse('2026-09-22T08:00:00+09:00'));
    for (const id of ['124', '125', '127', '128']) assert.equal(byId.get(id).publishedAtMs, null);
    assert.equal(byId.get('127').title, '名前 😀 & 字'); assert.equal(byId.get('128').title, null);
    assert(result.items.every(item => item.body === undefined && item.tags === undefined));
});

test('Spotify metadata stays within release cards, excludes year subtitles and accepts only explicit album timestamps', async () => {
    const a = 'A'.repeat(22), b = 'B'.repeat(22), c = 'C'.repeat(22), d = 'D'.repeat(22), e = 'E'.repeat(22);
    const card = (id, title, extra = '') => `<a href="/album/${id}"><img alt=""/><span class="encore-text-body-small-bold">${title}</span><div>Album • 2026</div>${extra}</a>`;
    const html = `<h2>Popular releases</h2>${card(a, 'unrelated')}<h2>Albums</h2>${card(b, '新作 &#x27; &amp; 夏')}${card(c, '日付だけ')}${card(e, '正確な日時', '<time datetime="2026-09-22T01:00:00Z"></time>')}`
        + `<h2>Featuring artist</h2>${card(d, 'other')}`
        + `<script type="application/ld+json">${JSON.stringify([
            { '@type': 'MusicGroup', name: 'artist', datePublished: '2000-01-01T00:00:00Z' },
            { '@type': 'MusicAlbum', url: `https://open.spotify.com/album/${b}`, name: 'fallback', datePublished: '2026-09-21T12:00:00Z' },
            { '@type': 'MusicAlbum', url: `https://open.spotify.com/album/${c}`, datePublished: '2026-09-21' },
            { '@type': 'MusicAlbum', url: `https://open.spotify.com/album/${d}`, datePublished: '2026-09-20T00:00:00Z' },
        ])}</script>`;
    let requests = 0;
    const result = await fetchSource({ provider_id: 'spotify', source_key: '0TnOYISbd1XYRBk9myaseg', state_json: '{}' }, { config: {}, fetch: async (_url, init) => {
        requests++; assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined);
        return response(200, html);
    } });
    assert.equal(requests, 1); assert.deepEqual(result.items.map(item => item.contentId), [b, c, e]);
    assert.equal(result.items[0].title, "新作 ' & 夏");
    assert.equal(result.items[0].publishedAtMs, Date.parse('2026-09-21T12:00:00Z'));
    assert.equal(result.items[1].publishedAtMs, null);
    assert.equal(result.items[2].publishedAtMs, Date.parse('2026-09-22T01:00:00Z'));
    assert(result.items.every(item => item.body === undefined && item.tags === undefined));
});
