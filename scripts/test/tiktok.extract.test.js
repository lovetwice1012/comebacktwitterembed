'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tiktokModulePath = require.resolve('../../src/providers/tiktok');
const fetchModulePath = require.resolve('node-fetch');

function loadTikTokProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalTikTokModule = require.cache[tiktokModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[tiktokModulePath];

    try {
        return require(tiktokModulePath);
    } finally {
        delete require.cache[tiktokModulePath];
        if (originalTikTokModule) require.cache[tiktokModulePath] = originalTikTokModule;
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

function pageHtml(itemStruct) {
    return [
        '<html><head></head><body>',
        '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">',
        JSON.stringify({
            __DEFAULT_SCOPE__: {
                'webapp.video-detail': {
                    itemInfo: { itemStruct },
                },
            },
        }),
        '</script>',
        '</body></html>',
    ].join('');
}

function createVideoData(overrides = {}) {
    return {
        id: '7332187682480590112',
        desc: 'sample caption #tag',
        createTime: '1710000000',
        author: {
            nickname: 'Creator',
            uniqueId: 'creator',
            avatarMedium: 'https://image.example/avatar.jpg',
        },
        stats: {
            playCount: 1200,
            diggCount: 34,
            commentCount: 5,
            shareCount: 6,
        },
        video: {
            duration: 12,
            width: 720,
            height: 1280,
            cover: 'https://image.example/cover.jpg',
            PlayAddrStruct: {
                UrlList: ['https://video.example/play'],
            },
        },
        ...overrides,
    };
}

test('tiktok extract: builds self-owned embed and video attachment without reposting edited url', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@i/video/7332187682480590112') {
            return { text: async () => pageHtml(createVideoData()) };
        }
        if (requestUrl === 'https://video.example/play') {
            return {
                status: 302,
                headers: { get: name => name.toLowerCase() === 'location' ? 'https://cdn.example/video.mp4' : null },
            };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://www.tiktok.com/@creator/video/7332187682480590112?is_from_webapp=1';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result.length, 1);
    assert.equal(result[0].content, undefined);
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].title, 'Creator (@creator)');
    assert.equal(result[0].embeds[0].url, 'https://www.tiktok.com/@creator/video/7332187682480590112');
    assert.equal(result[0].embeds[0].thumbnail.url, 'https://image.example/cover.jpg');
    assert.deepEqual(result[0].files, ['https://cdn.example/video.mp4']);
    assert.equal(result[0].send, 'channel');
    assert.equal(result[0].suppressSourceEmbeds, true);
});

test('tiktok extract: builds image embeds for photo posts', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@i/video/7335753580093164833') {
            return {
                text: async () => pageHtml(createVideoData({
                    id: '7335753580093164833',
                    video: { duration: 0 },
                    imagePost: {
                        images: [
                            { imageURL: { urlList: ['https://image.example/1.jpg'] } },
                            { imageURL: { urlList: ['https://image.example/2.jpg'] } },
                        ],
                    },
                })),
            };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://www.tiktok.com/@creator/photo/7335753580093164833';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].content, undefined);
    assert.deepEqual(result[0].files, []);
    assert.equal(result[0].embeds.length, 2);
    assert.equal(result[0].embeds[0].image.url, 'https://image.example/1.jpg');
    assert.equal(result[0].embeds[1].image.url, 'https://image.example/2.jpg');
    assert.equal(result[0].embeds[0].url, 'https://www.tiktok.com/@creator/photo/7335753580093164833');
});

test('tiktok extract: resolves short links internally before scraping', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://vm.tiktok.com/ZPRKrbUB1/') {
            return {
                headers: {
                    get: name => name.toLowerCase() === 'location'
                        ? 'https://www.tiktok.com/@creator/video/7332187682480590112'
                        : null,
                },
            };
        }
        if (requestUrl === 'https://www.tiktok.com/@i/video/7332187682480590112') {
            return { text: async () => pageHtml(createVideoData()) };
        }
        if (requestUrl === 'https://video.example/play') {
            return { status: 200, headers: { get: () => null } };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://vm.tiktok.com/ZPRKrbUB1/';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].content, undefined);
    assert.equal(result[0].embeds[0].url, 'https://www.tiktok.com/@creator/video/7332187682480590112');
    assert.deepEqual(result[0].files, ['https://video.example/play']);
});

test('tiktok extract: honors reply and delete source settings', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@i/video/7332187682480590112') {
            return { text: async () => pageHtml(createVideoData()) };
        }
        if (requestUrl === 'https://video.example/play') {
            return { status: 200, headers: { get: () => null } };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://www.tiktok.com/@creator/video/7332187682480590112';
    const result = await provider.extract(createMessage(url), url, {
        alwaysreplyifpostedtweetlink: true,
        deletemessageifonlypostedtweetlink: true,
    });

    assert.equal(result[0].send, 'reply-source');
    assert.equal(result[0].deleteSource, true);
});

test('tiktok parser: rejects non-tiktok urls', () => {
    const provider = loadTikTokProviderWithFetch(async () => {
        throw new Error('fetch should not be called');
    });
    assert.equal(provider._internal.parseTikTokUrl('https://example.com/@user/video/1'), null);
});
