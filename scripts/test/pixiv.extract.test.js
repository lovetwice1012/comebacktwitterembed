'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pixivModulePath = require.resolve('../../src/providers/pixiv');
const fetchModulePath = require.resolve('node-fetch');

function loadPixivProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalPixivModule = require.cache[pixivModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[pixivModulePath];

    try {
        return require(pixivModulePath);
    } finally {
        delete require.cache[pixivModulePath];
        if (originalPixivModule) require.cache[pixivModulePath] = originalPixivModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

function createMessage() {
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content: 'https://www.pixiv.net/artworks/123456',
    };
}

function createInfo(imageCount) {
    return {
        title: 'sample',
        description: 'desc',
        url: 'https://www.pixiv.net/artworks/123456',
        author_name: 'artist',
        author_id: '77',
        tags: ['#tag'],
        image_proxy_urls: Array.from({ length: imageCount }, (_, index) => `https://i.example/${index + 1}.jpg`),
    };
}

test('pixiv extract: default mode shows 4 images in a single message', async () => {
    const provider = loadPixivProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(55),
    }));

    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {});

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1, 'should be a single message');
    assert.equal(result[0].embeds.length, 4, 'first (only) message has 4 embeds');
    assert.equal(result[0].send, 'channel');
    // 1枚目のembedのみメタデータを持つ
    assert.ok(result[0].embeds[0].title, 'first embed has title');
    assert.ok(!result[0].embeds[1].title, 'second embed has no title');
    assert.equal(result[0].embeds[0].fields.find(f => f.name === 'Pages').value, '1-4 / 55');
});

test('pixiv extract: 10-image mode shows 10 images in a single message', async () => {
    const provider = loadPixivProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(120),
    }));

    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', { pixiv_images_per_step: 10 });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1, 'should be a single message');
    assert.equal(result[0].embeds.length, 10, '10-image mode has 10 embeds');
    assert.equal(result[0].embeds[0].fields.find(f => f.name === 'Pages').value, '1-10 / 120');
    // 2枚目以降はメタデータなし
    assert.ok(!result[0].embeds[1].title, 'second embed has no title');
    assert.ok(!result[0].embeds[9].title, '10th embed has no title');
    // url は 4枚ごとにグループ化される (Discord の同URL ギャラリー上限)
    const urls = result[0].embeds.map(e => e.url);
    assert.equal(urls[0], urls[1], 'images 1-2 same group');
    assert.equal(urls[0], urls[3], 'images 1-4 same group');
    assert.notEqual(urls[3], urls[4], 'image 5 starts new group');
    assert.equal(urls[4], urls[7], 'images 5-8 same group');
    assert.notEqual(urls[7], urls[8], 'image 9 starts new group');
    assert.equal(urls[8], urls[9], 'images 9-10 same group');
});

test('pixiv extract: shows fewer embeds when image count is less than mode limit', async () => {
    const provider = loadPixivProviderWithFetch(async () => ({
        ok: true,
        json: async () => createInfo(3),
    }));

    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {});

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].embeds.length, 3, 'shows all 3 available images');
    assert.equal(result[0].embeds[0].fields.find(f => f.name === 'Pages').value, '1-3 / 3');
});