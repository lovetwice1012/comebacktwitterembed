'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const twitterModulePath = require.resolve('../../src/providers/twitter');
const fetchModulePath = require.resolve('node-fetch');

function loadTwitterProviderWithTweets(tweetsById) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalTwitterModule = require.cache[twitterModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: async (url) => {
            const rawUrl = String(url);
            if (rawUrl.includes('altterx.sprink.cloud')) {
                return { text: async () => 'ok' };
            }
            const id = rawUrl.match(/status\/(\d+)/)?.[1];
            const tweet = tweetsById[id];
            if (!tweet) throw new Error(`No tweet fixture for ${rawUrl}`);
            return { text: async () => JSON.stringify(tweet) };
        },
    };
    delete require.cache[twitterModulePath];

    try {
        return require(twitterModulePath);
    } finally {
        delete require.cache[twitterModulePath];
        if (originalTwitterModule) require.cache[twitterModulePath] = originalTwitterModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

function createMessage(id = '1') {
    return {
        guild: {
            id: 'guild-1',
            members: { me: { permissions: { has: () => false } } },
        },
        channel: { send: async () => ({}) },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content: `https://twitter.com/a/status/${id}`,
    };
}

function createTweet(id, overrides = {}) {
    return {
        tweetURL: `https://twitter.com/a/status/${id}`,
        text: `tweet ${id}`,
        user_name: `User ${id}`,
        user_screen_name: `user${id}`,
        replies: 0,
        retweets: 0,
        likes: 0,
        date: '2024-01-01T00:00:00Z',
        mediaURLs: [],
        qrtURL: null,
        ...overrides,
    };
}

test('twitter extract: secondary mode suppresses single-image tweet when target is multiple images/video', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: ['https://pbs.twimg.com/media/one.jpg'] }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: true,
    });

    assert.equal(result, null);
});

test('twitter extract: compact single-image tweet keeps bot embed image-free', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: ['https://pbs.twimg.com/media/one.jpg'] }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].image, undefined);
    assert.deepEqual(result[0].components[0].components.map(b => b.data.custom_id), ['delete']);
});

test('twitter extract: secondary mode can skip source tweet and expand matching quote tweet', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', {
            mediaURLs: ['https://pbs.twimg.com/media/one.jpg'],
            qrtURL: 'https://twitter.com/a/status/2',
        }),
        2: createTweet('2', {
            mediaURLs: [
                'https://pbs.twimg.com/media/two-a.jpg',
                'https://pbs.twimg.com/media/two-b.jpg',
            ],
        }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: false,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'Quoted tweet:');
    assert.equal(result[0].embeds[0].url, 'https://twitter.com/a/status/2');
});

test('twitter extract: secondary mode still sends article-only tweets', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', {
            article: {
                title: 'Article title',
                preview_text: 'Article preview',
            },
        }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: true,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].embeds[0].url, 'https://twitter.com/a/status/1');
});

test('twitter extract: quote_repost_max_depth 1 includes the first quote', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2'),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        quote_repost_max_depth: 1,
        quote_repost_do_not_extract: false,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[1].content, 'Quoted tweet:');
    assert.equal(result[1].embeds[0].url, 'https://twitter.com/a/status/2');
});

test('twitter extract: quote recursion continues through quoted tweets up to max depth', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2', { qrtURL: 'https://twitter.com/a/status/3' }),
        3: createTweet('3'),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        quote_repost_max_depth: 2,
        quote_repost_do_not_extract: false,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 3);
    assert.equal(result[1].embeds[0].url, 'https://twitter.com/a/status/2');
    assert.equal(result[2].embeds[0].url, 'https://twitter.com/a/status/3');
});
