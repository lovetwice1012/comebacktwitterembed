'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const twitchModulePath = require.resolve('../../src/providers/twitch');
const fetchModulePath = require.resolve('node-fetch');

function loadTwitchProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalTwitchModule = require.cache[twitchModulePath];
    const originalClientId = process.env.TWITCH_CLIENT_ID;
    const originalClientSecret = process.env.TWITCH_CLIENT_SECRET;

    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[twitchModulePath];

    try {
        return require(twitchModulePath);
    } finally {
        delete require.cache[twitchModulePath];
        if (originalTwitchModule) require.cache[twitchModulePath] = originalTwitchModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];

        if (originalClientId === undefined) delete process.env.TWITCH_CLIENT_ID;
        else process.env.TWITCH_CLIENT_ID = originalClientId;
        if (originalClientSecret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
        else process.env.TWITCH_CLIENT_SECRET = originalClientSecret;
    }
}

function createMessage(content) {
    return {
        guild: { id: 'guild-1' },
        guildId: 'guild-1',
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content,
    };
}

function createGqlResponse() {
    return [
        {
            data: {
                clip: {
                    id: 'clip-id',
                    slug: 'SampleClip-abc_123',
                    title: 'sample clip title',
                    viewCount: 12345,
                    createdAt: '2024-08-24T19:27:18Z',
                    durationSeconds: 26,
                    url: 'https://www.twitch.tv/streamer/clip/SampleClip-abc_123',
                    thumbnailURL: 'https://static-cdn.jtvnw.net/thumb.jpg',
                    broadcaster: {
                        id: 'broadcaster-1',
                        login: 'streamer',
                        displayName: 'Streamer',
                        profileImageURL: 'https://static-cdn.jtvnw.net/avatar.png',
                    },
                    curator: {
                        id: 'curator-1',
                        login: 'clipper',
                        displayName: 'Clipper',
                    },
                    game: {
                        id: 'game-1',
                        name: 'Game',
                        displayName: 'Game Name',
                    },
                },
            },
        },
        {
            data: {
                clip: {
                    playbackAccessToken: {
                        signature: 'sig123',
                        value: '{"clip_slug":"SampleClip-abc_123"}',
                    },
                    videoQualities: [
                        { quality: '720', sourceURL: 'https://video.example/720.mp4' },
                        { quality: '1080', sourceURL: 'https://video.example/1080.mp4' },
                    ],
                },
            },
        },
    ];
}

test('twitch urlPattern matches clips.twitch and channel clip urls', () => {
    const provider = loadTwitchProviderWithFetch(async () => ({ ok: true, json: async () => createGqlResponse() }));
    const re = new RegExp(provider.urlPattern.source, provider.urlPattern.flags);
    const sample = [
        'https://clips.twitch.tv/SampleClip-abc_123',
        'https://www.twitch.tv/streamer/clip/SampleClip-abc_123?filter=clips',
        'https://m.twitch.tv/streamer/clip/SampleClip-abc_123',
    ].join(' ');

    const matches = sample.match(re) || [];
    assert.equal(matches.length, 3);
    assert.ok(matches.includes('https://clips.twitch.tv/SampleClip-abc_123'));
    assert.ok(matches.includes('https://www.twitch.tv/streamer/clip/SampleClip-abc_123?filter=clips'));
    assert.ok(matches.includes('https://m.twitch.tv/streamer/clip/SampleClip-abc_123'));
});

test('twitch extract: builds embed and signed video attachment without oauth env', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => createGqlResponse() };
    });

    const url = 'https://clips.twitch.tv/SampleClip-abc_123';
    const result = await provider.extract(createMessage(url), url, {});

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gql.twitch.tv/gql');
    assert.equal(calls[0].options.headers.Authorization, undefined);

    const step = result[0];
    assert.equal(step.send, 'channel');
    assert.equal(step.embeds[0].title, 'Streamer');
    assert.match(step.embeds[0].description, /sample clip title/);
    assert.equal(step.embeds[0].image.url, 'https://static-cdn.jtvnw.net/thumb.jpg');
    assert.ok(step.embeds[0].fields.some(field => field.name === 'Views' && field.value === '12,345'));
    assert.ok(step.embeds[0].fields.some(field => field.name === 'Duration' && field.value === '0:26'));
    assert.equal(step.files.length, 1);
    assert.match(step.files[0], /^https:\/\/video\.example\/1080\.mp4\?sig=sig123&token=/);
    assert.ok(decodeURIComponent(step.files[0]).includes('"clip_slug":"SampleClip-abc_123"'));
});

test('twitch extract: honors link-only delete and anonymous requester settings', async () => {
    const provider = loadTwitchProviderWithFetch(async () => ({ ok: true, json: async () => createGqlResponse() }));

    const url = 'https://www.twitch.tv/streamer/clip/SampleClip-abc_123';
    const result = await provider.extract(createMessage(url), url, {
        anonymous_expand: true,
        deletemessageifonlypostedtweetlink: true,
    });

    assert.equal(result[0].deleteSource, true);
    assert.match(result[0].embeds[0].footer.text, /Anonymous requester/);
    assert.ok(!result[0].embeds[0].footer.text.includes('tester'));
});

test('twitch internals parse supported clip urls', () => {
    const provider = loadTwitchProviderWithFetch(async () => ({ ok: true, json: async () => createGqlResponse() }));
    assert.deepEqual(
        provider._internal.parseTwitchClipUrl('https://clips.twitch.tv/SampleClip-abc_123?foo=bar'),
        { slug: 'SampleClip-abc_123', channel: null },
    );
    assert.deepEqual(
        provider._internal.parseTwitchClipUrl('https://www.twitch.tv/streamer/clip/SampleClip-abc_123'),
        { slug: 'SampleClip-abc_123', channel: 'streamer' },
    );
    assert.equal(provider._internal.parseTwitchClipUrl('https://www.twitch.tv/videos/123'), null);
});
