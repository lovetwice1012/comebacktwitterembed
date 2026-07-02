'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const twitterModulePath = require.resolve('../../src/providers/twitter');
const fetchModulePath = require.resolve('node-fetch');
const errorTrackingModulePath = require.resolve('../../src/errorTracking');

function loadTwitterProviderWithFetch(fetchImpl, errorTrackingExports = null) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalTwitterModule = require.cache[twitterModulePath];
    const originalErrorTrackingModule = require.cache[errorTrackingModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fetchImpl,
    };
    if (errorTrackingExports) {
        require.cache[errorTrackingModulePath] = {
            id: errorTrackingModulePath,
            filename: errorTrackingModulePath,
            loaded: true,
            exports: errorTrackingExports,
        };
    }
    delete require.cache[twitterModulePath];

    try {
        return require(twitterModulePath);
    } finally {
        delete require.cache[twitterModulePath];
        if (originalTwitterModule) require.cache[twitterModulePath] = originalTwitterModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
        if (errorTrackingExports) {
            if (originalErrorTrackingModule) require.cache[errorTrackingModulePath] = originalErrorTrackingModule;
            else delete require.cache[errorTrackingModulePath];
        }
    }
}

function loadTwitterProviderWithTweets(tweetsById) {
    return loadTwitterProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        if (rawUrl.includes('altterx.sprink.cloud')) {
            return { text: async () => 'ok' };
        }
        const id = rawUrl.match(/status\/(\d+)/)?.[1];
        const tweet = tweetsById[id];
        if (!tweet) throw new Error(`No tweet fixture for ${rawUrl}`);
        return { text: async () => JSON.stringify(tweet) };
    });
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

test('twitter extract: fxtwitter fallback keeps the normalized status URL', async () => {
    const requestedUrls = [];
    const provider = loadTwitterProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        requestedUrls.push(rawUrl);
        if (rawUrl.includes('altterx.sprink.cloud')) {
            return { text: async () => 'ok' };
        }
        if (rawUrl.includes('api.vxtwitter.com')) {
            return { text: async () => '<html>temporary error</html>' };
        }
        return { text: async () => JSON.stringify(createTweet('1')) };
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1/photo/1', {
        legacy_mode: false,
    });

    assert.ok(Array.isArray(result));
    assert.deepEqual(requestedUrls.slice(0, 2), [
        'https://api.vxtwitter.com/a/status/1',
        'https://api.fxtwitter.com/a/status/1',
    ]);
});

test('twitter extract: expected inaccessible tweets are skipped without error tracking', async () => {
    let recordedErrors = 0;
    const provider = loadTwitterProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        assert.match(rawUrl, /api\.vxtwitter\.com/);
        return {
            text: async () => JSON.stringify({
                error: 'This Tweet is unavailable because it may contain sensitive content or requires login.',
            }),
        };
    }, {
        recordProviderError: () => {
            recordedErrors++;
        },
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
    });

    assert.equal(result, null);
    assert.equal(recordedErrors, 0);
});

test('twitter extract: forceSendMode overrides alwaysreply for command-driven sends', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1'),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        alwaysreplyifpostedtweetlink: true,
    }, { forceSendMode: 'channel' });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].send, 'channel');
});

test('twitter extract: GUI output settings control text, stats, and quote layout', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { qrtURL: 'https://twitter.com/a/status/2', replies: 1, retweets: 2, likes: 3 }),
        2: createTweet('2'),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        twitter_text_mode: 'link_only',
        hidden_output_items: ['stats'],
        twitter_quote_layout: 'inline',
        quote_repost_do_not_extract: false,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].embeds.length, 2);
    assert.equal(result[0].embeds[0].description, '[View on Twitter](https://twitter.com/a/status/1)');
    assert.doesNotMatch(result[0].embeds[0].description, /likes/);
    assert.match(result[0].embeds[1].title, /^Quoted tweet: User 2/);
});

test('twitter extract: stats_layout fields moves stats out of the description', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { replies: 1, retweets: 2, likes: 3 }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        twitter_stats_layout: 'fields',
    });

    assert.ok(Array.isArray(result));
    assert.doesNotMatch(result[0].embeds[0].description, /likes/);
    assert.deepEqual(result[0].embeds[0].fields.map(field => [field.name, field.value]), [
        ['Replies', '1'],
        ['Reposts', '2'],
        ['Likes', '3'],
    ]);
});

test('twitter extract: media count and type fields can be shown or hidden', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', {
            mediaURLs: [
                'https://pbs.twimg.com/media/one.jpg',
                'https://video.twimg.com/ext_tw_video/two.mp4',
                'https://video.twimg.com/tweet_video/three.mp4',
            ],
            media_extended: [
                { type: 'photo' },
                { type: 'video' },
                { type: 'animated_gif' },
            ],
        }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
    });

    assert.ok(Array.isArray(result));
    assert.deepEqual(result[0].embeds[0].fields.map(field => [field.name, field.value]), [
        ['Media count', '3'],
        ['Media type', 'Image x1, Video x1, GIF x1'],
    ]);

    const hidden = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        hidden_output_items: ['media_count', 'media_type'],
    });

    assert.ok(Array.isArray(hidden));
    assert.equal(hidden[0].embeds[0].fields, undefined);
});

test('twitter extract: sensitive media flag can be shown or hidden', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', {
            mediaURLs: ['https://pbs.twimg.com/media/one.jpg'],
            possibly_sensitive: true,
        }),
    });

    const visible = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
    });

    assert.ok(Array.isArray(visible));
    assert.ok(visible[0].embeds[0].fields.some(field => field.name === 'Sensitive media' && field.value === 'Yes'));

    const hidden = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        hidden_output_items: ['sensitive_media'],
    });

    assert.ok(Array.isArray(hidden));
    assert.equal(hidden[0].embeds[0].fields.some(field => field.name === 'Sensitive media'), false);
});

test('twitter extract: article card output items can be hidden individually', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', {
            article: {
                title: 'Article title',
                preview_text: 'Article preview',
                image: 'https://example.com/article.jpg',
            },
        }),
    });

    const partial = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        hidden_output_items: ['article_preview', 'article_image'],
    });

    assert.ok(Array.isArray(partial));
    assert.match(partial[0].embeds[0].description, /Article title/);
    assert.doesNotMatch(partial[0].embeds[0].description, /Article preview/);
    assert.equal(partial[0].embeds[0].image, undefined);

    const hidden = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        hidden_output_items: ['article_card'],
    });

    assert.ok(Array.isArray(hidden));
    assert.doesNotMatch(hidden[0].embeds[0].description, /Article title/);
    assert.doesNotMatch(hidden[0].embeds[0].description, /Article preview/);
    assert.equal(hidden[0].embeds[0].image, undefined);
});

test('twitter extract: quote display mode can summarize or hide quoted tweets', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2', { qrtURL: 'https://twitter.com/a/status/3' }),
        3: createTweet('3'),
    });

    const summary = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        twitter_quote_mode: 'summary',
        twitter_quote_layout: 'inline',
        quote_repost_do_not_extract: false,
    });

    assert.ok(Array.isArray(summary));
    assert.equal(summary.length, 1);
    assert.equal(summary[0].embeds.length, 2);
    assert.match(summary[0].embeds[1].title, /^Quoted tweet: User 2/);
    assert.equal(summary[0].embeds[1].image, undefined);

    const hidden = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        twitter_quote_mode: 'hidden',
        quote_repost_do_not_extract: false,
    });

    assert.ok(Array.isArray(hidden));
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].embeds.length, 1);
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

test('twitter extract: display density and media display mode reshape tweet output', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', {
            mediaURLs: ['https://pbs.twimg.com/media/one.jpg'],
            replies: 1,
            retweets: 2,
            likes: 3,
        }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        display_density: 'compact',
        media_display_mode: 'link_only',
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].embeds[0].image, undefined);
    assert.match(result[0].content, /Media: https:\/\/pbs\.twimg\.com\/media\/one\.jpg/);
    assert.doesNotMatch(result[0].embeds[0].description, /likes/);
    assert.equal(result[0].embeds[0].fields, undefined);
    const customIds = result[0].components.flatMap(row => row.components.map(button => button.data.custom_id));
    assert.equal(customIds.includes('showMediaAsAttachments'), false);
});

test('twitter extract: attachment mode prunes media-only embeds while keeping metadata', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', {
            mediaURLs: [
                'https://pbs.twimg.com/media/one.jpg',
                'https://pbs.twimg.com/media/two.jpg',
            ],
        }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        media_display_mode: 'attachment',
        alwaysreplyifpostedtweetlink: true,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].send, 'reply-source');
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].title, 'User 1');
    assert.equal(result[0].embeds[0].image, undefined);
    assert.deepEqual(result[0].files, [
        'https://pbs.twimg.com/media/one.jpg',
        'https://pbs.twimg.com/media/two.jpg',
    ]);
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

test('twitter extract: account quote depth override applies to matching tweet author', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { user_screen_name: 'special', qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2', { qrtURL: 'https://twitter.com/a/status/3' }),
        3: createTweet('3'),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true,
        quote_repost_do_not_extract: true,
        quote_repost_depth_by_account: { special: 1 },
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[1].embeds[0].url, 'https://twitter.com/a/status/2');
});
