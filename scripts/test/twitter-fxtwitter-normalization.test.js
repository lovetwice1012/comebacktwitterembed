'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { parseTweetApiResponse } = require('../../src/providers/twitter/twitterSourceParser');

const sourceUrl = 'https://x.com/fixture/status/1234567890123456789';
const photos = Array.from({ length: 11 }, (_, index) => ({ type: 'photo', id: String(index + 1), url: `https://pbs.twimg.com/media/photo-${index + 1}.jpg` }));
function fx(overrides = {}) {
    return { code: 200, message: 'OK', tweet: { id: '1234567890123456789', url: sourceUrl, text: 'fixture post',
        author: { name: 'Fixture', screen_name: 'fixture', protected: false }, possibly_sensitive: false,
        created_at: 'Thu Nov 12 18:25:34 +0000 2026', likes: 2, replies: 1, retweets: 3,
        media: { all: photos, photos }, ...overrides } };
}
function unknownText(overrides = {}) {
    const text = 'just setting up my twttr';
    const value = fx({ text, raw_text: { text, display_text_range: [0, text.length], facets: [] }, provider: 'twitter',
        twitter_card: 'tweet', is_note_tweet: false, replying_to: null, replying_to_status: null,
        community_note: null, reposted_by: null, ...overrides });
    delete value.tweet.media;
    delete value.tweet.possibly_sensitive;
    return value;
}
function extractWithFallback(payload, inputUrl = sourceUrl) {
    const path = require.resolve('../../src/providers/twitter'), actualRequire = createRequire(path), mod = { exports: {} }, requests = [];
    const fakeFetch = async value => {
        const url = String(value); requests.push(url);
        if (url.includes('altterx.sprink.cloud')) return { text: async () => '' };
        if (url.includes('api.vxtwitter.com')) return { text: async () => '<html>Cloudflare temporary error</html>' };
        assert.match(url, /^https:\/\/api\.fxtwitter\.com\//);
        return { text: async () => JSON.stringify(payload) };
    };
    const mocks = { '../../providerFetch': { withDeadline: () => fakeFetch },
        '../../adminSupport/providerSources': { resolvePlan: async () => ({ sources: [{ origin: 'https://api.vxtwitter.com' }, { origin: 'https://api.fxtwitter.com' }] }) } };
    compileFunction(readFileSync(path, 'utf8'), ['require', 'module', 'exports', 'console'], { filename: `${path}.fixture.cjs` })(
        id => Object.hasOwn(mocks, id) ? mocks[id] : actualRequire(id), mod, mod.exports, { log() {}, warn() {}, error() {} });
    const message = { guild: { id: 'fixture', members: { me: { permissions: { has: () => false } } } },
        author: { id: '1', username: 'fixture' }, user: { id: '1', username: 'fixture' }, content: inputUrl,
        channel: { send: async () => { throw new Error('Discord I/O forbidden'); } } };
    return { result: mod.exports.extract(message, inputUrl, { legacy_mode: true, defaultLanguage: 'ja' }), requests };
}

test('Fx fallback preserves all 11 ordered photos and emits two valid steps', async () => {
    const { result, requests } = extractWithFallback(fx()), steps = await result;
    assert.deepEqual(steps.map(step => step.files.length), [10, 1]);
    assert.ok(steps.every(step => step.safeTwitterMedia === true));
    assert.deepEqual(steps.flatMap(step => step.files), photos.map(photo => photo.url));
    assert.equal(steps[0].embeds[0].title, 'Fixture');
    assert.match(steps[0].embeds[0].description, /fixture post/);
    assert.ok(requests.some(url => url.startsWith('https://api.fxtwitter.com/')));
});

test('Fx normalizes playable photo/video/GIF order, quote, article and statistics without substituting posters', () => {
    const video = { type: 'video', id: 'v', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/fixture.mp4', thumbnail_url: 'https://pbs.twimg.com/media/poster.jpg' };
    const gif = { type: 'gif', id: 'g', url: 'https://video.twimg.com/tweet_video/fixture.mp4' };
    const quote = 'https://x.com/other/status/555';
    const source = fx({ media: { all: [photos[0], video, photos[1], gif], photos: photos.slice(0, 2), videos: [video, gif] },
        quote: { url: quote }, article: { title: 'fixture article', preview_text: 'preview', cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/media/cover.jpg' } } } });
    const result = parseTweetApiResponse(JSON.stringify(source), sourceUrl);
    assert.deepEqual(result.mediaURLs, [photos[0].url, video.url, photos[1].url, gif.url]);
    assert.equal(result.qrtURL, quote); assert.equal(result.article.image, 'https://pbs.twimg.com/media/cover.jpg');
    assert.equal(result.retweets, 3); assert.equal(result.replies, 1); assert.equal(result.likes, 2);
});

test('Fx fallback fails closed for sensitive, unknown, protected, and NSFW-community posts', () => {
    for (const changes of [{ possibly_sensitive: true }, { possibly_sensitive: undefined },
        { nsfw: true }, { media: { all: [{ ...photos[0], sensitive: true }] } },
        { author: { name: 'Fixture', screen_name: 'fixture', protected: true } },
        { author: { name: 'Fixture', screen_name: 'fixture' } }, { community: { is_nsfw: true } }]) {
        assert.throws(() => parseTweetApiResponse(JSON.stringify(fx(changes)), sourceUrl), { expectedNonExpandable: true });
    }
});

test('Fx legacy text with no sensitivity value is rendered without labeling it non-sensitive', async () => {
    const value = unknownText(), normalized = parseTweetApiResponse(JSON.stringify(value), sourceUrl);
    assert.equal(Object.hasOwn(normalized, 'possibly_sensitive'), false);
    assert.equal(normalized[Symbol.for('cbte.twitter.fx.sensitivity.unknown')], true);
    assert.deepEqual(normalized.mediaURLs, []);
    const steps = await extractWithFallback(value).result;
    assert.equal(steps.length, 1);
    assert.match(steps[0].embeds[0].description, /just setting up my twttr/);
    assert.deepEqual(steps[0].files, []);
    assert.equal(steps[0].twitterGrid, undefined);
    assert.equal(Object.hasOwn(steps[0].analytics.content, 'sensitive'), false);
    assert.equal(steps[0].analytics.facets.some(facet => facet.key === 'sensitive'), false);
});

test('Fx unknown sensitivity never permits media, quote, article, card or ambiguous legacy shapes', () => {
    const base = unknownText(), linkedText = 'https://example.test/image.jpg';
    const variants = [
        { media: null }, { media: { all: [photos[0]] } }, { quote: null },
        { quote: { url: 'https://x.com/other/status/555' } }, { article: { title: 'fixture' } },
        { card: { url: 'https://example.test/' } }, { twitter_card: 'player' }, { twitter_card: undefined },
        { external: { url: 'https://example.test/' } }, { mediaURLs: [photos[0].url] },
        { media_extended: [] }, { extended_entities: {} }, { entities: {} }, { provider: 'other' },
        { is_note_tweet: true }, { reposted_by: { id: 'other' } }, { replying_to_status: { id: '555' } },
        { community: { is_nsfw: false } }, { nsfw: true }, { possibly_sensitive: null },
        { author: { name: 'Fixture', screen_name: 'fixture', protected: true } },
        { author: { name: 'Fixture', screen_name: 'fixture' } },
        { raw_text: { ...base.tweet.raw_text, facets: [{ type: 'media' }] } },
        { raw_text: { ...base.tweet.raw_text, facets: null } },
        { raw_text: { ...base.tweet.raw_text, display_text_range: [1, 24] } },
        { raw_text: { ...base.tweet.raw_text, unknown: true } },
        { text: linkedText, raw_text: { text: linkedText, display_text_range: [0, linkedText.length], facets: [] } },
    ];
    for (const variant of variants) {
        const value = unknownText(); Object.assign(value.tweet, variant);
        assert.throws(() => parseTweetApiResponse(JSON.stringify(value), sourceUrl), { expectedNonExpandable: true }, JSON.stringify(Object.keys(variant)));
    }
});

test('Fx verifies the same status ID for canonical and supported internal X URL forms', () => {
    const id = '1234567890123456789';
    for (const input of [`https://x.com/i/status/${id}`, `https://x.com/i/web/status/${id}`,
        `https://twitter.com/fixture/status/${id}/photo/1`]) {
        assert.equal(parseTweetApiResponse(JSON.stringify(fx()), input).tweetID, id);
    }
    for (const input of [`https://x.com/i/other/status/${id}`, 'https://x.com/i/web/status/999',
        `https://x.com.attacker.test/i/web/status/${id}`, `http://x.com/i/web/status/${id}`,
        `https://attacker@x.com/i/web/status/${id}`]) {
        assert.throws(() => parseTweetApiResponse(JSON.stringify(fx()), input));
    }
});

test('internal /i/web/status links retain their post ID through primary and fallback requests', async () => {
    const id = '1234567890123456789', { result, requests } = extractWithFallback(fx(), `https://x.com/i/web/status/${id}`);
    const steps = await result;
    assert.deepEqual(requests.slice(0, 2), [`https://api.vxtwitter.com/i/status/${id}`, `https://api.fxtwitter.com/i/status/${id}`]);
    assert.deepEqual(steps.flatMap(step => step.files), photos.map(photo => photo.url));
});

test('Fx fallback rejects mismatched post identity and incomplete or unsafe media', () => {
    const variants = [
        fx({ id: '999' }), fx({ url: 'https://example.test/fixture/status/1234567890123456789' }),
        fx({ media: { all: [photos[0]], photos: [photos[1]] } }),
        fx({ media: { photos: [photos[0]], videos: [{ type: 'video', url: 'https://video.twimg.com/x.mp4' }] } }),
        fx({ media: { all: [{ type: 'photo', url: 'http://127.0.0.1/private' }] } }),
        fx({ media: { all: [{ type: 'photo', url: 'https://127.0.0.1/private.jpg' }] } }),
        fx({ media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com.attacker.test/media/photo.jpg' }] } }),
        fx({ media: { all: [{ type: 'video', url: 'https://video.twimg.com.attacker.test/ext_tw_video/1/a.mp4' }] } }),
        fx({ article: { title: 'fixture', image: 'https://127.0.0.1/private.jpg' } }),
        fx({ media: { all: [{ type: 'video', url: 'https://pbs.twimg.com/media/poster.jpg' }] } }),
        fx({ media: { all: [{ type: 'unknown', url: photos[0].url }] } }),
    ];
    for (const value of variants) assert.throws(() => parseTweetApiResponse(JSON.stringify(value), sourceUrl));
    assert.throws(() => parseTweetApiResponse(JSON.stringify(fx()), 'https://x.com/fixture/status/999'));
});

test('Vx responses and expected errors retain their existing parser behavior', () => {
    const vx = { tweetURL: sourceUrl, user_name: 'Fixture', mediaURLs: [photos[0].url], possibly_sensitive: false };
    const parsed = parseTweetApiResponse(JSON.stringify(vx), sourceUrl);
    assert.deepEqual(parsed, vx);
    assert.notEqual(parsed[Symbol.for('cbte.twitter.fx.media')], true);
    assert.throws(() => parseTweetApiResponse(JSON.stringify({ error: 'This tweet is private' })), { expectedNonExpandable: true });
});
