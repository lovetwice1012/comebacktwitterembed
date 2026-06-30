'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const niconicoModulePath = require.resolve('../../src/providers/niconico');
const apiModulePath = require.resolve('../../src/niconicoApi');
const fetchModulePath = require.resolve('node-fetch');

function loadNiconicoProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalApiModule = require.cache[apiModulePath];
    const originalNiconicoModule = require.cache[niconicoModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[apiModulePath];
    delete require.cache[niconicoModulePath];

    try {
        return require(niconicoModulePath);
    } finally {
        delete require.cache[niconicoModulePath];
        delete require.cache[apiModulePath];
        if (originalNiconicoModule) require.cache[niconicoModulePath] = originalNiconicoModule;
        if (originalApiModule) require.cache[apiModulePath] = originalApiModule;
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
    return { ok: true, json: async () => json, headers: { raw: () => ({}) } };
}

function watchData() {
    return {
        client: {
            watchId: 'sm9',
            watchTrackId: 'track-1',
        },
        video: {
            id: 'sm9',
            title: 'Niconico Test Video',
            description: 'A <b>great</b> description &amp; details',
            count: {
                view: 1234567,
                comment: 2345,
                mylist: 345,
                like: 456,
            },
            duration: 194,
            thumbnail: {
                ogp: 'https://nicovideo.cdn.nimg.jp/thumbnails/9/9.12345.M',
            },
            registeredAt: '2007-03-06T00:33:00+09:00',
        },
        owner: {
            id: 42,
            nickname: 'Example Uploader',
            iconUrl: 'https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/0/42.jpg',
        },
        series: {
            title: 'Example Series',
        },
        genre: {
            label: 'Entertainment',
        },
        tag: {
            items: [
                { name: 'VOCALOID' },
                { name: 'Test Tag' },
            ],
        },
        media: {
            domand: {
                accessRightKey: 'access-key',
                videos: [],
                audios: [],
            },
        },
    };
}

function watchResponse() {
    return {
        meta: { status: 200, code: 'HTTP_200' },
        data: { response: watchData() },
    };
}

test('niconico extract: builds a video embed from watch data with the download button by default', async () => {
    const oldEnabled = process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
    delete process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
    try {
        const requests = [];
        const provider = loadNiconicoProviderWithFetch(async (url) => {
            requests.push(url);
            assert.ok(url.includes('https://www.nicovideo.jp/watch/sm9?responseType=json'));
            return okJson(watchResponse());
        });

        const url = 'https://www.nicovideo.jp/watch/sm9?ref=share';
        const result = await provider.extract(createMessage(url), url, {});

        assert.equal(requests.length, 1);
        assert.equal(result.length, 1);
        const embed = result[0].embeds[0];
        assert.equal(embed.title, 'Niconico Test Video');
        assert.equal(embed.url, 'https://www.nicovideo.jp/watch/sm9');
        assert.equal(embed.author.name, 'Example Uploader');
        assert.equal(embed.description, 'A great description & details');
        assert.equal(embed.image.url, 'https://nicovideo.cdn.nimg.jp/thumbnails/9/9.12345.M');
        assert.ok(embed.fields.some(field => field.name === 'Views' && field.value === '1,234,567'));
        assert.ok(embed.fields.some(field => field.name === 'Duration' && field.value === '3:14'));
        assert.ok(embed.fields.some(field => field.name === 'Series' && field.value === 'Example Series'));
        assert.ok(embed.fields.some(field => field.name === 'Uploader' && field.value === 'User'));
        assert.ok(embed.fields.some(field => field.name === 'Genre' && field.value === 'Entertainment'));
        assert.ok(embed.fields.some(field => field.name === 'Tags' && field.value.includes('VOCALOID')));
        assert.ok(embed.footer.text.includes('tester(id:user-1)'));
        assert.deepEqual(
            result[0].components[0].components.map(button => button.data.custom_id),
            ['translate', 'downloadNiconicoVideo', 'delete:niconico']
        );
        assert.equal(result[0].send, 'channel');
        assert.equal(result[0].suppressSourceEmbeds, true);
    } finally {
        if (oldEnabled === undefined) delete process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
        else process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED = oldEnabled;
    }
});

test('niconico extract: can hide the temporary download button with env flag', async () => {
    const oldEnabled = process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
    process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED = 'false';
    const provider = loadNiconicoProviderWithFetch(async () => okJson(watchResponse()));

    try {
        const url = 'https://nico.ms/sm9';
        const result = await provider.extract(createMessage(url), url, {});

        assert.deepEqual(
            result[0].components[0].components.map(button => button.data.custom_id),
            ['translate', 'delete:niconico']
        );
    } finally {
        if (oldEnabled === undefined) delete process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
        else process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED = oldEnabled;
    }
});

test('niconico extract: honors reply, delete source, and anonymous settings', async () => {
    const provider = loadNiconicoProviderWithFetch(async () => okJson(watchResponse()));
    const url = 'https://www.nicovideo.jp/watch/sm9';
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

test('niconico extract: honors hidden output items and description length', async () => {
    const provider = loadNiconicoProviderWithFetch(async () => okJson(watchResponse()));
    const url = 'https://www.nicovideo.jp/watch/sm9';
    const result = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['views', 'comments', 'mylists', 'likes', 'duration', 'uploaded', 'series', 'owner', 'uploader', 'genre', 'tags'],
        niconico_description_max_length: 8,
    });

    const embed = result[0].embeds[0];
    assert.equal(embed.description, 'A gre...');
    assert.equal(embed.author.name, 'Niconico');
    assert.deepEqual(embed.fields, []);

    const noDescription = await provider.extract(createMessage(url), url, {
        niconico_description_max_length: 0,
    });

    assert.equal(noDescription[0].embeds[0].description, undefined);
});

test('niconico extract: compact density hides metadata fields and thumbnail_only uses thumbnail media', async () => {
    const provider = loadNiconicoProviderWithFetch(async () => okJson(watchResponse()));
    const url = 'https://www.nicovideo.jp/watch/sm9';
    const result = await provider.extract(createMessage(url), url, {
        display_density: 'compact',
        media_display_mode: 'thumbnail_only',
    });

    const embed = result[0].embeds[0];
    assert.deepEqual(embed.fields, []);
    assert.equal(embed.image, undefined);
    assert.equal(embed.thumbnail.url, 'https://nicovideo.cdn.nimg.jp/thumbnails/9/9.12345.M');
    assert.equal(result[0].files, undefined);
    assert.equal(result[0].content, undefined);
});

test('niconico parse: rejects non-niconico urls', () => {
    const provider = require('../../src/providers/niconico');
    assert.equal(provider._internal.parseNiconicoUrl('https://example.com/watch/sm9'), null);
});
