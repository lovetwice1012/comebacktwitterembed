'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInstagramClient } = require('../../src/providers/instagram/client');
const { parseInstagramHtmlSource } = require('../../src/providers/instagram/instagramSourceParser');
const code = 'DeAdSjuBvPY';
const parsed = { kind: 'media', shortcode: code, route: 'p' };
const poster = `<meta property="og:url" content="https://www.instagram.com/p/${code}/"><meta property="og:image" content="https://example.test/photo.jpg?stp=c321.0.965.964a_s640x640">`;
const full = '<img class="EmbeddedMediaImage" src="https://example.test/photo.jpg?stp=dst-jpg">';
const response = (body, status = 200) => ({ ok: status === 200, status, text: async () => body });

test('reported photo selects the uncropped embed image ahead of the canonical 640px OG thumbnail and caches it', async () => {
    const requests = [];
    const client = createInstagramClient(async url => { requests.push(String(url)); return response(String(url).includes('/embed/') ? full : poster); });
    const data = await client.fetchInstagramData(parsed);
    assert.equal(data.medias[0].url, 'https://example.test/photo.jpg?stp=dst-jpg');
    assert.equal(requests.length, 2);
    assert.strictEqual(await client.fetchInstagramData(parsed), data);
    assert.equal(requests.length, 2);
    assert.equal(parseInstagramHtmlSource(poster, code).previewOnly, true);
    assert.equal(parseInstagramHtmlSource(full, code).previewOnly, false);
});

test('GraphQL carousel wins over OG and oEmbed thumbnails for a normal post', async () => {
    const requests = [];
    const node = { shortcode: code, __typename: 'GraphSidecar', edge_sidecar_to_children: { edges: [
        { node: { __typename: 'GraphImage', display_url: 'https://example.test/first.jpg' } },
        { node: { __typename: 'GraphImage', display_url: 'https://example.test/second.jpg' } },
    ] } };
    const client = createInstagramClient(async url => {
        requests.push(String(url));
        assert(!String(url).includes('/oembed/'));
        return response(String(url).includes('/graphql/') ? JSON.stringify({ data: { xdt_shortcode_media: node } }) : poster);
    });
    assert.deepEqual((await client.fetchInstagramData(parsed)).medias.map(m => m.url), ['https://example.test/first.jpg', 'https://example.test/second.jpg']);
    assert.equal(requests.at(-1), 'https://www.instagram.com/graphql/query/');
});

test('a resized structured image also yields to the full embed image', async () => {
    const node = { shortcode: code, __typename: 'XIGPolarisImageMedia', display_url: 'https://example.test/photo.jpg?stp=dst-jpg_e35_s640x640_tt6' };
    let calls = 0;
    const client = createInstagramClient(async url => { calls++; return response(String(url).includes('/embed/') ? full : `<script>${JSON.stringify(node)}</script>`); });
    assert.equal((await client.fetchInstagramData(parsed)).medias[0].url, 'https://example.test/photo.jpg?stp=dst-jpg');
    assert.equal(calls, 2);
});

test('image_versions and display_resources select the largest available image rather than the first thumbnail', () => {
    for (const candidates of [
        { image_versions2: { candidates: [{ width: 320, height: 400, url: 'https://example.test/small.jpg' }, { width: 1608, height: 2144, url: 'https://example.test/full.jpg' }] } },
        { display_resources: [{ config_width: 320, config_height: 400, src: 'https://example.test/small.jpg' }, { config_width: 1608, config_height: 2144, src: 'https://example.test/full.jpg' }] },
    ]) {
        const node = { shortcode: code, __typename: 'GraphImage', thumbnail_src: 'https://example.test/thumb.jpg', ...candidates };
        assert.equal(parseInstagramHtmlSource(`<script>${JSON.stringify(node)}</script>`, code).data.medias[0].url, 'https://example.test/full.jpg');
    }
});

test('unavailable full media preserves and caches the image fallback without repeated lookup storms', async () => {
    let requests = 0;
    const client = createInstagramClient(async url => {
        requests++;
        return response(String(url).includes('/graphql/') || String(url).includes('/oembed/') ? 'Forbidden' : poster,
            String(url).includes('/graphql/') || String(url).includes('/oembed/') ? 403 : 200);
    });
    const data = await client.fetchInstagramData(parsed), attempted = requests;
    assert.match(data.medias[0].url, /s640x640/);
    assert(attempted > 2);
    assert.strictEqual(await client.fetchInstagramData(parsed), data);
    assert.equal(requests, attempted);
});

test('a complete structured carousel is never reduced to a single embed image to improve resolution', async () => {
    let calls = 0;
    const node = { shortcode: code, __typename: 'GraphSidecar', edge_sidecar_to_children: { edges: [
        { node: { __typename: 'GraphImage', display_url: 'https://example.test/first.jpg?stp=s1080x1080' } },
        { node: { __typename: 'GraphImage', display_url: 'https://example.test/second.jpg?stp=s1080x1080' } },
    ] } };
    const client = createInstagramClient(async () => { calls++; return response(`<script>${JSON.stringify(node)}</script>`); });
    assert.equal((await client.fetchInstagramData(parsed)).medias.length, 2);
    assert.equal(calls, 1);
});
