'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const spotifyModulePath = require.resolve('../../src/providers/spotify');
const fetchModulePath = require.resolve('node-fetch');

function loadSpotifyProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalSpotifyModule = require.cache[spotifyModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[spotifyModulePath];

    try {
        return require(spotifyModulePath);
    } finally {
        delete require.cache[spotifyModulePath];
        if (originalSpotifyModule) require.cache[spotifyModulePath] = originalSpotifyModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

function createMessage(url = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT') {
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content: url,
    };
}

function createTrackEntity(overrides = {}) {
    return {
        type: 'track',
        name: 'Never Gonna Give You Up',
        id: '4cOdK2wGLETKBW3PvgPWqT',
        artists: [{ name: 'Rick Astley', uri: 'spotify:artist:0gxyHStUsqpMadRV0Di1Qt' }],
        releaseDate: { isoString: '1987-11-12T00:00:00Z' },
        duration: 213573,
        audioPreview: { url: 'https://p.scdn.co/mp3-preview/sample' },
        visualIdentity: {
            image: [
                { url: 'https://image.example/300.jpg', maxWidth: 300, maxHeight: 300 },
                { url: 'https://image.example/640.jpg', maxWidth: 640, maxHeight: 640 },
                { url: 'https://image.example/64.jpg', maxWidth: 64, maxHeight: 64 },
            ],
        },
        ...overrides,
    };
}

function nextDataHtml(entity, status = 200) {
    const payload = {
        props: {
            pageProps: {
                status,
                state: { data: { entity } },
            },
        },
    };
    return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

test('spotify extract: builds a Discord embed from Spotify embed page data', async () => {
    const calledUrls = [];
    const provider = loadSpotifyProviderWithFetch(async (apiUrl) => {
        calledUrls.push(apiUrl);
        return {
            ok: true,
            text: async () => nextDataHtml(createTrackEntity()),
        };
    });

    const url = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(calledUrls[0], 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT?utm_source=comebacktwitterembed');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);

    const step = result[0];
    const embed = step.embeds[0];
    assert.equal(embed.title, 'Never Gonna Give You Up');
    assert.equal(embed.url, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(embed.author.name, 'Rick Astley');
    assert.equal(embed.author.url, 'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt');
    assert.equal(embed.image.url, 'https://image.example/640.jpg');
    assert.ok(embed.footer.text.includes('tester(id:user-1)'));
    assert.ok(embed.fields.some(f => f.name === 'Duration' && f.value === '3:33'));
    assert.ok(embed.fields.some(f => f.name === 'Release date' && f.value === '1987-11-12'));
    assert.deepEqual(step.files, [{
        attachment: 'https://p.scdn.co/mp3-preview/sample',
        name: 'spotify-preview-4cOdK2wGLETKBW3PvgPWqT.mp3',
    }]);
    assert.equal(step.send, 'channel');
});

test('spotify extract: supports intl-prefixed Spotify track urls', async () => {
    const provider = loadSpotifyProviderWithFetch(async () => ({
        ok: true,
        text: async () => nextDataHtml(createTrackEntity({ audioPreview: null })),
    }));

    const url = 'https://open.spotify.com/intl-ja/track/4cOdK2wGLETKBW3PvgPWqT';
    const result = await provider.extract(createMessage(url), url, {});

    assert.ok(Array.isArray(result));
    assert.equal(result[0].files.length, 0);
    assert.equal(result[0].embeds[0].url, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
});

test('spotify extract: can delete source message when only the Spotify link was posted', async () => {
    const provider = loadSpotifyProviderWithFetch(async () => ({
        ok: true,
        text: async () => nextDataHtml(createTrackEntity()),
    }));

    const url = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
    const result = await provider.extract(createMessage(url), url, { deletemessageifonlypostedtweetlink: true });

    assert.equal(result[0].deleteSource, true);
});

test('spotify urlPattern: matches plain and intl track links', () => {
    const provider = loadSpotifyProviderWithFetch(async () => ({
        ok: true,
        text: async () => nextDataHtml(createTrackEntity()),
    }));
    const sample = 'a https://open.spotify.com/track/abc123?si=x b https://open.spotify.com/intl-ja/track/def456 c https://example.com/track/nope';
    const matches = sample.match(new RegExp(provider.urlPattern.source, provider.urlPattern.flags)) || [];

    assert.deepEqual(matches, [
        'https://open.spotify.com/track/abc123?si=x',
        'https://open.spotify.com/intl-ja/track/def456',
    ]);
});
