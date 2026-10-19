'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { fetchSource } = require('../../src/providers/autoWatch');
const { parseTab, PATHS } = require('../../src/providers/youtube/watch-tabs');
const { readHtmlProjection } = require('../../src/providers/autoWatch/streaming');
const { normalizeOptions, acceptsItem } = require('../../src/providers/youtube/watch-options');
const f = require('./helpers/youtube-watch-fixture.cjs');
const source = (extra = {}) => ({ provider_id: 'youtube', source_key: `channel:${f.channel}`, state_json: '{}', initialized_at_ms: 100,
    cursor_json: JSON.stringify({ seenContentIds: [f.oldVideo], admissionVersion: 1 }), ...extra });

test('YouTube options default to releases on/posts off and validate all server input', () => {
    assert.deepEqual(normalizeOptions(undefined), { releases: true, community: false });
    assert.deepEqual(normalizeOptions({ community: true }), { releases: true, community: true });
    assert.deepEqual(normalizeOptions(undefined, { youtube_include_releases: 0, youtube_include_community: 1 }), { releases: false, community: true });
    for (const input of [null, [], true, { community: 'true' }, { releases: 1 }, { other: true }]) assert.throws(() => normalizeOptions(input), { code: 'INVALID_YOUTUBE_OPTIONS' });
});

test('verified releases include Topic-owned tracks from the artist tab; albums link their whole playlist', () => {
    const [item] = parseTab(f.page('releases', [f.release()], { unrelated: f.release('notOurVideo1') }), f.channel, 'releases');
    assert.equal(item.contentId, f.video); assert.equal(item.title, 'Odd Dice');
    assert.equal(item.youtubeContentKind, 'release'); assert.equal(item.url, `https://www.youtube.com/watch?v=${f.video}`);
    const album = f.release(); album.playlistRenderer.videoCount = '3';
    assert.equal(parseTab(f.page('releases', [album]), f.channel, 'releases')[0].url, `https://www.youtube.com/playlist?list=${f.playlist}`);
    const modern = { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', contentId: f.playlist, metadata: { lockupMetadataViewModel: { title: { content: 'Album' } } } } };
    assert.equal(parseTab(f.page('releases', [modern]), f.channel, 'releases')[0].contentId, `release:${f.playlist}`);
});

test('community posts keep Unicode text and canonical post URL while excluding other authors and attached videos', () => {
    const items = parseTab(f.page('community', [f.post(), f.post('UgkxOtherPost123456789', 'UC_other_channel')]), f.channel, 'community');
    assert.equal(items.length, 1); assert.equal(items[0].contentId, `post:${f.postId}`);
    assert.equal(items[0].url, `https://www.youtube.com/post/${f.postId}`); assert.match(items[0].body, /新着のお知らせ 😀\n本文/);
    assert.equal(items[0].publishedAtMs, null, 'Relative times must not invent exact publication dates');
});

test('wrong channels, redirected tabs, consent, malformed JSON and unsafe IDs fail without baselining', () => {
    for (const html of [f.page('releases', [f.release()], { owner: 'UC_wrong_channel' }), '<html>consent</html>', '<script>ytInitialData={bad}</script>',
        f.page('releases', [f.release()]).replace('"selected":true', '"selected":false'), f.page('releases', [f.release(f.video, '../unsafe')])]) {
        assert.throws(() => parseTab(html, f.channel, 'releases'), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
    }
    assert.deepEqual(parseTab(f.page('community'), f.channel, 'community'), []);
    assert.deepEqual(parseTab(f.page('community'), f.channel, 'releases'), [], 'A verified channel without a releases tab is allowed');
});

test('streamed tab projections discard large unrelated/tracking values and preserve actual card fields', async () => {
    const html = f.page('community', [f.post()], { unrelated: 'x'.repeat(9 * 1024 * 1024) });
    const projected = await readHtmlProjection({ body: Readable.from([Buffer.from(html)]), text: () => { throw Error('must stream'); } }, { markers: ['ytInitialData'], paths: PATHS });
    assert(projected.length < 3000); assert.equal(parseTab(projected, f.channel, 'community')[0].contentId, `post:${f.postId}`);
});

test('existing watches quietly baseline new lanes; RSS 304 still detects subsequent releases and opted-in posts', async () => {
    const calls = [];
    const first = await fetchSource(source({ youtube_fetch_community: 1 }), { fetch: f.fetchFixture({ releases: [f.release()], posts: [f.post()], calls }) });
    assert.equal(calls.length, 3); assert.deepEqual(first.baselineItems.map(x => x.contentId), [f.video, `post:${f.postId}`]);
    const second = await fetchSource(source({ state_json: JSON.stringify(first.state), youtube_fetch_community: 1, etag: 'old' }), {
        fetch: f.fetchFixture({ releases: [f.release('newVideo123')], posts: [f.post('UgkxNextPost123456789')], status: 304 }) });
    assert.equal(second.notModified, false); assert.equal(second.baselineItems.length, 0); assert.equal(second.etag, 'old');
    assert.deepEqual(second.items.map(x => x.contentId), ['newVideo123', 'post:UgkxNextPost123456789']);
});

test('default posts off performs no posts request; switching off both optional lanes preserves RSS conditional polling', async () => {
    const calls = [];
    await fetchSource(source(), { fetch: f.fetchFixture({ calls }) });
    assert.equal(calls.length, 2); assert(calls.every(c => !c.url.includes('/posts')));
    const disabled = await fetchSource(source({ youtube_fetch_releases: 0 }), { fetch: f.fetchFixture({ status: 304 }) });
    assert.equal(disabled.notModified, true); assert.equal(disabled.state.youtubeTabs.releases.initialized, false);
});

test('the existing crawl kill switch preserves ordinary RSS monitoring and quietly reseeds optional tabs when restored', async () => {
    const calls = [];
    const paused = await fetchSource(source({ youtube_fetch_community: 1 }), { config: { enableGuestCrawls: false }, fetch: f.fetchFixture({ calls }) });
    assert.equal(calls.length, 1); assert.equal(paused.items[0].contentId, f.oldVideo);
    assert.equal(paused.state.youtubeTabs.releases.initialized, false); assert.equal(paused.state.youtubeTabs.community.initialized, false);
    const restored = await fetchSource(source({ youtube_fetch_community: 1, state_json: JSON.stringify(paused.state) }), { fetch: f.fetchFixture({ releases: [f.release()], posts: [f.post()] }) });
    assert.equal(restored.baselineItems.length, 2);
});

test('RSS/upload and release overlap produces one ordinary video notification and does not baseline that new upload', async () => {
    const result = await fetchSource(source(), { fetch: f.fetchFixture({ videos: [f.video], releases: [f.release()] }) });
    assert.deepEqual(result.items.map(x => x.contentId), [f.video]); assert.deepEqual(result.baselineItems, []);
    assert.equal(result.items[0].youtubeContentKind, undefined);
});

test('rate limits or failed optional tabs abort the atomic observation without hiding pending discoveries', async () => {
    for (const status of [429, 503]) await assert.rejects(fetchSource(source(), { fetch: async url => String(url).includes('/feeds/')
        ? f.response(f.rss([f.video])) : f.response('upstream error', status) }), error => error.status === status);
});

test('per-target selection and opt-in timestamp reject old backlog but never alter ordinary videos', () => {
    const target = { youtube_include_releases: 0, youtube_include_community: 1, youtube_community_since_ms: 200, youtube_community_baseline_at_ms: 201 };
    assert.equal(acceptsItem(target, { youtubeContentKind: 'release' }, 300), false);
    assert.equal(acceptsItem(target, { youtubeContentKind: 'community' }, 199), false);
    assert.equal(acceptsItem(target, { youtubeContentKind: 'community' }, 201), true);
    assert.equal(acceptsItem(target, {}, 1), true);
    assert.equal(acceptsItem({ ...target, youtube_community_baseline_at_ms: null }, { youtubeContentKind: 'community' }, 300), false);
});

test('community text and release video URLs survive the real event normalizer and ordinary notification formatter', () => {
    const { deliveryEvent } = require('../../src/automation/queue');
    const { outputText } = require('../../src/automation/text-transform');
    const display = require('../../src/automation/schema').NODE_TYPES.transform.defaults;
    for (const item of [parseTab(f.page('community', [f.post()]), f.channel, 'community')[0],
        parseTab(f.page('releases', [f.release()]), f.channel, 'releases')[0]]) {
        const event = deliveryEvent('auto', { provider_id: 'youtube', source_key: `channel:${f.channel}`, content_key: item.contentId,
            title: item.title, content_url: item.url, payload_json: JSON.stringify(item), discovered_at_ms: 1000 }, 2000);
        assert.equal(event.kind, 'new'); assert.equal(event.url, item.url); assert.equal(event.title, item.title);
        assert(outputText(display, event).includes(item.url));
        if (item.youtubeContentKind === 'community') assert.equal(event.body, item.body);
    }
});
