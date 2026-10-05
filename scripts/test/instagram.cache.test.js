'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInstagramClient } = require('../../src/providers/instagram/client');
const { CACHE_TTL_MS } = require('../../src/providers/instagram/constants');

const START = 1_800_000_000_000;
const CAPACITY = 1024;

function fakeClock(t) {
    let now = START;
    t.mock.method(Date, 'now', () => now);
    return { set: value => { now = value; } };
}

function response(body, status = 200) {
    return { ok: status === 200, status, text: async () => body };
}

function profileHtml(username) {
    return `<meta property="og:title" content="Artist (@${username})"><meta name="description" content="123 Followers, 4 Following, 5 Posts">`;
}

function mediaNode(shortcode) {
    return {
        __typename: 'GraphImage', shortcode,
        owner: { username: 'artist' },
        display_url: `https://example.com/${shortcode}.jpg`,
        edge_media_to_caption: { edges: [{ node: { text: 'unchanged caption' } }] },
    };
}

function mediaHtml(shortcode) {
    return `<script>window.data = ${JSON.stringify({ graphql: { shortcode_media: mediaNode(shortcode) } })};</script>`;
}

function media(shortcode, route = 'p', mediaIndex = null) {
    return { kind: 'media', shortcode, route, mediaIndex };
}

for (const source of ['html', 'api']) {
    test(`instagram cache: ${source} profiles retain normalized keys and a fixed 30-minute TTL`, async t => {
        const clock = fakeClock(t);
        let requests = 0;
        const client = createInstagramClient(async url => {
            requests++;
            if (String(url).includes('/api/v1/users/')) {
                return response(JSON.stringify({ data: { user: { username: 'artist.profile', biography: 'API bio' } } }));
            }
            return response(source === 'html' ? profileHtml('artist.profile') : '<html>login wall</html>');
        });
        const original = await client.fetchProfileData('Artist.Profile');
        const requestsPerMiss = source === 'html' ? 1 : 2;
        assert.equal(requests, requestsPerMiss);
        assert.deepEqual(client.getCacheStats(), { size: 1, maxEntries: CAPACITY, ttlMs: 30 * 60 * 1000 });
        clock.set(START + CACHE_TTL_MS - 1);
        assert.strictEqual(await client.fetchProfileData('ARTIST.PROFILE'), original);
        assert.equal(requests, requestsPerMiss);
        clock.set(START + CACHE_TTL_MS);
        const refreshed = await client.fetchProfileData('artist.profile');
        assert.notStrictEqual(refreshed, original);
        assert.deepEqual(refreshed, original);
        assert.equal(requests, requestsPerMiss * 2);
    });
}

test('instagram cache: a fresh hit removes unrelated expired entries even after LRU promotion', async t => {
    const clock = fakeClock(t);
    let requests = 0;
    const client = createInstagramClient(async url => {
        requests++;
        return response(profileHtml(new URL(url).pathname.split('/')[1]));
    });
    await client.fetchProfileData('old');
    clock.set(START + 60_000);
    const fresh = await client.fetchProfileData('fresh');
    clock.set(START + CACHE_TTL_MS - 1);
    await client.fetchProfileData('old'); // Expiring key is now most recently used.
    clock.set(START + CACHE_TTL_MS);
    assert.strictEqual(await client.fetchProfileData('fresh'), fresh);
    assert.equal(requests, 2);
    assert.equal(client.getCacheStats().size, 1);
});

test('instagram cache: expiry cleanup also runs when the next fetch fails', async t => {
    const clock = fakeClock(t);
    let fail = false;
    const client = createInstagramClient(async () => fail
        ? response('Unavailable', 503) : response(profileHtml('old')));
    await client.fetchProfileData('old');
    clock.set(START + CACHE_TTL_MS);
    fail = true;
    await assert.rejects(client.fetchProfileData('new'), /instagram profile 503/);
    assert.equal(client.getCacheStats().size, 0);
});

test('instagram cache: profiles and media share the 1024-entry LRU cap and retain hot keys', async t => {
    fakeClock(t);
    let requests = 0;
    const client = createInstagramClient(async url => {
        requests++;
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        return response(parts[0] === 'p' ? mediaHtml(parts[1]) : profileHtml(parts[0]));
    });
    for (let i = 0; i < CAPACITY / 2; i++) {
        await client.fetchProfileData(`profile${i}`);
        await client.fetchInstagramData(media(`POST${i}`));
    }
    const hot = await client.fetchProfileData('PROFILE0');
    await client.fetchInstagramData(media('OVERFLOW'));
    assert.equal(client.getCacheStats().size, CAPACITY);
    const afterOverflow = requests;
    for (let i = 0; i < 2000; i++) {
        assert.strictEqual(await client.fetchProfileData('profile0'), hot);
    }
    assert.equal(requests, afterOverflow);
    await client.fetchInstagramData(media('POST0')); // Oldest untouched entry was evicted.
    assert.equal(requests, afterOverflow + 1);
    assert.equal(client.getCacheStats().size, CAPACITY);
    assert.strictEqual(await client.fetchProfileData('profile0'), hot);
});

test('instagram cache: overlapping successful misses remain bounded per client', async t => {
    fakeClock(t);
    const fetch = async url => response(profileHtml(new URL(url).pathname.split('/')[1]));
    const first = createInstagramClient(fetch);
    const second = createInstagramClient(fetch);
    const secondProfile = await second.fetchProfileData('independent');
    await Promise.all(Array.from({ length: CAPACITY + 100 }, (_, i) => first.fetchProfileData(`profile${i}`)));
    assert.equal(first.getCacheStats().size, CAPACITY);
    assert.equal(second.getCacheStats().size, 1);
    first.clearCache();
    assert.equal(first.getCacheStats().size, 0);
    assert.strictEqual(await second.fetchProfileData('independent'), secondProfile);
});

for (const source of ['html', 'oembed', 'graphql']) {
    test(`instagram cache: ${source} media preserve shortcode identity, data and TTL`, async t => {
        const clock = fakeClock(t);
        let requests = 0;
        const client = createInstagramClient(async url => {
            requests++;
            const parsedUrl = new URL(url);
            if (parsedUrl.pathname.includes('/oembed/')) {
                return source === 'oembed'
                    ? response(JSON.stringify({ author_name: 'artist', title: 'caption', thumbnail_url: 'https://example.com/thumb.jpg' }))
                    : response('Not found', 404);
            }
            if (parsedUrl.pathname.includes('/graphql/')) {
                return response(JSON.stringify({ data: { xdt_shortcode_media: mediaNode('CaseCode') } }));
            }
            return response(source === 'html' ? mediaHtml(parsedUrl.pathname.split('/')[2]) : '<html>login wall</html>');
        });
        const original = await client.fetchInstagramData(media('CaseCode'));
        const requestsPerMiss = requests;
        assert.ok(original.medias.length > 0);
        assert.strictEqual(await client.fetchInstagramData(media('CaseCode', 'reel', 2)), original);
        assert.equal(requests, requestsPerMiss);
        clock.set(START + CACHE_TTL_MS - 1);
        assert.strictEqual(await client.fetchInstagramData(media('CaseCode')), original);
        clock.set(START + CACHE_TTL_MS);
        const refreshed = await client.fetchInstagramData(media('CaseCode'));
        assert.notStrictEqual(refreshed, original);
        assert.deepEqual(refreshed, original);
        assert.equal(requests, requestsPerMiss * 2);
        if (source === 'html') {
            await client.fetchInstagramData(media('casecode'));
            assert.equal(requests, requestsPerMiss * 2 + 1);
            assert.equal(client.getCacheStats().size, 2);
        }
    });
}

test('instagram cache: clear removes profile/media entries and resets API backoff', async t => {
    const clock = fakeClock(t);
    let apiRequests = 0;
    let htmlRequests = 0;
    const client = createInstagramClient(async url => {
        const pathname = new URL(url).pathname;
        if (pathname.includes('/api/v1/users/')) {
            apiRequests++;
            return response('Too Many Requests', 429);
        }
        htmlRequests++;
        if (pathname === '/cached/') return response(profileHtml('cached'));
        if (pathname === '/p/POST/') return response(mediaHtml('POST'));
        return response('<html>login wall</html>');
    });
    await client.fetchProfileData('cached');
    await client.fetchInstagramData(media('POST'));
    await assert.rejects(client.fetchProfileData('blocked'), { status: 429 });
    await assert.rejects(client.fetchProfileData('other'), /html missing user/);
    assert.equal(apiRequests, 1);
    assert.equal(client.getCacheStats().size, 2);
    client.clearCache();
    assert.equal(client.getCacheStats().size, 0);
    await assert.rejects(client.fetchProfileData('blocked'), { status: 429 });
    assert.equal(apiRequests, 2);
    const beforeRefill = htmlRequests;
    clock.set(START + 1000);
    await client.fetchProfileData('cached');
    await client.fetchInstagramData(media('POST'));
    assert.equal(htmlRequests, beforeRefill + 2);
    clock.set(START + 1000 + CACHE_TTL_MS);
    await client.fetchProfileData('cached');
    assert.equal(client.getCacheStats().size, 1);
});

test('instagram cache: diagnostic snapshots cannot mutate cache limits or extend expiry', async t => {
    const clock = fakeClock(t);
    let requests = 0;
    const client = createInstagramClient(async () => {
        requests++;
        return response(profileHtml('artist'));
    });
    await client.fetchProfileData('artist');
    const stats = client.getCacheStats();
    stats.size = 0;
    stats.maxEntries = Infinity;
    stats.ttlMs = Infinity;
    clock.set(START + CACHE_TTL_MS);
    assert.deepEqual(client.getCacheStats(), { size: 1, maxEntries: CAPACITY, ttlMs: CACHE_TTL_MS });
    await client.fetchProfileData('artist');
    assert.equal(requests, 2);
});
