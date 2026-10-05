'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInstagramClient } = require('../../src/providers/instagram/client');
const { CACHE_TTL_MS } = require('../../src/providers/instagram/constants');
const { reelPoster, reelVideoNode, reelVideoHtml } = require('./helpers/instagram-reel-fixture.cjs');
const code = 'Ddmd-UrRH2B';
const media = route => ({ kind: 'media', shortcode: code, route, mediaIndex: null });
const response = (body, status = 200) => ({ ok: status === 200, status, text: async () => body });

test('Reel fetch continues past an OG poster to the embed MP4 and caches the video', async () => {
    const requests = [];
    const client = createInstagramClient(async url => {
        requests.push(String(url));
        if (String(url).includes('/embed/')) return response(reelVideoHtml());
        assert.equal(String(url), `https://www.instagram.com/reel/${code}/`);
        return response(reelPoster());
    });
    const data = await client.fetchInstagramData(media('reel'));
    assert.equal(data.medias[0].typeName, 'GraphVideo');
    assert.equal(data.medias[0].url, `https://example.com/${code}.mp4?sig=fixture`);
    assert.deepEqual(requests, [`https://www.instagram.com/reel/${code}/`, `https://www.instagram.com/reel/${code}/embed/captioned/`]);
    assert.strictEqual(await client.fetchInstagramData(media('reel')), data);
    assert.equal(requests.length, 2);
});

test('a cached structured photo cannot prevent a Reel video lookup for the same shortcode', async () => {
    let requests = 0;
    const client = createInstagramClient(async url => {
        requests++;
        if (requests === 1) return response(`<script>${JSON.stringify({ __typename: 'GraphImage', shortcode: code, display_url: `https://example.com/${code}.jpg` })}</script>`);
        return response(String(url).includes('/embed/') ? reelVideoHtml() : reelPoster());
    });
    const poster = await client.fetchInstagramData(media('p'));
    assert.equal(poster.medias[0].typeName, 'GraphImage');
    assert.equal(requests, 1);
    const video = await client.fetchInstagramData(media('reel'));
    assert.equal(video.medias[0].typeName, 'GraphVideo');
    assert.equal(requests, 3);
    assert.strictEqual(await client.fetchInstagramData(media('p')), video);
    assert.equal(client.getCacheStats().size, 1);
});

test('GraphQL video is tried before an oEmbed thumbnail when all Reel HTML sources are posters', async () => {
    const requests = [];
    const client = createInstagramClient(async url => {
        requests.push(String(url));
        assert(!String(url).includes('/oembed/'), 'oEmbed cannot preempt an available GraphQL video');
        return response(String(url).includes('/graphql/') ? JSON.stringify({ data: { xdt_shortcode_media: reelVideoNode() } }) : reelPoster());
    });
    assert.equal((await client.fetchInstagramData(media('reel'))).medias[0].typeName, 'GraphVideo');
    assert.equal(requests.at(-1), 'https://www.instagram.com/graphql/query/');
});

test('a video-typed JPEG is only a preview and cannot preempt a real MP4', async () => {
    const node = reelVideoNode(); delete node.video_url;
    const client = createInstagramClient(async url => response(String(url).includes('/embed/') ? reelVideoHtml() : `<script>${JSON.stringify(node)}</script>`));
    assert.equal((await client.fetchInstagramData(media('reel'))).medias[0].url, `https://example.com/${code}.mp4?sig=fixture`);
});

test('checked image fallback survives blocked video sources without repeat request storms, then retries after TTL', async t => {
    let now = 1_800_000_000_000, requests = 0, videoAvailable = false;
    t.mock.method(Date, 'now', () => now);
    const client = createInstagramClient(async url => {
        requests++;
        if (String(url).includes('/graphql/') || String(url).includes('/oembed/')) return response('Forbidden', 403);
        return response(videoAvailable && String(url).includes('/embed/') ? reelVideoHtml() : reelPoster());
    });
    const fallback = await client.fetchInstagramData(media('reel'));
    assert.equal(fallback.medias[0].typeName, 'GraphImage');
    const attempted = requests;
    assert(attempted > 2);
    assert.strictEqual(await client.fetchInstagramData(media('reel')), fallback);
    assert.equal(requests, attempted);
    videoAvailable = true;
    now += CACHE_TTL_MS;
    assert.equal((await client.fetchInstagramData(media('reel'))).medias[0].typeName, 'GraphVideo');
    assert.equal(requests, attempted + 2);
});

test('a wrong-shortcode GraphQL video cannot replace the requested Reel poster', async () => {
    const client = createInstagramClient(async url => {
        if (String(url).includes('/graphql/')) return response(JSON.stringify({ data: { xdt_shortcode_media: reelVideoNode('OTHER') } }));
        if (String(url).includes('/oembed/')) return response('Forbidden', 403);
        return response(reelPoster());
    });
    assert.equal((await client.fetchInstagramData(media('reel'))).medias[0].url, `https://example.com/${code}.jpg`);
});

test('both normal-post and TV routes continue past posters to actual video', async () => {
    for (const route of ['p', 'tv']) {
        let requests = 0;
        const client = createInstagramClient(async url => { requests++; return response(String(url).includes('/embed/') ? reelVideoHtml() : reelPoster()); });
        const data = await client.fetchInstagramData(media(route));
        assert.equal(data.medias[0].typeName, 'GraphVideo');
        assert.equal(requests, 2);
    }
});
