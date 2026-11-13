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

function manyImages(count) {
    return Array.from({ length: count }, (_, index) => `https://pbs.twimg.com/media/image-${index + 1}.jpg`);
}

test('twitter extract: 10, 11 and 20 photos remain ordered in consecutive Discord-sized messages', async () => {
    for (const count of [10, 11, 20]) {
        const images = manyImages(count);
        const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: images }) });
        const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
            legacy_mode: true, alwaysreplyifpostedtweetlink: true,
        });
        assert.equal(steps.length, Math.ceil(count / 10));
        assert.deepEqual(steps.flatMap(step => step.files || []), images);
        assert.ok(steps.every(step => (step.files || []).length <= 10));
        assert.equal(steps[0].send, 'reply-source');
        assert.equal(steps[0].embeds.length, 1);
        assert.match(steps[0].embeds[0].description, /tweet 1/);
        for (let index = 0; index < steps.length; index++) {
            assert.deepEqual(steps[index].twitterGrid, {
                imageUrls: images.slice(index * 10, index * 10 + 10), sequence: index, totalParts: steps.length,
                ...(index === 0 ? { embedStart: 0, embedEnd: 1 } : {}),
            });
            if (index > 0) {
                assert.equal(steps[index].send, 'channel');
                assert.equal(steps[index].requiresPreviousSuccess, true);
                assert.equal(steps[index].embeds, undefined);
                assert.equal(steps[index].components, undefined);
            }
        }
    }
});

test('twitter extract: attachment display also splits all images without duplicate or lost media', async () => {
    const images = manyImages(20);
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: images }) });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true, media_display_mode: 'attachment',
    });
    assert.equal(steps.length, 2);
    assert.deepEqual(steps.map(step => step.files.length), [10, 10]);
    assert.deepEqual(steps.flatMap(step => step.files), images);
    assert.deepEqual(steps.flatMap(step => step.twitterGrid.imageUrls), images);
});

test('twitter extract: automatic DM and partial guild contexts split photos without assuming Bot permissions', async () => {
    const images = manyImages(20);
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: images }) });
    for (const guild of [null, { id: 'guild-1' }, { id: 'guild-1', members: {} }]) {
        for (const legacyMode of [undefined, true, false]) {
            const message = createMessage(); message.guild = guild;
            const steps = await provider.extract(message, 'https://twitter.com/a/status/1', { legacy_mode: legacyMode });
            assert.equal(steps.length, 2);
            assert.deepEqual(steps.flatMap(step => step.files), images);
            assert.ok(steps.every(step => !step.suppressSourceEmbeds));
        }
    }
});

test('twitter extract: a guild Bot with ManageMessages still suppresses the source in legacy mode', async () => {
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: manyImages(20) }) });
    const message = createMessage();
    message.guild.members.me.permissions.has = () => true;
    for (const legacyMode of [undefined, true]) {
        const steps = await provider.extract(message, 'https://twitter.com/a/status/1', { legacy_mode: legacyMode });
        assert.equal(steps[0].suppressSourceEmbeds, true);
        assert.equal(steps[1].suppressSourceEmbeds, undefined);
    }
});

test('twitter extract: link-only and thumbnail-only policies never offer hidden images to the grid', async () => {
    const images = manyImages(20);
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: images }) });
    for (const mode of ['link_only', 'thumbnail_only']) {
        const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
            legacy_mode: true, media_display_mode: mode,
        });
        assert.equal(steps.length, 1);
        assert.equal((steps[0].files || []).length, 0);
        assert.equal(steps[0].twitterGrid, undefined);
    }
});

test('twitter extract: long link-only media lists remain within Discord message limits', async () => {
    const images = Array.from({ length: 20 }, (_, index) =>
        `https://pbs.twimg.com/media/${'a'.repeat(50)}${index}?format=jpg&name=orig`);
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: images }) });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true, media_display_mode: 'link_only',
    });
    assert.ok(steps.length > 1);
    assert.ok(steps.every(step => step.content.length <= 2000 && step.twitterGrid === undefined));
    const text = steps.map(step => step.content).join('\n');
    for (const url of images) assert.ok(text.includes(url));
    assert.ok(steps.slice(1).every(step => step.requiresPreviousSuccess === true));
});

test('twitter extract: grid metadata follows visible image parts and excludes videos', async () => {
    const video = Array.from({ length: 9 }, (_, index) => `https://video.twimg.com/ext_tw_video/${index}/clip.mp4`);
    const images = manyImages(2);
    const media = [...video, ...images];
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: media }) });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', { legacy_mode: true });
    assert.deepEqual(steps.map(step => step.files.length), [10, 1]);
    assert.deepEqual(steps[0].twitterGrid.imageUrls, [images[0]]);
    assert.deepEqual(steps[1].twitterGrid.imageUrls, [images[1]]);
});

test('twitter extract: image IDs containing video-extension text remain photos', async () => {
    const images = ['https://pbs.twimg.com/media/ABCtsDEF?format=jpg&name=orig',
        'https://pbs.twimg.com/media/XYZgifABC.jpg', 'https://pbs.twimg.com/media/Kmp4L.png',
        'https://pbs.twimg.com/media/nsvMedia.avif'];
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: images }) });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true, secondary_extract_mode: true, secondary_extract_mode_multiple_images: true, secondary_extract_mode_video: false,
    });
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0].twitterGrid.imageUrls, images);
    assert.deepEqual(steps[0].embeds.slice(1).map(embed => embed.image.url), images);
});

test('twitter extract: actual video and GIF extensions remain distinct from photos', async () => {
    const image = 'https://pbs.twimg.com/media/containsmp4.jpg';
    const video = 'https://video.twimg.com/ext_tw_video/1/clip.mp4?tag=29';
    const gif = 'https://pbs.twimg.com/media/animated.gif';
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: [image, video, gif] }) });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', { legacy_mode: true });
    assert.deepEqual(steps[0].files, [video, gif]);
    assert.equal(steps[0].twitterGrid, undefined);
    assert.deepEqual(steps[0].embeds.map(embed => embed.image?.url).filter(Boolean), [image]);
});

test('twitter extract: a later photo-only part has its own grid when the first contains only video', async () => {
    const video = Array.from({ length: 10 }, (_, index) => `https://video.twimg.com/ext_tw_video/${index}/clip.mp4`);
    const images = manyImages(2);
    const provider = loadTwitterProviderWithTweets({ 1: createTweet('1', { mediaURLs: [...video, ...images] }) });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', { legacy_mode: true });
    assert.equal(steps[0].twitterGrid, undefined);
    assert.deepEqual(steps[1].twitterGrid, { imageUrls: images, sequence: 0, totalParts: 1, embedStart: 0, embedEnd: 0 });
    assert.deepEqual(steps.flatMap(step => step.files), [...video, ...images]);
});

test('twitter extract: grid metadata uses visible embed images but never a single image', async () => {
    const images = manyImages(4);
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: images }),
        2: createTweet('2', { mediaURLs: images.slice(0, 1) }),
    });
    const many = await provider.extract(createMessage('1'), 'https://twitter.com/a/status/1', { legacy_mode: true });
    assert.equal(many.length, 1);
    assert.deepEqual(many[0].twitterGrid, { imageUrls: images, sequence: 0, totalParts: 1, embedStart: 0, embedEnd: 5 });
    assert.deepEqual(many[0].embeds.slice(1).map(embed => embed.image.url), images);
    const one = await provider.extract(createMessage('2'), 'https://twitter.com/a/status/2', { legacy_mode: true });
    assert.equal(one[0].twitterGrid, undefined);
});

test('twitter extract: a quoted post has its own ordered image parts after the parent', async () => {
    const images = manyImages(20);
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2', { mediaURLs: images }),
    });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true, defaultLanguage: 'ja', quote_repost_do_not_extract: false, twitter_quote_layout: 'inline',
    });
    assert.equal(steps.length, 3);
    assert.equal(steps[1].send, 'reply-previous');
    assert.equal(steps[1].content, '引用ツイート:');
    assert.deepEqual(steps.slice(1).flatMap(step => step.files), images);
    assert.deepEqual(steps.slice(1).map(step => step.twitterGrid.sequence), [0, 1]);
});

test('twitter extract: inline quoted image groups remain separate from the parent and each other', async () => {
    const parentImages = manyImages(2), firstQuoteImages = manyImages(2).map(url => url.replace('image-', 'quote-a-'));
    const secondQuoteImages = manyImages(2).map(url => url.replace('image-', 'quote-b-'));
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: parentImages, qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2', { mediaURLs: firstQuoteImages, qrtURL: 'https://twitter.com/a/status/3' }),
        3: createTweet('3', { mediaURLs: secondQuoteImages }),
    });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true, quote_repost_do_not_extract: false, twitter_quote_layout: 'inline',
    });
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0].twitterGrid.imageUrls, parentImages);
    assert.deepEqual([steps[0].twitterGrid.embedStart, steps[0].twitterGrid.embedEnd], [0, 3]);
    assert.deepEqual(steps[0].twitterGridInline.map(group => group.imageUrls), [firstQuoteImages, secondQuoteImages]);
    assert.deepEqual(steps[0].twitterGridInline.map(group => [group.embedStart, group.embedEnd]), [[3, 6], [6, 9]]);
    const allEmbedUrls = steps[0].embeds.map(embed => embed.image?.url).filter(Boolean);
    assert.deepEqual(allEmbedUrls, [...parentImages, ...firstQuoteImages, ...secondQuoteImages]);
});

test('twitter extract: identical parent and inline-quote URLs retain distinct embed ranges', async () => {
    const images = manyImages(2);
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: images, qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2', { mediaURLs: images }),
    });
    const [step] = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true, quote_repost_do_not_extract: false, twitter_quote_layout: 'inline',
    });
    assert.deepEqual(step.twitterGrid.imageUrls, images);
    assert.deepEqual(step.twitterGridInline[0].imageUrls, images);
    assert.deepEqual([step.twitterGrid.embedStart, step.twitterGrid.embedEnd], [0, 3]);
    assert.deepEqual([step.twitterGridInline[0].embedStart, step.twitterGridInline[0].embedEnd], [3, 6]);
});

test('twitter extract: inline mode preserves quoted link-only media instead of dropping its content', async () => {
    const quoted = manyImages(4);
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { qrtURL: 'https://twitter.com/a/status/2' }),
        2: createTweet('2', { mediaURLs: quoted }),
    });
    const steps = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: true, media_display_mode: 'link_only', twitter_quote_layout: 'inline',
    });
    assert.equal(steps.length, 2);
    assert.equal(steps[1].send, 'reply-previous');
    for (const url of quoted) assert.ok(steps[1].content.includes(url));
});

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

test('secondary mode never forces skipped sensitive or single-image content into Bot output', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: ['https://pbs.twimg.com/media/one.jpg'], possibly_sensitive: true }),
        2: createTweet('2', { mediaURLs: ['https://pbs.twimg.com/media/two.jpg'], possibly_sensitive: false }),
    });
    for (const id of ['1', '2']) {
        const message = createMessage(id); message.flags = { bitfield: 0 }; message.embeds = [];
        assert.equal(await provider.extract(message, `https://twitter.com/a/status/${id}`, {
            legacy_mode: false, secondary_extract_mode: true,
            secondary_extract_mode_multiple_images: true, secondary_extract_mode_video: true,
        }), null);
    }
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

test('twitter extract: delete source accepts whitespace around an only-url message', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1'),
    });
    const message = createMessage();
    message.content = '\n  https://twitter.com/a/status/1  \n';

    const result = await provider.extract(message, 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        deletemessageifonlypostedtweetlink: true,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].deleteSource, true);
});

test('twitter extract: secondary mode deletes link-only source when secondary delete is enabled', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: ['https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/video.mp4'] }),
    });

    const result = await provider.extract(createMessage('1'), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: true,
        deletemessageifonlypostedtweetlink: true,
        deletemessageifonlypostedtweetlink_secoundaryextractmode: true,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].deleteSource, true);
    assert.equal(result[0].suppressSourceEmbeds, undefined);
});

test('twitter extract: secondary mode leaves link-only source when secondary delete is disabled', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: ['https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/video.mp4'] }),
    });

    const result = await provider.extract(createMessage(), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: true,
        deletemessageifonlypostedtweetlink: true,
        deletemessageifonlypostedtweetlink_secoundaryextractmode: false,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].deleteSource, undefined);
    assert.equal(result[0].suppressSourceEmbeds, undefined);
});

test('twitter extract: secondary mode can suppress link-only source preview without deleting the source', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: ['https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/video.mp4'] }),
        2: createTweet('2', {
            mediaURLs: [
                'https://pbs.twimg.com/media/one.jpg',
                'https://pbs.twimg.com/media/two.jpg',
            ],
        }),
    });

    const video = await provider.extract(createMessage('1'), 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: true,
        suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode: true,
    });

    const multiImage = await provider.extract(createMessage('2'), 'https://twitter.com/a/status/2', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: true,
        suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode: true,
    });

    assert.ok(Array.isArray(video));
    assert.equal(video[0].deleteSource, undefined);
    assert.equal(video[0].suppressSourceEmbeds, true);
    assert.ok(Array.isArray(multiImage));
    assert.equal(multiImage[0].deleteSource, undefined);
    assert.equal(multiImage[0].suppressSourceEmbeds, true);
});

test('twitter extract: secondary preview suppression keeps source preview when matching tweet is posted with extra text', async () => {
    const provider = loadTwitterProviderWithTweets({
        1: createTweet('1', { mediaURLs: ['https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/video.mp4'] }),
    });
    const message = createMessage('1');
    message.content = `watch this https://twitter.com/a/status/1`;

    const result = await provider.extract(message, 'https://twitter.com/a/status/1', {
        legacy_mode: false,
        secondary_extract_mode: true,
        secondary_extract_mode_multiple_images: true,
        secondary_extract_mode_video: true,
        suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode: true,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].deleteSource, undefined);
    assert.equal(result[0].suppressSourceEmbeds, undefined);
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
