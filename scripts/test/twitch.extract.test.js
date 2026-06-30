'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const twitchModulePath = require.resolve('../../src/providers/twitch');
const fetchModulePath = require.resolve('node-fetch');

function loadTwitchProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalTwitchModule = require.cache[twitchModulePath];
    const originalClientId = process.env.TWITCH_CLIENT_ID;
    const originalClientSecret = process.env.TWITCH_CLIENT_SECRET;
    const originalUploadMax = process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES;

    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    delete process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES;

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
        if (originalUploadMax === undefined) delete process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES;
        else process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES = originalUploadMax;
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

function createChannelGqlResponse(overrides = {}) {
    return {
        data: {
            user: {
                id: 'broadcaster-1',
                login: 'killin9hit',
                displayName: 'Killin9Hit',
                description: 'Streamer KH',
                profileImageURL: 'https://static-cdn.jtvnw.net/avatar.png',
                bannerImageURL: 'https://static-cdn.jtvnw.net/banner.jpg',
                stream: {
                    id: 'stream-1',
                    title: 'live stream title',
                    type: 'live',
                    viewersCount: 417,
                    createdAt: '2026-06-30T07:13:47Z',
                    previewImageURL: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_killin9hit-1280x720.jpg',
                    game: { id: 'game-1', name: 'Delta Force', displayName: 'Delta Force' },
                },
                ...overrides,
            },
        },
    };
}

function okVideoResponse(body, contentLength = body.length) {
    return {
        ok: true,
        status: 200,
        headers: { get: name => (name.toLowerCase() === 'content-length' ? String(contentLength) : null) },
        body: Readable.from([body]),
    };
}

function fakeTwitchFetch(calls, options = {}) {
    return async (url, fetchOptions = {}) => {
        calls.push({ url, options: fetchOptions });
        if (url === 'https://gql.twitch.tv/gql') {
            const body = JSON.parse(fetchOptions.body);
            return {
                ok: true,
                json: async () => Array.isArray(body) ? createGqlResponse() : createChannelGqlResponse(options.channelOverrides),
            };
        }
        if (String(url).startsWith('https://video.example/')) {
            return okVideoResponse(options.videoBody || Buffer.from('clip-video'));
        }
        throw new Error(`unexpected url ${url}`);
    };
}

test('twitch urlPattern matches clips, channel clip, and channel urls', () => {
    const provider = loadTwitchProviderWithFetch(async () => ({ ok: true, json: async () => createGqlResponse() }));
    const re = new RegExp(provider.urlPattern.source, provider.urlPattern.flags);
    const sample = [
        'https://clips.twitch.tv/SampleClip-abc_123',
        'https://www.twitch.tv/streamer/clip/SampleClip-abc_123?filter=clips',
        'https://m.twitch.tv/streamer/clip/SampleClip-abc_123',
        'https://www.twitch.tv/killin9hit',
        'https://www.twitch.tv/killin9hit?foo=bar',
        'https://m.twitch.tv/killin9hit',
    ].join(' ');

    const matches = sample.match(re) || [];
    assert.equal(matches.length, 6);
    assert.ok(matches.includes('https://clips.twitch.tv/SampleClip-abc_123'));
    assert.ok(matches.includes('https://www.twitch.tv/streamer/clip/SampleClip-abc_123?filter=clips'));
    assert.ok(matches.includes('https://m.twitch.tv/streamer/clip/SampleClip-abc_123'));
    assert.ok(matches.includes('https://www.twitch.tv/killin9hit'));
    assert.ok(matches.includes('https://www.twitch.tv/killin9hit?foo=bar'));
    assert.ok(matches.includes('https://m.twitch.tv/killin9hit'));
});

test('twitch extract: uploads clip video as a bot attachment without oauth env', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(fakeTwitchFetch(calls, {
        videoBody: Buffer.from('clip-video-data'),
    }));

    const url = 'https://clips.twitch.tv/SampleClip-abc_123';
    const result = await provider.extract(createMessage(url), url, {});

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://gql.twitch.tv/gql');
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.match(calls[1].url, /^https:\/\/video\.example\/1080\.mp4\?sig=sig123&token=/);

    const step = result[0];
    assert.equal(step.send, 'channel');
    assert.equal(step.content, undefined);
    assert.equal(step.embeds[0].title, 'Streamer');
    assert.match(step.embeds[0].description, /sample clip title/);
    assert.equal(step.embeds[0].image.url, 'https://static-cdn.jtvnw.net/thumb.jpg');
    assert.ok(step.embeds[0].fields.some(field => field.name === 'Views' && field.value === '12,345'));
    assert.ok(step.embeds[0].fields.some(field => field.name === 'Duration' && field.value === '0:26'));
    assert.equal(step.files.length, 1);
    assert.equal(step.files[0].name, 'twitch-SampleClip-abc_123.mp4');
    assert.ok(Buffer.isBuffer(step.files[0].attachment));
    assert.equal(step.files[0].attachment.toString(), 'clip-video-data');
    assert.equal(step.files[0].fallbackUrl, undefined);
});

test('twitch extract: returns markdown video URL when clip is too large to upload', async () => {
    const originalUploadMax = process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES;
    const calls = [];
    const provider = loadTwitchProviderWithFetch(async (requestUrl, options) => {
        calls.push({ url: requestUrl, options });
        if (requestUrl === 'https://gql.twitch.tv/gql') {
            return { ok: true, json: async () => createGqlResponse() };
        }
        if (String(requestUrl).startsWith('https://video.example/')) {
            return okVideoResponse(Buffer.from('x'), 100);
        }
        throw new Error(`unexpected url ${requestUrl}`);
    });

    try {
        process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES = '10';
        const url = 'https://clips.twitch.tv/SampleClip-abc_123';
        const result = await provider.extract(createMessage(url), url, {});

        assert.equal(calls.length, 2);
        assert.equal(result[0].files, undefined);
        assert.match(result[0].content, /^\[動画URL\]\(https:\/\/video\.example\/1080\.mp4\?sig=sig123&token=/);
        assert.ok(result[0].content.endsWith(')'));
    } finally {
        if (originalUploadMax === undefined) delete process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES;
        else process.env.TWITCH_CLIP_UPLOAD_MAX_BYTES = originalUploadMax;
    }
});

test('twitch extract: media_display_mode thumbnail_only skips clip video upload', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(fakeTwitchFetch(calls, {
        videoBody: Buffer.from('clip-video-data'),
    }));

    const url = 'https://clips.twitch.tv/SampleClip-abc_123';
    const result = await provider.extract(createMessage(url), url, {
        media_display_mode: 'thumbnail_only',
    });

    assert.equal(calls.length, 1);
    const step = result[0];
    assert.equal(step.files, undefined);
    assert.equal(step.content, undefined);
    assert.equal(step.embeds[0].image, undefined);
    assert.equal(step.embeds[0].thumbnail.url, 'https://static-cdn.jtvnw.net/thumb.jpg');
});

test('twitch extract: honors link-only delete and anonymous requester settings', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(fakeTwitchFetch(calls));

    const url = 'https://www.twitch.tv/streamer/clip/SampleClip-abc_123';
    const result = await provider.extract(createMessage(url), url, {
        anonymous_expand: true,
        deletemessageifonlypostedtweetlink: true,
    });

    assert.equal(result[0].deleteSource, true);
    assert.match(result[0].embeds[0].footer.text, /Anonymous requester/);
    assert.ok(!result[0].embeds[0].footer.text.includes('tester'));
});

test('twitch extract: honors hidden output items and description length for clips', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(fakeTwitchFetch(calls));

    const url = 'https://clips.twitch.tv/SampleClip-abc_123';
    const result = await provider.extract(createMessage(url), url, {
        twitch_description_max_length: 8,
        hidden_output_items: ['views', 'duration', 'game', 'clipped_by'],
    });

    const embed = result[0].embeds[0];
    assert.equal(embed.description, 'sampl...');
    assert.equal(embed.fields, undefined);

    const hidden = await provider.extract(createMessage(url), url, {
        twitch_description_max_length: 0,
    });
    assert.equal(hidden[0].embeds[0].description, undefined);
});

test('twitch extract: compact display density hides compact clip and channel fields', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(fakeTwitchFetch(calls));

    const clipUrl = 'https://clips.twitch.tv/SampleClip-abc_123';
    const standardClip = await provider.extract(createMessage(clipUrl), clipUrl, {
        media_display_mode: 'thumbnail_only',
    });
    const compactClip = await provider.extract(createMessage(clipUrl), clipUrl, {
        display_density: 'compact',
        media_display_mode: 'thumbnail_only',
    });
    const standardClipFieldNames = (standardClip[0].embeds[0].fields || []).map(field => field.name);
    const compactClipFieldNames = (compactClip[0].embeds[0].fields || []).map(field => field.name);

    assert.ok(standardClipFieldNames.includes('Views'));
    assert.ok(standardClipFieldNames.includes('Duration'));
    assert.ok(standardClipFieldNames.includes('Game'));
    assert.ok(standardClipFieldNames.includes('Clipped by'));
    assert.equal(compactClipFieldNames.includes('Views'), false);
    assert.equal(compactClipFieldNames.includes('Duration'), false);
    assert.equal(compactClipFieldNames.includes('Game'), false);
    assert.equal(compactClipFieldNames.includes('Clipped by'), false);
    assert.ok(compactClipFieldNames.length < standardClipFieldNames.length);

    const channelUrl = 'https://www.twitch.tv/killin9hit';
    const standardChannel = await provider.extract(createMessage(channelUrl), channelUrl, {});
    const compactChannel = await provider.extract(createMessage(channelUrl), channelUrl, {
        display_density: 'compact',
    });
    const standardChannelFieldNames = (standardChannel[0].embeds[0].fields || []).map(field => field.name);
    const compactChannelFieldNames = (compactChannel[0].embeds[0].fields || []).map(field => field.name);

    assert.ok(standardChannelFieldNames.includes('Status'));
    assert.ok(standardChannelFieldNames.includes('Viewers'));
    assert.ok(standardChannelFieldNames.includes('Game'));
    assert.ok(standardChannelFieldNames.includes('Started'));
    assert.equal(compactChannelFieldNames.includes('Status'), false);
    assert.equal(compactChannelFieldNames.includes('Viewers'), false);
    assert.equal(compactChannelFieldNames.includes('Game'), false);
    assert.equal(compactChannelFieldNames.includes('Started'), false);
    assert.ok(compactChannelFieldNames.length < standardChannelFieldNames.length);
});

test('twitch extract: expands channel urls with live stream metadata', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(fakeTwitchFetch(calls));

    const url = 'https://www.twitch.tv/killin9hit';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.variables.login, 'killin9hit');
    assert.equal(result[0].files, undefined);
    assert.equal(result[0].embeds[0].title, 'Killin9Hit is live');
    assert.equal(result[0].embeds[0].url, 'https://www.twitch.tv/killin9hit');
    assert.equal(result[0].embeds[0].image.url, 'https://static-cdn.jtvnw.net/previews-ttv/live_user_killin9hit-1280x720.jpg');
    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Status' && field.value === 'Live'));
    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Viewers' && field.value === '417'));
});

test('twitch extract: uses Japanese labels when default language is Japanese', async () => {
    const calls = [];
    const provider = loadTwitchProviderWithFetch(fakeTwitchFetch(calls));

    const url = 'https://www.twitch.tv/killin9hit';
    const result = await provider.extract(createMessage(url), url, { defaultLanguage: 'ja' });

    const embed = result[0].embeds[0];
    assert.ok(embed.fields.some(field => field.name === '状態' && field.value === 'ライブ中'));
    assert.ok(embed.fields.some(field => field.name === '視聴者' && field.value === '417'));
    assert.equal(result[0].components[0].components[1].data.label, '削除');
});

test('twitch internals parse supported twitch urls', () => {
    const provider = loadTwitchProviderWithFetch(async () => ({ ok: true, json: async () => createGqlResponse() }));
    assert.deepEqual(
        provider._internal.parseTwitchClipUrl('https://clips.twitch.tv/SampleClip-abc_123?foo=bar'),
        { kind: 'clip', slug: 'SampleClip-abc_123', channel: null },
    );
    assert.deepEqual(
        provider._internal.parseTwitchClipUrl('https://www.twitch.tv/streamer/clip/SampleClip-abc_123'),
        { kind: 'clip', slug: 'SampleClip-abc_123', channel: 'streamer' },
    );
    assert.equal(provider._internal.parseTwitchClipUrl('https://www.twitch.tv/videos/123'), null);
    assert.deepEqual(
        provider._internal.parseTwitchChannelUrl('https://www.twitch.tv/killin9hit?foo=bar'),
        { kind: 'channel', login: 'killin9hit' },
    );
    assert.equal(provider._internal.parseTwitchChannelUrl('https://www.twitch.tv/directory'), null);
});
