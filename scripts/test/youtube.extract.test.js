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
        published: 1704067200,
        lengthSeconds: 213,
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
    const oldEnabled = process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
    delete process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
    try {
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
        assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Type' && field.value === 'Video'));
        assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Duration' && field.value === '3:33'));
        assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Uploaded' && field.value === '<t:1704067200:d>'));
        assert.ok(result[0].embeds[0].footer.text.includes('tester(id:user-1)'));
        assert.equal(result[0].components.length, 1);
        assert.deepEqual(
            result[0].components[0].components.map(button => button.data.custom_id),
            ['translate', 'delete:youtube']
        );
        assert.equal(result[0].send, 'channel');
        assert.equal(result[0].suppressSourceEmbeds, true);
    } finally {
        if (oldEnabled === undefined) delete process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
        else process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED = oldEnabled;
    }
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

test('youtube extract: invalid successful video responses use the next instance', async () => {
    for (const invalid of [null, [], {}, { title: '  ' }]) {
        let requests = 0;
        const provider = loadYouTubeProviderWithFetch(async () => okJson(++requests === 1 ? invalid : videoInfo()));
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const result = await provider.extract(createMessage(url), url, {});
        assert.equal(requests, 2);
        assert.equal(result[0].embeds[0].title, 'Example Video');
    }
});

test('youtube extract: explicitly mismatched instance identities use another instance', async () => {
    let videoCalls = 0;
    const video = loadYouTubeProviderWithFetch(async () => okJson({ ...videoInfo(), videoId: ++videoCalls === 1 ? 'W7G8NAhG6l8' : 'dQw4w9WgXcQ' }));
    const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    assert.equal((await video.extract(createMessage(videoUrl), videoUrl, {}))[0].embeds[0].title, 'Example Video');
    assert.equal(videoCalls, 2);
    let playlistCalls = 0;
    const playlist = loadYouTubeProviderWithFetch(async () => okJson({ ...playlistInfo(), playlistId: ++playlistCalls === 1 ? 'PLdifferent' : 'PL123456789012345678' }));
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    assert.equal((await playlist.extract(createMessage(playlistUrl), playlistUrl, {}))[0].embeds[0].title, 'Example Playlist');
    assert.equal(playlistCalls, 2);
    let channelCalls = 0;
    const channel = loadYouTubeProviderWithFetch(async url => String(url).includes('/resolveurl?') ? okJson({ ucid: 'UCexample' })
        : okJson({ ...channelInfo(), authorId: ++channelCalls === 1 ? 'UCother' : 'UCexample' }));
    const channelUrl = 'https://www.youtube.com/@example';
    assert.match((await channel.extract(createMessage(channelUrl), channelUrl, {}))[0].embeds[0].title, /Example Channel/);
    assert.equal(channelCalls, 2);
});

test('youtube extract: a page for another video falls through to oEmbed', async () => {
    const requests = [];
    const provider = loadYouTubeProviderWithFetch(async url => {
        requests.push(String(url));
        if (String(url).includes('/api/v1/videos/')) return { ok: false, status: 503 };
        if (String(url).startsWith('https://www.youtube.com/watch?')) return { ok: true, text: async () => playerResponseHtml() };
        if (String(url).startsWith('https://www.youtube.com/oembed?')) return okJson({ title: 'Verified fallback', author_name: 'Artist' });
        throw new Error('unexpected fixture request');
    });
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = await provider.extract(createMessage(url), url, {});
    assert.equal(result[0].embeds[0].title, 'Verified fallback');
    assert(requests.some(request => request.includes('/oembed?')));
});

test('youtube extract: empty playlist and channel fallback pages are not reported as expansions', async () => {
    for (const url of ['https://www.youtube.com/playlist?list=PL123456789012345678', 'https://www.youtube.com/@example']) {
        const provider = loadYouTubeProviderWithFetch(async request => {
            if (String(request).includes('/api/v1/')) return { ok: false, status: 503 };
            return { ok: true, text: async () => initialDataHtml({}) };
        });
        const result = await provider.extract(createMessage(url), url, { failure_display_policy: 'source_link' });
        assert.equal(result[0].content, 'Please check the original link.');
        assert.equal(result[0].embeds, undefined);
    }
});

test('youtube extract: fallback pages with conflicting playlist or channel identity are rejected', async () => {
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    const channelUrl = 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv';
    for (const [url, page] of [
        [playlistUrl, initialDataHtml({ header: { playlistHeaderRenderer: { playlistId: 'PLdifferent123456789', title: { simpleText: 'Wrong playlist' } } } })],
        [channelUrl, channelInitialDataHtml()],
    ]) {
        const provider = loadYouTubeProviderWithFetch(async request => String(request).includes('/api/v1/')
            ? { ok: false, status: 503 } : { ok: true, text: async () => page });
        const result = await provider.extract(createMessage(url), url, { failure_display_policy: 'source_link' });
        assert.equal(result[0].content, 'Please check the original link.');
        assert.equal(result[0].embeds, undefined);
    }
});

test('youtube extract: fallback redirects to other resources are rejected', async () => {
    for (const [url, page, finalUrl] of [
        ['https://www.youtube.com/playlist?list=PL123456789012345678', playlistInitialDataHtml(), 'https://www.youtube.com/playlist?list=PLother1234567890123'],
        ['https://www.youtube.com/@fallback', channelInitialDataHtml(), 'https://www.youtube.com/@other'],
    ]) {
        const provider = loadYouTubeProviderWithFetch(async request => String(request).includes('/api/v1/')
            ? { ok: false, status: 503 } : { ok: true, url: finalUrl, text: async () => page });
        const result = await provider.extract(createMessage(url), url, { failure_display_policy: 'source_link' });
        assert.equal(result[0].content, 'Please check the original link.');
        assert.equal(result[0].embeds, undefined);
    }
});

test('youtube extract: a video redirect to another item falls through to oEmbed', async () => {
    const provider = loadYouTubeProviderWithFetch(async request => {
        if (String(request).includes('/api/v1/')) return { ok: false, status: 503 };
        if (String(request).includes('/oembed?')) return okJson({ title: 'Correct fallback' });
        return { ok: true, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', text: async () => playerResponseHtml() };
    });
    const url = 'https://www.youtube.com/watch?v=W7G8NAhG6l8';
    assert.equal((await provider.extract(createMessage(url), url, {}))[0].embeds[0].title, 'Correct fallback');
});

test('youtube extract: a channel ID can redirect to a handle when the page confirms the same channel', async () => {
    const provider = loadYouTubeProviderWithFetch(async request => String(request).includes('/api/v1/')
        ? { ok: false, status: 503 } : { ok: true, url: 'https://www.youtube.com/@fallback', text: async () => channelInitialDataHtml() });
    const url = 'https://www.youtube.com/channel/UCfallback';
    assert.match((await provider.extract(createMessage(url), url, {}))[0].embeds[0].title, /Fallback Channel/);
});

test('youtube extract: unusable instance metadata falls back to the YouTube page', async () => {
    const requests = [];
    const provider = loadYouTubeProviderWithFetch(async url => {
        requests.push(String(url));
        if (String(url).includes('/api/v1/videos/')) return okJson({});
        if (String(url).startsWith('https://www.youtube.com/watch?')) return { ok: true, text: async () => playerResponseHtml() };
        throw new Error('unexpected fixture request');
    });
    const url = 'https://www.youtube.com/watch?v=W7G8NAhG6l8';
    const result = await provider.extract(createMessage(url), url, {});
    assert.equal(result[0].embeds[0].title, 'Fallback Video');
    assert(requests.some(request => request.startsWith('https://www.youtube.com/watch?')));
});

test('youtube extract: playlist and channel requests skip malformed successful responses', async () => {
    let playlistRequests = 0;
    const playlist = loadYouTubeProviderWithFetch(async () => okJson(++playlistRequests === 1 ? [] : playlistInfo()));
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    assert.equal((await playlist.extract(createMessage(playlistUrl), playlistUrl, {}))[0].embeds[0].title, 'Example Playlist');
    assert.equal(playlistRequests, 2);

    let resolveRequests = 0, channelRequests = 0;
    const channel = loadYouTubeProviderWithFetch(async url => {
        if (String(url).includes('/api/v1/resolveurl?')) return okJson(++resolveRequests === 1 ? {} : { ucid: 'UCexample' });
        if (String(url).includes('/api/v1/channels/')) return okJson(++channelRequests === 1 ? null : channelInfo());
        throw new Error('unexpected fixture request');
    });
    const channelUrl = 'https://www.youtube.com/@example';
    assert.match((await channel.extract(createMessage(channelUrl), channelUrl, {}))[0].embeds[0].title, /Example Channel/);
    assert.equal(resolveRequests, 2);
    assert.equal(channelRequests, 2);
});

test('youtube extract: shorts URLs are labeled as Shorts', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson(videoInfo()));

    const url = 'https://www.youtube.com/shorts/dQw4w9WgXcQ';
    const result = await provider.extract(createMessage(url), url, {});

    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Type' && field.value === 'Shorts'));
});

test('youtube extract: live videos are labeled as Live now and the type field can be hidden', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson({
        ...videoInfo(),
        liveNow: true,
    }));

    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = await provider.extract(createMessage(url), url, {});

    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Type' && field.value === 'Live now'));

    const hiddenResult = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['type'],
    });

    assert.equal(hiddenResult[0].embeds[0].fields.some(field => field.name === 'Type'), false);
});

test('youtube extract: premieres are labeled as Premiere and the type field can be hidden', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson({
        ...videoInfo(),
        premiereTimestamp: 1800000000,
    }));

    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = await provider.extract(createMessage(url), url, {});

    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Type' && field.value === 'Premiere'));

    const hiddenResult = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['type'],
    });

    assert.equal(hiddenResult[0].embeds[0].fields.some(field => field.name === 'Type'), false);
});

test('youtube extract: honors the DB-backed description length setting', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson({
        ...videoInfo(),
        description: '0123456789abcdefghijklmnopqrstuvwxyz',
    }));

    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = await provider.extract(createMessage(url), url, {
        youtube_description_max_length: 10,
    });

    assert.equal(result[0].embeds[0].description, '0123456...');
});

test('youtube extract: can hide YouTube descriptions', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson({
        ...videoInfo(),
        description: 'This description should be hidden.',
    }));

    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = await provider.extract(createMessage(url), url, {
        youtube_description_max_length: 0,
    });

    assert.equal(result[0].embeds[0].description, undefined);
});

test('youtube extract: can re-enable the temporary download button with env flag', async () => {
    const oldEnabled = process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
    process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED = 'true';
    const provider = loadYouTubeProviderWithFetch(async () => okJson(videoInfo()));

    try {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const result = await provider.extract(createMessage(url), url, {});

        assert.deepEqual(
            result[0].components[0].components.map(button => button.data.custom_id),
            ['translate', 'downloadYouTubeVideo', 'delete:youtube']
        );
    } finally {
        if (oldEnabled === undefined) delete process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
        else process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED = oldEnabled;
    }
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

test('youtube extract: GUI output settings can hide stats and playlist video list', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson(playlistInfo()));

    const url = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    const result = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['stats', 'video_list'],
    });

    const embed = result[0].embeds[0];
    assert.equal(embed.description, 'Playlist description');
    assert.equal(embed.fields.some(field => field.name === 'Views'), false);
    assert.equal(embed.fields.some(field => field.name === 'Videos'), false);
});

test('youtube extract: video list count setting limits playlist items', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson({
        ...playlistInfo(),
        videos: Array.from({ length: 6 }, (_value, index) => ({
            title: `Listed video ${index + 1}`,
            videoId: `video${index + 1}`,
            videoThumbnails: [],
        })),
    }));

    const url = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    const result = await provider.extract(createMessage(url), url, {
        youtube_video_list_limit: 3,
    });

    const description = result[0].embeds[0].description;
    assert.match(description, /1\. Listed video 1/);
    assert.match(description, /3\. Listed video 3/);
    assert.doesNotMatch(description, /4\. Listed video 4/);
});

test('youtube extract: compact density and link-only media produce a lightweight playlist embed', async () => {
    const provider = loadYouTubeProviderWithFetch(async () => okJson(playlistInfo()));

    const url = 'https://www.youtube.com/playlist?list=PL123456789012345678';
    const result = await provider.extract(createMessage(url), url, {
        display_density: 'compact',
        media_display_mode: 'link_only',
    });

    const embed = result[0].embeds[0];
    assert.ok(embed.description.includes('Playlist description'));
    assert.ok(embed.description.includes('1. First video'));
    assert.ok(embed.description.includes('2. Second video'));
    assert.equal(embed.image, undefined);
    assert.match(result[0].content, /Thumbnail: https:\/\/i\.ytimg\.com\/vi\/one\/maxresdefault\.jpg/);
    assert.equal((embed.fields || []).some(field => field.name === 'Views'), false);
    assert.equal((embed.fields || []).some(field => field.name === 'Videos'), false);
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

test('youtube extract: reaches oEmbed after instance and page failures and retains analytics', async () => {
    const requests = [];
    const oldInstances = process.env.YOUTUBE_INVIDIOUS_INSTANCES;
    process.env.YOUTUBE_INVIDIOUS_INSTANCES = 'https://first.example,https://second.example';
    try {
        const provider = loadYouTubeProviderWithFetch(async url => {
            requests.push(url);
            if (url.startsWith('https://first.example')) return { ok: false, status: 503 };
            if (url.startsWith('https://second.example')) return okJson({ error: 'rate limit' });
            if (url.startsWith('https://www.youtube.com/watch?')) {
                return { ok: true, text: async () => '<html>No player data</html>' };
            }
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                return okJson({
                    title: 'oEmbed fallback',
                    author_name: 'Fallback channel',
                    author_url: 'https://www.youtube.com/@fallback',
                    thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
                });
            }
            throw new Error(`unexpected url ${url}`);
        });
        const url = 'https://youtu.be/dQw4w9WgXcQ';
        const result = await provider.extract(createMessage(url), url, { hidden_output_items: ['stats'] });

        assert.deepEqual(requests.map(value => new URL(value).hostname), [
            'first.example', 'second.example', 'www.youtube.com', 'www.youtube.com',
        ]);
        assert.equal(new URL(requests[2]).pathname, '/watch');
        assert.equal(new URL(requests[3]).pathname, '/oembed');
        assert.equal(result[0].embeds[0].title, 'oEmbed fallback');
        assert.equal(result[0].analytics.content.contentId, 'dQw4w9WgXcQ');
        assert.equal(result[0].analytics.content.contentType, 'video');
        assert.equal(result[0].analytics.content.authorName, 'Fallback channel');
        assert.deepEqual(result[0].analytics.metrics, {});
    } finally {
        if (oldInstances === undefined) delete process.env.YOUTUBE_INVIDIOUS_INSTANCES;
        else process.env.YOUTUBE_INVIDIOUS_INSTANCES = oldInstances;
    }
});

test('youtube extract: hidden stats retain native analytics and reloaded clients keep their transport', async () => {
    let firstRequests = 0;
    let secondRequests = 0;
    const first = loadYouTubeProviderWithFetch(async () => {
        firstRequests++;
        return okJson(videoInfo());
    });
    const second = loadYouTubeProviderWithFetch(async () => {
        secondRequests++;
        return okJson({ ...videoInfo(), title: 'Second client', viewCount: 42 });
    });
    const url = 'https://youtu.be/dQw4w9WgXcQ';
    const settings = { hidden_output_items: ['stats'] };
    const [firstResult, secondResult] = await Promise.all([
        first.extract(createMessage(url), url, settings),
        second.extract(createMessage(url), url, settings),
    ]);

    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 1);
    assert.equal(firstResult[0].embeds[0].title, 'Example Video');
    assert.equal(secondResult[0].embeds[0].title, 'Second client');
    assert.equal(firstResult[0].embeds[0].fields.some(field => field.name === 'Views'), false);
    assert.equal(firstResult[0].analytics.metrics.views, 1234567);
    assert.equal(secondResult[0].analytics.metrics.views, 42);
});

test('youtube prefetch reuses the source while applying current reply and deletion settings', async () => {
    let count = 0;
    const provider = loadYouTubeProviderWithFetch(async () => { count++; return okJson(videoInfo()); });
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const prefetched = await provider.prefetch(url);
    const fetched = count;
    const steps = await provider.extract(createMessage(url), url, {
        alwaysreplyifpostedtweetlink: true, deletemessageifonlypostedtweetlink: true,
    }, { [provider.prefetchOption]: prefetched });
    assert.equal(count, fetched);
    assert.equal(steps[0].send, 'reply-source');
    assert.equal(steps[0].deleteSource, true);
    assert.match(steps[0].embeds[0].title, /Example Video/);
});
