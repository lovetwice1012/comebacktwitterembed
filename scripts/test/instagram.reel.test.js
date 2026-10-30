'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInstagramClient } = require('../../src/providers/instagram/client');
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

test('unavailable video is cached briefly without a request storm, then is retried successfully', async t => {
    let now = 1_800_000_000_000, requests = 0, videoAvailable = false;
    t.mock.method(Date, 'now', () => now);
    const client = createInstagramClient(async url => {
        requests++;
        if (String(url).includes('/graphql/') || String(url).includes('/oembed/')) return response('Forbidden', 403);
        return response(videoAvailable && String(url).includes('/embed/') ? reelVideoHtml() : reelPoster());
    });
    await assert.rejects(client.fetchInstagramData(media('reel')), { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' });
    const attempted = requests;
    assert(attempted > 2);
    await assert.rejects(client.fetchInstagramData(media('reel')), { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' });
    assert.equal(requests, attempted);
    videoAvailable = true;
    now += 60 * 1000;
    assert.equal((await client.fetchInstagramData(media('reel'))).medias[0].typeName, 'GraphVideo');
    assert.equal(requests, attempted + 2);
});

test('a wrong-shortcode GraphQL video cannot replace the requested Reel', async () => {
    const client = createInstagramClient(async url => {
        if (String(url).includes('/graphql/')) return response(JSON.stringify({ data: { xdt_shortcode_media: reelVideoNode('OTHER') } }));
        if (String(url).includes('/oembed/')) return response('Forbidden', 403);
        return response(reelPoster());
    });
    await assert.rejects(client.fetchInstagramData(media('reel')), { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' });
});

test('concurrent requests for one Reel share the same acquisition', async () => {
    let requests = 0;
    const client = createInstagramClient(async url => {
        requests++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return response(String(url).includes('/embed/') ? reelVideoHtml() : reelPoster());
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => client.fetchInstagramData(media('reel'))));
    assert.equal(requests, 2); assert(results.every(result => result.medias[0].typeName === 'GraphVideo'));
});

test('media rate limits stop fallback requests and honor retry-after across different shortcodes', async t => {
    let now = 1_800_000_000_000, requests = 0, available = false;
    t.mock.method(Date, 'now', () => now);
    const client = createInstagramClient(async () => {
        requests++;
        if (!available) return { ...response('limited', 429), headers: { get: () => '120' } };
        return response(reelVideoHtml());
    });
    await assert.rejects(client.fetchInstagramData(media('reel')), { status: 429, code: 'INSTAGRAM_RATE_LIMITED' });
    await assert.rejects(client.fetchInstagramData({ ...media('reel'), shortcode: 'OTHER' }), { status: 429 });
    assert.equal(requests, 1);
    now += 120000; available = true;
    assert.equal((await client.fetchInstagramData(media('reel'))).medias[0].typeName, 'GraphVideo');
    assert.equal(requests, 2);
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

test('a partial carousel is replaced only by a complete carousel in the original order', async () => {
    const partial = { __typename: 'GraphSidecar', shortcode: code, edge_sidecar_to_children: { edges: [
        { node: { __typename: 'GraphImage', display_url: 'https://example.com/one.jpg' } },
        { node: { __typename: 'GraphVideo', display_url: 'https://example.com/poster.jpg' } },
        { node: { __typename: 'GraphImage' } },
    ] } };
    const full = structuredClone(partial);
    full.edge_sidecar_to_children.edges[1].node.video_url = 'https://example.com/two.mp4';
    full.edge_sidecar_to_children.edges[2].node.display_url = 'https://example.com/three.jpg';
    const client = createInstagramClient(async url => response(`<script>${JSON.stringify(String(url).includes('/embed/') ? full : partial)}</script>`));
    const data = await client.fetchInstagramData(media('p'));
    assert.deepEqual(data.medias.map(item => item.url), ['https://example.com/one.jpg', 'https://example.com/two.mp4', 'https://example.com/three.jpg']);
});

test('GraphQL evidence of an unavailable video prevents returning an earlier image preview', async () => {
    const unavailable = { __typename: 'GraphVideo', shortcode: code, is_video: true };
    const client = createInstagramClient(async url => {
        if (String(url).includes('/graphql/')) return response(JSON.stringify({ data: { xdt_shortcode_media: unavailable } }));
        if (String(url).includes('/oembed/')) return response('Forbidden', 403);
        return response(reelPoster());
    });
    await assert.rejects(client.fetchInstagramData(media('p')), { code: 'INSTAGRAM_MEDIA_UNAVAILABLE' });
});
