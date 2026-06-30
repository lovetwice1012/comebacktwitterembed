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

function hydrationHtml(defaultScope) {
    return [
        '<html><head></head><body>',
        '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">',
        JSON.stringify({ __DEFAULT_SCOPE__: defaultScope }),
        '</script>',
        '</body></html>',
    ].join('');
}

function videoPageHtml(itemStruct) {
    return hydrationHtml({
        'webapp.video-detail': {
            itemInfo: { itemStruct },
        },
    });
}

function profilePageHtml(userInfo) {
    return hydrationHtml({
        'webapp.user-detail': {
            userInfo,
        },
    });
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

function createProfileData(overrides = {}) {
    return {
        user: {
            nickname: 'Creator',
            uniqueId: 'creator',
            signature: 'profile bio',
            avatarMedium: 'https://image.example/avatar.jpg',
        },
        stats: {
            followerCount: 12345,
            followingCount: 67,
            heartCount: 890000,
            videoCount: 42,
        },
        ...overrides,
    };
}

test('tiktok extract: builds self-owned embed and video attachment without reposting edited url', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@i/video/7332187682480590112') {
            return { text: async () => videoPageHtml(createVideoData()) };
        }
        if (requestUrl === 'https://video.example/play') {
            return {
                ok: true,
                status: 200,
                headers: {
                    get: name => {
                        const key = name.toLowerCase();
                        if (key === 'content-type') return 'video/mp4';
                        if (key === 'content-length') return '9';
                        return null;
                    },
                },
                buffer: async () => Buffer.from('fakevideo'),
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
    assert.equal(result[0].files.length, 1);
    assert.ok(Buffer.isBuffer(result[0].files[0].attachment));
    assert.equal(result[0].files[0].attachment.toString(), 'fakevideo');
    assert.equal(result[0].files[0].name, 'tiktok-7332187682480590112.mp4');
    assert.equal(result[0].send, 'channel');
    assert.equal(result[0].suppressSourceEmbeds, true);
});

test('tiktok extract: builds image embeds for photo posts', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@i/video/7335753580093164833') {
            return {
                text: async () => videoPageHtml(createVideoData({
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

test('tiktok extract: skips access-denied video candidates and uploads a working buffer', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@i/video/7332187682480590112') {
            return {
                text: async () => videoPageHtml(createVideoData({
                    video: {
                        duration: 12,
                        cover: 'https://image.example/cover.jpg',
                        PlayAddrStruct: {
                            UrlList: [
                                'https://video.example/access-denied',
                                'https://video.example/working',
                            ],
                        },
                    },
                })),
            };
        }
        if (requestUrl === 'https://video.example/access-denied') {
            return {
                ok: false,
                status: 403,
                headers: { get: () => null },
                buffer: async () => Buffer.from('Access Denied'),
            };
        }
        if (requestUrl === 'https://video.example/working') {
            return {
                ok: true,
                status: 200,
                headers: { get: name => name.toLowerCase() === 'content-type' ? 'video/mp4' : null },
                buffer: async () => Buffer.from('workingvideo'),
            };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://www.tiktok.com/@creator/video/7332187682480590112';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].files.length, 1);
    assert.ok(Buffer.isBuffer(result[0].files[0].attachment));
    assert.equal(result[0].files[0].attachment.toString(), 'workingvideo');
});

test('tiktok extract: builds profile embeds for account links', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@creator') {
            return { text: async () => profilePageHtml(createProfileData()) };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://www.tiktok.com/@creator?lang=en';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].content, undefined);
    assert.deepEqual(result[0].files, undefined);
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].title, 'Creator (@creator)');
    assert.equal(result[0].embeds[0].url, 'https://www.tiktok.com/@creator');
    assert.equal(result[0].embeds[0].description, 'profile bio');
    assert.equal(result[0].embeds[0].thumbnail.url, 'https://image.example/avatar.jpg');
    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Followers' && field.value === '12.3K'));
    assert.equal(result[0].suppressSourceEmbeds, true);
});

test('tiktok extract: resolves short links to profile embeds', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://vm.tiktok.com/profilelink/') {
            return {
                headers: {
                    get: name => name.toLowerCase() === 'location'
                        ? 'https://www.tiktok.com/@creator'
                        : null,
                },
            };
        }
        if (requestUrl === 'https://www.tiktok.com/@creator') {
            return { text: async () => profilePageHtml(createProfileData()) };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://vm.tiktok.com/profilelink/';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].content, undefined);
    assert.equal(result[0].embeds[0].url, 'https://www.tiktok.com/@creator');
    assert.equal(result[0].embeds[0].title, 'Creator (@creator)');
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
            return { text: async () => videoPageHtml(createVideoData()) };
        }
        if (requestUrl === 'https://video.example/play') {
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                buffer: async () => Buffer.from('shortvideo'),
            };
        }
        throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    const url = 'https://vm.tiktok.com/ZPRKrbUB1/';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].content, undefined);
    assert.equal(result[0].embeds[0].url, 'https://www.tiktok.com/@creator/video/7332187682480590112');
    assert.equal(result[0].files.length, 1);
    assert.ok(Buffer.isBuffer(result[0].files[0].attachment));
    assert.equal(result[0].files[0].attachment.toString(), 'shortvideo');
});

test('tiktok extract: honors reply and delete source settings', async () => {
    const provider = loadTikTokProviderWithFetch(async (requestUrl) => {
        if (requestUrl === 'https://www.tiktok.com/@i/video/7332187682480590112') {
            return { text: async () => videoPageHtml(createVideoData()) };
        }
        if (requestUrl === 'https://video.example/play') {
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                buffer: async () => Buffer.from('settingsvideo'),
            };
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
