'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const youtubeModulePath = require.resolve('../../src/providers/youtube');
const fetchModulePath = require.resolve('node-fetch');

function loadYouTubeProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalYouTubeModule = require.cache[youtubeModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[youtubeModulePath];

    try {
        return require(youtubeModulePath);
    } finally {
        delete require.cache[youtubeModulePath];
        if (originalYouTubeModule) require.cache[youtubeModulePath] = originalYouTubeModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

function createMessage(content) {
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content,
    };
}

function okJson(json) {
    return { ok: true, json: async () => json };
}

function videoInfo() {
    return {
        title: 'Example Video',
        videoThumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg', width: 1280, height: 720 }],
        description: 'A <b>great</b> description &amp; details',
        publishedText: '2 years ago',
        viewCount: 1234567,
        likeCount: 9876,
        author: 'Example Channel',
        authorUrl: '/channel/UCexample',
        authorId: 'UCexample',
        authorThumbnails: [{ url: 'https://yt3.example/avatar.jpg', width: 88, height: 88 }],
        subCountText: '123K subscribers',
        liveNow: false,
        formatStreams: [],
    };
}

function playlistInfo() {
    return {
        title: 'Example Playlist',
        playlistThumbnail: 'https://i.ytimg.com/vi/one/maxresdefault.jpg',
        description: 'Playlist description',
        author: 'Playlist Owner',
        authorUrl: '/channel/UCplaylist',
        authorId: 'UCplaylist',
        videoCount: 42,
        viewCount: 1234,
        updated: 1710000000,
        videos: [
            { title: 'First video', videoId: 'first', videoThumbnails: [] },
            { title: 'Second video', videoId: 'second', videoThumbnails: [] },
        ],
    };
}

function channelInfo() {
    return {
        author: 'Example Channel',
        authorId: 'UCexample',
        authorUrl: '/channel/UCexample',
        authorBanners: [{ url: 'https://yt3.example/banner.jpg', width: 2120, height: 350 }],
        authorThumbnails: [{ url: 'https://yt3.example/avatar.jpg', width: 88, height: 88 }],
        subCount: 123000,
        totalViews: 4560000,
        descriptionHtml: 'Channel <b>description</b>',
        latestVideos: [
            { title: 'Newest upload' },
            { title: 'Another upload' },
        ],
        authorVerified: true,
    };
}

function playerResponseHtml() {
    const player = {
        videoDetails: {
            videoId: 'W7G8NAhG6l8',
            title: 'Fallback Video',
            thumbnail: {
                thumbnails: [{ url: 'https://i.ytimg.com/vi/W7G8NAhG6l8/hqdefault.jpg', width: 480, height: 360 }],
            },
            shortDescription: 'Fallback description',
            viewCount: '3210',
            author: 'Fallback Channel',
            channelId: 'UCfallback',
            isLiveContent: false,
        },
        microformat: {
            playerMicroformatRenderer: {
                ownerProfileUrl: 'https://www.youtube.com/@fallback',
                publishDate: '2026-06-01',
            },
        },
    };
    return `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`;
}

function initialDataHtml(data, meta = {}) {
    const tags = Object.entries(meta)
        .map(([name, value]) => `<meta property="${name}" content="${String(value).replace(/"/g, '&quot;')}">`)
        .join('');
    return `<html><head>${tags}</head><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}

function playlistInitialDataHtml() {
    return initialDataHtml({
        metadata: {
            playlistMetadataRenderer: {
                title: 'Fallback Playlist',
                description: 'Fallback playlist description',
            },
        },
        header: {
            playlistHeaderRenderer: {
                title: { simpleText: 'Fallback Playlist' },
                numVideosText: { simpleText: '2 videos' },
                viewCountText: { simpleText: '1,234 views' },
                ownerText: {
                    runs: [{
                        text: 'Fallback Owner',
                        navigationEndpoint: {
                            browseEndpoint: { browseId: 'UCfallbackPlaylist' },
                            commandMetadata: { webCommandMetadata: { url: '/channel/UCfallbackPlaylist' } },
                        },
                    }],
                },
                playlistHeaderBanner: {
                    heroPlaylistThumbnailRenderer: {
                        thumbnail: {
                            thumbnails: [{ url: 'https://i.ytimg.com/vi/fallback/maxresdefault.jpg', width: 1280, height: 720 }],
                        },
                    },
                },
            },
        },
        contents: [
            {
                playlistVideoRenderer: {
                    title: { runs: [{ text: 'Fallback first video' }] },
                    videoId: 'fallbackone',
                    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/fallbackone/hqdefault.jpg', width: 480, height: 360 }] },
                },
            },
            {
                playlistVideoRenderer: {
                    title: { runs: [{ text: 'Fallback second video' }] },
                    videoId: 'fallbacktwo',
                    thumbnail: { thumbnails: [] },
                },
            },
        ],
    });
}

function channelInitialDataHtml() {
    return initialDataHtml({
        metadata: {
            channelMetadataRenderer: {
                title: 'Fallback Channel',
                description: 'Fallback channel description',
                externalId: 'UCfallback',
                channelUrl: 'https://www.youtube.com/channel/UCfallback',
                avatar: { thumbnails: [{ url: 'https://yt3.example/fallback-avatar.jpg', width: 88, height: 88 }] },
            },
        },
        header: {
            c4TabbedHeaderRenderer: {
                title: 'Fallback Channel',
                subscriberCountText: { simpleText: '123K subscribers' },
                viewCountText: { simpleText: '4,567 views' },
                banner: { thumbnails: [{ url: 'https://yt3.example/fallback-banner.jpg', width: 2120, height: 350 }] },
                badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED' } }],
            },
        },
        contents: [
            {
                videoRenderer: {
                    title: { runs: [{ text: 'Fallback newest upload' }] },
                    videoId: 'newestvideo1',
                },
            },
        ],
    });
}

test('youtube extract: builds a self-owned video embed from Invidious metadata', async () => {
    const requests = [];
    const provider = loadYouTubeProviderWithFetch(async (url) => {
        requests.push(url);
        assert.ok(url.includes('/api/v1/videos/dQw4w9WgXcQ?hl=en'));
        return okJson(videoInfo());
    });

    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s&si=tracking';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(requests.length, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, undefined);
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].title, 'Example Video');
    assert.equal(result[0].embeds[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s');
    assert.equal(result[0].embeds[0].author.name, 'Example Channel');
    assert.equal(result[0].embeds[0].description, 'A great description & details');
    assert.equal(result[0].embeds[0].image.url, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Views' && field.value === '1,234,567'));
    assert.ok(result[0].embeds[0].footer.text.includes('tester(id:user-1)'));
    assert.equal(result[0].components.length, 1);
    assert.deepEqual(
        result[0].components[0].components.map(button => button.data.custom_id),
        ['translate', 'downloadYouTubeVideo', 'delete:youtube']
    );
    assert.equal(result[0].send, 'channel');
    assert.equal(result[0].suppressSourceEmbeds, true);
});

test('youtube extract: falls back to YouTube page metadata when Invidious returns 404', async () => {
    const requests = [];
    const provider = loadYouTubeProviderWithFetch(async (url) => {
        requests.push(url);
        if (url.includes('/api/v1/videos/W7G8NAhG6l8?hl=en')) {
            return { ok: false, status: 404 };
        }
        if (url.includes('https://www.youtube.com/watch?v=W7G8NAhG6l8')) {
            return { ok: true, text: async () => playerResponseHtml() };
        }
        throw new Error(`unexpected url ${url}`);
    });

    const url = 'https://www.youtube.com/watch?v=W7G8NAhG6l8';
    const result = await provider.extract(createMessage(url), url, {});

    assert.ok(requests.filter(request => request.includes('/api/v1/videos/W7G8NAhG6l8?hl=en')).length >= 1);
    assert.ok(requests.some(request => request.includes('https://www.youtube.com/watch?v=W7G8NAhG6l8')));
    assert.equal(result.length, 1);
    assert.equal(result[0].embeds[0].title, 'Fallback Video');
    assert.equal(result[0].embeds[0].description, 'Fallback description');
    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Views' && field.value === '3,210'));
});

test('youtube extract: builds playlist embeds from playlist metadata', async () => {
    const provider = loadYouTubeProviderWithFetch(async (url) => {
        assert.ok(url.includes('/api/v1/playlists/PL123456789012345678?hl=en'));
        return okJson(playlistInfo());
    });

    const url = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    const result = await provider.extract(createMessage(url), url, {});

    const embed = result[0].embeds[0];
    assert.equal(embed.title, 'Example Playlist');
    assert.ok(embed.description.includes('Playlist description'));
    assert.ok(embed.description.includes('1. First video'));
    assert.ok(embed.fields.some(field => field.name === 'Videos' && field.value === '42'));
    assert.equal(embed.image.url, 'https://i.ytimg.com/vi/one/maxresdefault.jpg');
    assert.deepEqual(
        result[0].components[0].components.map(button => button.data.custom_id),
        ['translate', 'delete:youtube']
    );
});

test('youtube extract: falls back to YouTube page metadata for playlists', async () => {
    const requests = [];
    const provider = loadYouTubeProviderWithFetch(async (url) => {
        requests.push(url);
        if (url.includes('/api/v1/playlists/PL123456789012345678?hl=en')) {
            return okJson({ error: 'Playlist unavailable' });
        }
        if (url.includes('https://www.youtube.com/playlist?list=PL123456789012345678')) {
            return { ok: true, text: async () => playlistInitialDataHtml() };
        }
        throw new Error(`unexpected url ${url}`);
    });

    const url = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.ok(requests.some(request => request.includes('/api/v1/playlists/PL123456789012345678?hl=en')));
    assert.ok(requests.some(request => request.includes('https://www.youtube.com/playlist?list=PL123456789012345678')));
    assert.equal(embed.title, 'Fallback Playlist');
    assert.ok(embed.description.includes('Fallback playlist description'));
    assert.ok(embed.description.includes('1. Fallback first video'));
    assert.ok(embed.fields.some(field => field.name === 'Videos' && field.value === '2'));
    assert.ok(embed.fields.some(field => field.name === 'Views' && field.value === '1,234'));
    assert.equal(embed.image.url, 'https://i.ytimg.com/vi/fallback/maxresdefault.jpg');
});

test('youtube extract: resolves handle urls before building channel embeds', async () => {
    const requests = [];
    const provider = loadYouTubeProviderWithFetch(async (url) => {
        requests.push(url);
        if (url.includes('/api/v1/resolveurl?')) return okJson({ ucid: 'UCexample' });
        if (url.includes('/api/v1/channels/UCexample?hl=en')) return okJson(channelInfo());
        throw new Error(`unexpected url ${url}`);
    });

    const url = 'https://www.youtube.com/@example';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(requests.length, 2);
    const embed = result[0].embeds[0];
    assert.equal(embed.title, 'Example Channel ✓');
    assert.ok(embed.description.includes('Channel description'));
    assert.ok(embed.description.includes('1. Newest upload'));
    assert.equal(embed.thumbnail.url, 'https://yt3.example/avatar.jpg');
    assert.equal(embed.image.url, 'https://yt3.example/banner.jpg');
});

test('youtube extract: falls back to YouTube page metadata for channels', async () => {
    const requests = [];
    const provider = loadYouTubeProviderWithFetch(async (url) => {
        requests.push(url);
        if (url.includes('/api/v1/resolveurl?')) {
            return { ok: false, status: 404 };
        }
        if (url.includes('https://www.youtube.com/@fallback')) {
            return { ok: true, text: async () => channelInitialDataHtml() };
        }
        throw new Error(`unexpected url ${url}`);
    });

    const url = 'https://www.youtube.com/@fallback';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.ok(requests.some(request => request.includes('/api/v1/resolveurl?')));
    assert.ok(requests.some(request => request.includes('https://www.youtube.com/@fallback')));
    assert.ok(embed.title.includes('Fallback Channel'));
    assert.ok(embed.description.includes('Fallback channel description'));
    assert.ok(embed.description.includes('1. Fallback newest upload'));
    assert.ok(embed.fields.some(field => field.name === 'Subscribers' && field.value === '123,000'));
    assert.equal(embed.thumbnail.url, 'https://yt3.example/fallback-avatar.jpg');
    assert.equal(embed.image.url, 'https://yt3.example/fallback-banner.jpg');
});

test('youtube extract: honors reply, delete source, and anonymous settings', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson(videoInfo()));
    const url = 'https://youtu.be/dQw4w9WgXcQ';
    const result = await provider.extract(createMessage(url), url, {
        alwaysreplyifpostedtweetlink: true,
        deletemessageifonlypostedtweetlink: true,
        anonymous_expand: true,
        defaultLanguage: 'en',
    });

    assert.equal(result[0].send, 'reply-source');
    assert.equal(result[0].deleteSource, true);
    assert.ok(result[0].embeds[0].footer.text.includes('Anonymous requester'));
});

test('youtube parse: rejects non-youtube urls', () => {
    const provider = require('../../src/providers/youtube');
    assert.equal(provider._internal.parseYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});
