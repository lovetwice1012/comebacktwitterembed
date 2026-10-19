'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const nodeFetch = require('node-fetch');
const { fetchSource, ratePolicy } = require('../../src/providers/autoWatch');
const { requestText } = require('../../src/providers/autoWatch/_shared');
const { readHtmlProjection } = require('../../src/providers/autoWatch/streaming');
const { parseUploadsPlaylist } = require('../../src/providers/youtube/youtubeSourceParser');
const { readFeedProjection } = require('../../src/providers/youtube/autoWatchXml');
const channel = 'UCvhViFXvb5Y83YGEpRX1cvg';
const old = 'VP0n-6NbSf4', newer = 'newVideo123', older = 'oldVideo123';
function page(ids, owner = channel, modern = true) {
    const contents = ids.map(id => modern ? { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: `Title ${id}` } } } } }
        : { playlistVideoRenderer: { videoId: id, title: { runs: [{ text: `Title ${id}` }] } } });
    return `<script>var ytInitialData = ${JSON.stringify({ header: { playlistHeaderRenderer: { ownerText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: owner } } }] } } }, contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents } } } }] } }, irrelevant: { lockupViewModel: { contentId: 'notOurVideo1', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } } })};</script>`;
}
const response = (body, status = 200, headers = {}) => ({ status, ok: status >= 200 && status < 300, body: Readable.from([body]), text: async () => body, headers: { get: key => headers[key] || null } });
const source = (extras = {}) => ({ provider_id: 'youtube', youtube_fetch_releases: 0, source_key: `channel:${channel}`, state_json: '{}', initialized_at_ms: 100, cursor_json: JSON.stringify({ seenContentIds: [old], admissionVersion: 1 }), ...extras });
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

test('queued new uploads behind an already admitted anchor survive partial admission and never become excluded history', async () => {
    const queued = 'queuedV1234';
    const result = await fetchSource(source({ cursor_json: JSON.stringify({ seenContentIds: [newer, old], deferredObservations: [[queued, 1000]] }) }),
        { fetch: fallback(page([newer, queued, old, older])) });
    assert.deepEqual(result.items.map(item => item.contentId), [newer, queued]);
    assert(!result.state.fallbackExcludedIds.includes(queued));
});

async function withServer(html, work) {
    const server = http.createServer((request, response) => {
        response.writeHead(request.url.startsWith('/feeds/') ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(request.url.startsWith('/feeds/') ? 'Not found' : html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await work(`http://127.0.0.1:${server.address().port}`); }
    finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function localStreamingFetch(base, url, options) {
    const result = await nodeFetch(new URL(new URL(url).pathname + new URL(url).search, base), options);
    if (result.ok) result.text = async () => { throw new Error('A streaming acquisition must not buffer response.text().'); };
    return result;
}

test('streaming shared requests and the YouTube fallback discard assets above the former 2 MiB limit', async () => {
    const queued = 'queuedV1234';
    // YouTube includes sizeable page assets alongside ytInitialData. Keep the
    // fixture above the former cap and exercise node-fetch's real body reader.
    const html = `<script>var pageAssets = "${'a'.repeat(2 * 1024 * 1024)}";</script>` + page([newer, queued, old, older]);
    await withServer(html, async base => {
        const localFetch = (url, options) => localStreamingFetch(base, url, options);
        const context = { fetch: localFetch, config: { timeoutMs: 20000 } };
        const projected = await requestText(context, 'https://www.youtube.com/playlist', { readBody: response => readHtmlProjection(response, { markers: ['ytInitialData'], paths: [['header', '**', 'browseId']] }) });
        assert(projected.body.length < 1000);
        assert(projected.body.includes(channel));
        const result = await fetchSource(source({ cursor_json: JSON.stringify({ seenContentIds: [newer, old], deferredObservations: [[queued, 1000]] }) }), { fetch: localFetch });
        assert.deepEqual(result.items.map(item => item.contentId), [newer, queued]);
        assert.deepEqual(result.state.fallbackExcludedIds, [old, older]);
        assert.equal(result.state.fetchMode, 'uploads');
    });
});

test('streaming hydration discards unrelated values above 8 MiB without replaying unanchored history', async () => {
    const html = page([old]).replace('ytInitialData = {', `ytInitialData = {"unusedPageAssets":"${'a'.repeat(8 * 1024 * 1024)}",`);
    await withServer(html, async base => {
        const localFetch = (url, options) => localStreamingFetch(base, url, options);
        const result = await fetchSource(source({ cursor_json: JSON.stringify({ seenContentIds: ['missing1234'] }) }), { fetch: localFetch });
        assert.deepEqual(result.items, []);
        assert.deepEqual(result.state.fallbackExcludedIds, [old]);
        assert.equal(result.state.fetchMode, 'uploads');
    });
});

test('streaming RSS keeps owner and upload metadata across split UTF-8, CDATA and large ignored media text', async () => {
    const xml = `<feed><yt:channelId>${channel}</yt:channelId><entry><yt:videoId>${newer}</yt:videoId><title><![CDATA[新作 😀 <夏> & "公開" </title>]]></title><published>2026-10-13T01:00:00Z</published><media:group><media:description>${'a'.repeat(8 * 1024 * 1024)}</media:description></media:group></entry></feed>`;
    const bytes = Buffer.from(xml);
    const streamed = { body: Readable.from((function* () { for (let offset = 0; offset < bytes.length; offset += 997) yield bytes.subarray(offset, offset + 997); })()), text: async () => { throw new Error('RSS must stream.'); } };
    const projected = await readFeedProjection(streamed);
    assert(projected.length < 1000);
    const items = require('../../src/providers/youtube/autoWatch')._internal.feedItems(projected);
    assert.deepEqual(items.map(item => [item.contentId, item.title, item.publishedAtMs]), [[newer, '新作 😀 <夏> & "公開" </title>', Date.parse('2026-10-13T01:00:00Z')]]);
    assert(projected.includes(channel));
});

test('streaming RSS rejects incomplete documents and cannot seed a partial baseline', async () => {
    for (const xml of ['<feed><entry><yt:videoId>newVideo123</yt:videoId></entry>', '<feed><entry><title>unfinished</entry></feed>', '<html><feed><entry></entry></feed></html>']) {
        await assert.rejects(readFeedProjection(response(xml)), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
    }
    const projected = await readFeedProjection(response('<feed><entry><yt:channelId>UCwrong_channel_identifier1</yt:channelId></entry></feed>'));
    assert.equal(require('../../src/providers/youtube/autoWatch')._internal.xmlValue(projected, 'yt:channelId'), 'UCwrong_channel_identifier1');
});

test('handle streaming resolution uses the verified primary channel metadata', async () => {
    const result = await fetchSource(source({ source_key: 'handle:sample', initialized_at_ms: null }), { fetch: async url => {
        if (String(url).includes('/@')) return response(`<script>ytInitialData = ${JSON.stringify({ other: { channelId: 'UCwrong_channel_identifier1' }, metadata: { channelMetadataRenderer: { externalId: channel } } })};</script>`);
        assert(String(url).includes(`channel_id=${channel}`));
        return response(`<feed><yt:channelId>${channel}</yt:channelId><entry><yt:videoId>${newer}</yt:videoId></entry></feed>`);
    } });
    assert.equal(result.state.channelId, channel);
    assert.deepEqual(result.items.map(item => item.contentId), [newer]);
});
