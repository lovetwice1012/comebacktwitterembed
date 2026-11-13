'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInstagramHtmlSource, parseInstagramGraphqlSource } = require('../../src/providers/instagram/instagramSourceParser');
const { createInstagramClient } = require('../../src/providers/instagram/client');

const CODE = 'EXAMPLE1';
const POSTER = 'https://cdn.example.test/poster.jpg';
const VIDEO = 'https://cdn.example.test/video.mp4';
const summary = code => ({ __typename: 'XIGPolarisVideoMedia', code, display_uri: POSTER, user: { username: 'fixture' } });
const full = (code, video = VIDEO) => ({ ...summary(code), video_versions: [{ url: video }] });
const script = value => `<script type="application/json">${JSON.stringify(value)}</script>`;
function repeatedPage(code = CODE, video = VIDEO) {
    // Crawler pages can contain an earlier shortcode summary and a later full
    // logged-out XIG object for the same post, at equal nesting depth.
    return script({ shortcode_media: summary(code) }) + script({ data: { xig_polaris_media: {
        __typename: 'XIGPolarisVideoMedia', code, if_not_gated_logged_out: full(code, video),
    } } });
}
const response = (status, text = '') => ({ status, ok: status >= 200 && status < 300, text: async () => text, headers: { get: () => null } });

test('a later full same-post video wins over its earlier poster-only summary', () => {
    const result = parseInstagramHtmlSource(repeatedPage(), CODE);
    assert.equal(result.data.medias.length, 1);
    assert.equal(result.data.medias[0].url, VIDEO);
    assert.equal(result.data.medias[0].verifiedVideoSource, true);
});

test('the selected video fills missing author and caption only from same-shortcode records', () => {
    const earlier = { ...summary(CODE), caption: { text: 'fixture caption' } };
    const selected = { __typename: 'XIGPolarisVideoMedia', code: CODE, display_uri: POSTER, video_versions: [{ url: VIDEO }] };
    const html = script({ shortcode_media: earlier }) + script({ data: { xig_polaris_media: selected } });
    const result = parseInstagramHtmlSource(html, CODE);
    assert.equal(result.data.medias[0].url, VIDEO);
    assert.equal(result.data.username, 'fixture');
    assert.equal(result.data.caption, 'fixture caption');
});

test('other shortcodes and unidentified fragments never fill missing metadata', () => {
    const other = { ...summary('OTHER999'), caption: { text: 'other caption' }, user: { username: 'other' } };
    const anonymous = { ...summary(''), caption: { text: 'anonymous caption' }, user: { username: 'anonymous' } };
    const selected = { __typename: 'XIGPolarisVideoMedia', code: CODE, display_uri: POSTER, video_versions: [{ url: VIDEO }] };
    const html = script({ shortcode_media: other }) + script({ shortcode_media: anonymous }) + script({ data: { xig_polaris_media: selected } });
    const result = parseInstagramHtmlSource(html, CODE);
    assert.equal(result.data.medias[0].url, VIDEO);
    assert.equal(result.data.username, '');
    assert.equal(result.data.caption, '');
});

test('conflicting same-post metadata is not guessed, and selected values are never overwritten', () => {
    const earlier = { ...summary(CODE), caption: { text: 'first caption' } };
    const conflicting = { ...summary(CODE), caption: { text: 'second caption' }, user: { username: 'another' } };
    const selected = { __typename: 'XIGPolarisVideoMedia', code: CODE, display_uri: POSTER, video_versions: [{ url: VIDEO }] };
    const html = script({ shortcode_media: earlier }) + script({ shortcode_media: conflicting }) + script({ data: { xig_polaris_media: selected } });
    const result = parseInstagramHtmlSource(html, CODE);
    assert.equal(result.data.medias[0].url, VIDEO);
    assert.equal(result.data.username, '');
    assert.equal(result.data.caption, '');
    selected.caption = { text: 'chosen caption' };
    selected.user = { username: 'chosen' };
    const withSelected = script({ shortcode_media: earlier }) + script({ data: { xig_polaris_media: selected } });
    const chosen = parseInstagramHtmlSource(withSelected, CODE);
    assert.equal(chosen.data.username, 'chosen');
    assert.equal(chosen.data.caption, 'chosen caption');
});

test('GraphQL applies the same shortcode fence when filling missing author and caption', () => {
    const selected = { __typename: 'XIGPolarisVideoMedia', code: CODE, display_uri: POSTER, video_versions: [{ url: VIDEO }] };
    const earlier = { ...summary(CODE), caption: { text: 'fixture caption' } };
    const source = JSON.stringify({ data: { shortcode_media: earlier, xig_polaris_media: selected } });
    const result = parseInstagramGraphqlSource(source, CODE);
    assert.equal(result.data.medias[0].url, VIDEO);
    assert.equal(result.data.username, 'fixture');
    assert.equal(result.data.caption, 'fixture caption');

    const other = { ...summary('OTHER999'), caption: { text: 'other caption' }, user: { username: 'other' } };
    const anonymous = { ...summary(''), caption: { text: 'anonymous caption' }, user: { username: 'anonymous' } };
    const unrelated = JSON.stringify({ data: { other, anonymous, xig_polaris_media: selected } });
    const fenced = parseInstagramGraphqlSource(unrelated, CODE);
    assert.equal(fenced.data.username, '');
    assert.equal(fenced.data.caption, '');

    // A caller that cannot establish the requested shortcode must never merge
    // independently identified metadata records.
    const noIdentity = parseInstagramGraphqlSource(source);
    assert.equal(noIdentity.data.username, '');
    assert.equal(noIdentity.data.caption, '');
});

test('GraphQL leaves conflicting metadata unresolved and keeps values on the chosen record', () => {
    const earlier = { ...summary(CODE), caption: { text: 'first caption' } };
    const conflicting = { ...summary(CODE), caption: { text: 'second caption' }, user: { username: 'another' } };
    const selected = { __typename: 'XIGPolarisVideoMedia', code: CODE, display_uri: POSTER, video_versions: [{ url: VIDEO }] };
    const ambiguous = JSON.stringify({ data: { shortcode_media: earlier, conflicting, xig_polaris_media: selected } });
    const result = parseInstagramGraphqlSource(ambiguous, CODE);
    assert.equal(result.data.medias[0].url, VIDEO);
    assert.equal(result.data.username, '');
    assert.equal(result.data.caption, '');

    selected.user = { username: 'chosen' };
    selected.caption = { text: 'chosen caption' };
    const chosen = parseInstagramGraphqlSource(JSON.stringify({ data: { shortcode_media: earlier, xig_polaris_media: selected } }), CODE);
    assert.equal(chosen.data.username, 'chosen');
    assert.equal(chosen.data.caption, 'chosen caption');
});

test('the client obtains the playable Reel from its first crawler response', async () => {
    const calls = [];
    const client = createInstagramClient(async url => { calls.push(url); return response(200, repeatedPage()); });
    const result = await client.fetchInstagramData({ kind: 'media', route: 'reel', shortcode: CODE });
    assert.equal(result.medias[0].url, VIDEO);
    assert.equal(result.medias[0].verifiedVideoSource, true);
    assert.equal(calls.length, 1);
});

test('a DASH-only video outranks a same-post poster and ignores an audio stream', () => {
    const manifest = '<MPD><AdaptationSet mimeType="audio/mp4"><BaseURL>https://cdn.example.test/audio.mp4</BaseURL></AdaptationSet>'
        + '<AdaptationSet mimeType="video/mp4"><BaseURL>https://cdn.example.test/dash.mp4</BaseURL></AdaptationSet></MPD>';
    const record = { ...summary(CODE), video_dash_manifest: manifest };
    const html = script({ shortcode_media: summary(CODE) }) + script({ data: { xig_polaris_media: record } });
    const result = parseInstagramHtmlSource(html, CODE);
    assert.equal(result.data.medias[0].url, 'https://cdn.example.test/dash.mp4');
    assert.equal(result.data.medias[0].verifiedVideoSource, true);
});

test('a video from another shortcode cannot replace the requested poster', () => {
    const html = script({ shortcode_media: summary(CODE) }) + script({ data: { xig_polaris_media: full('OTHER999') } });
    const result = parseInstagramHtmlSource(html, CODE);
    assert.equal(result.data.medias[0].url, POSTER);
    assert.equal(result.data.medias[0].verifiedVideoSource, undefined);
    assert.equal(result.data.incompleteMedia, true);
});

test('an untrusted non-video candidate is not treated as a verified stream', () => {
    for (const invalid of ['http://cdn.example.test/video.mp4', 'https://cdn.example.test/poster.jpg', 'https://user:pass@cdn.example.test/video.mp4']) {
        const result = parseInstagramHtmlSource(repeatedPage(CODE, invalid), CODE);
        assert.equal(result.data.medias[0].verifiedVideoSource, undefined);
        assert.equal(result.data.incompleteMedia, true);
    }
});

test('a DASH BaseURL containing credentials is not accepted as a video stream', () => {
    const manifest = '<MPD><AdaptationSet mimeType="video/mp4"><BaseURL>https://user:pass@cdn.example.test/video.mp4</BaseURL></AdaptationSet></MPD>';
    const html = script({ shortcode_media: summary(CODE) })
        + script({ data: { xig_polaris_media: { ...summary(CODE), video_dash_manifest: manifest } } });
    const result = parseInstagramHtmlSource(html, CODE);
    assert.equal(result.data.medias[0].verifiedVideoSource, undefined);
    assert.equal(result.data.incompleteMedia, true);
});

test('carousel order and video entries survive alongside a competing single-video record', () => {
    const photo = { __typename: 'XIGPolarisImageMedia', display_uri: 'https://cdn.example.test/photo.jpg' };
    const carousel = { __typename: 'XIGPolarisCarouselMedia', code: CODE, carousel_media: [photo, full('CHILD123')], user: { username: 'fixture' } };
    const html = script({ shortcode_media: carousel }) + script({ data: { xig_polaris_media: full(CODE) } });
    const result = parseInstagramHtmlSource(html, CODE);
    assert.equal(result.data.medias.length, 2);
    assert.equal(result.data.medias[0].url, photo.display_uri);
    assert.equal(result.data.medias[1].url, VIDEO);
    assert.equal(result.data.medias[1].verifiedVideoSource, true);
});

test('unauthorized upstream responses do not create a poster or a video result', async () => {
    for (const status of [401, 403]) {
        const client = createInstagramClient(async () => response(status));
        await assert.rejects(client.fetchInstagramData({ kind: 'media', route: 'reel', shortcode: CODE }), { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' });
    }
});
