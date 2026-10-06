'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchSource, ratePolicy } = require('../../src/providers/autoWatch');
const { parseUploadsPlaylist } = require('../../src/providers/youtube/youtubeSourceParser');
const channel = 'UCvhViFXvb5Y83YGEpRX1cvg';
const old = 'VP0n-6NbSf4', newer = 'newVideo123', older = 'oldVideo123';
function page(ids, owner = channel, modern = true) {
    const contents = ids.map(id => modern ? { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: `Title ${id}` } } } } }
        : { playlistVideoRenderer: { videoId: id, title: { runs: [{ text: `Title ${id}` }] } } });
    return `<script>var ytInitialData = ${JSON.stringify({ header: { playlistHeaderRenderer: { ownerText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: owner } } }] } } }, contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents } } } }] } }, irrelevant: { lockupViewModel: { contentId: 'notOurVideo1', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } } })};</script>`;
}
const response = (body, status = 200, headers = {}) => ({ status, ok: status >= 200 && status < 300, text: async () => body, headers: { get: key => headers[key] || null } });
const source = (extras = {}) => ({ provider_id: 'youtube', source_key: `channel:${channel}`, state_json: '{}', initialized_at_ms: 100, cursor_json: JSON.stringify({ seenContentIds: [old], admissionVersion: 1 }), ...extras });
const fallback = html => async url => response(String(url).includes('/feeds/') ? 'Not found' : html, String(url).includes('/feeds/') ? 404 : 200);

test('RSS 404 uses verified uploads containing regular videos, Shorts and streams; older history is excluded', async () => {
    const result = await fetchSource(source({ etag: 'rss-etag' }), { fetch: fallback(page([newer, old, older])) });
    assert.deepEqual(result.items.map(x => x.contentId), [newer, old]);
    assert.equal(result.state.fetchMode, 'uploads'); assert.deepEqual(result.state.fallbackExcludedIds, [older]);
    assert.equal(result.etag, null); assert.equal(result.lastModified, null);
    assert(ratePolicy('youtube').requestCost >= 3);
});

test('first fallback without a known anchor quietly baselines history, then detects a later upload', async () => {
    const first = await fetchSource(source({ cursor_json: JSON.stringify({ seenContentIds: ['missing1234'] }) }), { fetch: fallback(page([old, older])) });
    assert.deepEqual(first.items, []);
    const next = await fetchSource(source({ state_json: JSON.stringify(first.state) }), { fetch: fallback(page([newer, old, older])) });
    assert.deepEqual(next.items.map(x => x.contentId), [newer]);
});

test('fresh registration returns a baseline and RSS recovery cannot replay excluded uploads or reuse HTML validators', async () => {
    const seeded = await fetchSource(source({ initialized_at_ms: null }), { fetch: fallback(page([old, older])) });
    assert.equal(seeded.items.length, 2);
    const result = await fetchSource(source({ state_json: JSON.stringify({ fetchMode: 'uploads', fallbackExcludedIds: [older] }), etag: 'html-etag' }), {
        fetch: async (_url, options) => { assert.equal(options.headers['If-None-Match'], undefined); return response(`<feed><entry><yt:videoId>${older}</yt:videoId></entry><entry><yt:videoId>${newer}</yt:videoId></entry></feed>`); },
    });
    assert.deepEqual(result.items.map(x => x.contentId), [newer]); assert.equal(result.state.fetchMode, 'rss');
});

test('rate limits and forbidden responses preserve backoff and never cause extra crawl requests', async () => {
    for (const status of [429, 403]) {
        let calls = 0;
        await assert.rejects(fetchSource(source(), { fetch: async () => { calls++; return response('error', status, { 'retry-after': '120' }); } }),
            error => error.status === status && (status !== 429 || error.retryAfterMs === 120000));
        assert.equal(calls, 1);
    }
});

test('legacy/modern playlist renderers are supported while wrong channels, consent and malformed responses cannot seed a baseline', async () => {
    for (const modern of [true, false]) assert.deepEqual(parseUploadsPlaylist(page([old], channel, modern), channel).map(x => x.videoId), [old]);
    for (const html of [page([old], 'UCwrong_channel_identifier1'), '<html>consent</html>', '<script>ytInitialData = {bad};</script>']) {
        await assert.rejects(fetchSource(source(), { fetch: fallback(html) }), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
    }
    await assert.rejects(fetchSource(source(), { config: { enableGuestCrawls: false }, fetch: fallback(page([old])) }), { code: 'AUTO_WATCH_GUEST_CRAWL_DISABLED' });
});

test('HTTP 200 HTML masquerading as RSS also uses the uploads fallback', async () => {
    const result = await fetchSource(source(), { fetch: async url => response(String(url).includes('/feeds/') ? '<html>Error</html>' : page([newer, old])) });
    assert.equal(result.state.fetchMode, 'uploads'); assert.equal(result.items[0].contentId, newer);
});
