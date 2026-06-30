'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const instagramModulePath = require.resolve('../../src/providers/instagram');
const fetchModulePath = require.resolve('node-fetch');

function loadInstagramProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalInstagramModule = require.cache[instagramModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[instagramModulePath];

    try {
        const provider = require(instagramModulePath);
        provider.__test._clearCache();
        return provider;
    } finally {
        delete require.cache[instagramModulePath];
        if (originalInstagramModule) require.cache[instagramModulePath] = originalInstagramModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

function createMessage(content = 'https://www.instagram.com/p/CODE123/') {
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content,
    };
}

function mediaNode(overrides = {}) {
    return {
        __typename: 'GraphImage',
        owner: { username: 'artist' },
        edge_media_to_caption: { edges: [{ node: { text: 'hello from instagram' } }] },
        display_url: 'https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/sample.jpg?sig=1',
        taken_at_timestamp: 1704067200,
        ...overrides,
    };
}

function embedHtml(node) {
    return `<html><body><script>window.__ig = ${JSON.stringify({ gql_data: { shortcode_media: node } })};</script></body></html>`;
}

function profileHtml({
    title = 'Artist Profile (&#064;artist.profile) &#x2022; Instagram profile',
    ogDescription = '3,456 Followers, 78 Following, 12 Posts - See Instagram photos and videos from Artist Profile (&#064;artist.profile)',
    description = '3,456 Followers, 78 Following, 12 Posts - Artist Profile (&#064;artist.profile) on Instagram: &quot;profile bio&quot;',
    image = 'https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-19/profile.jpg',
} = {}) {
    return `<html><head>
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${ogDescription}" />
        <meta name="description" content="${description}" />
        <meta property="og:image" content="${image}" />
    </head></html>`;
}

test('instagram extract: single image creates an embed without requiring an InstaFix server', async () => {
    const requestedUrls = [];
    const provider = loadInstagramProviderWithFetch(async (url) => {
        requestedUrls.push(String(url));
        return {
            ok: true,
            text: async () => embedHtml(mediaNode()),
        };
    });

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(requestedUrls[0], 'https://www.instagram.com/p/CODE123/embed/captioned/');
    assert.equal(result[0].send, 'channel');
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].title, '@artist');
    assert.equal(result[0].embeds[0].image.url.startsWith('https://scontent.cdninstagram.com/'), true);
    assert.equal(result[0].components[1].components[1].data.custom_id, 'delete:instagram');
});

test('instagram extract: carousel with more than four media is sent as attachments', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => embedHtml(mediaNode({
            edge_sidecar_to_children: {
                edges: Array.from({ length: 6 }, (_, index) => ({
                    node: {
                        __typename: 'GraphImage',
                        display_url: `https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/${index + 1}.jpg`,
                    },
                })),
            },
        })),
    }));

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

    assert.ok(Array.isArray(result));
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].files.length, 6);
    assert.equal(result[0].components[0].components[0].data.custom_id, 'translate');
});

test('instagram extract: GUI output settings control caption length and media limit', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => embedHtml(mediaNode({
            edge_media_to_caption: { edges: [{ node: { text: 'caption should be hidden' } }] },
            edge_sidecar_to_children: {
                edges: Array.from({ length: 6 }, (_, index) => ({
                    node: {
                        __typename: 'GraphImage',
                        display_url: `https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/${index + 1}.jpg`,
                    },
                })),
            },
        })),
    }));

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {
        instagram_caption_max_length: 0,
        instagram_media_limit: 4,
    });

    assert.equal(result[0].embeds.length, 4);
    assert.deepEqual(result[0].files, []);
    assert.doesNotMatch(result[0].embeds[0].description, /caption should be hidden/);
    assert.match(result[0].embeds[0].description, /View on Instagram/);

    const shortened = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {
        instagram_caption_max_length: 10,
        instagram_media_limit: 1,
    });

    assert.match(shortened[0].embeds[0].description, /^caption\.\.\./);
    assert.doesNotMatch(shortened[0].embeds[0].description, /should be hidden/);
});

test('instagram extract: post metadata fields and caption entities are configurable', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => embedHtml(mediaNode({
            edge_media_to_caption: { edges: [{ node: { text: 'hello #art #東京 @friend' } }] },
            edge_media_preview_like: { count: 1200 },
            edge_media_to_comment: { count: 34 },
            location: { name: 'Tokyo' },
        })),
    }));

    const visible = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

    assert.ok(Array.isArray(visible));
    assert.deepEqual(visible[0].embeds[0].fields.map(field => [field.name, field.value]), [
        ['Likes', '1,200'],
        ['Comments', '34'],
        ['Location', 'Tokyo'],
        ['Hashtags', '#art #東京'],
        ['Mentions', '@friend'],
    ]);

    const hidden = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {
        hidden_output_items: ['likes', 'comments', 'location', 'hashtags', 'mentions'],
    });

    assert.ok(Array.isArray(hidden));
    assert.equal(hidden[0].embeds[0].fields, undefined);
});

test('instagram extract: video duration and audio attribution are configurable', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => embedHtml(mediaNode({
            __typename: 'GraphVideo',
            video_url: 'https://scontent-nrt1-1.cdninstagram.com/v/t50/video.mp4',
            video_duration: 93.4,
            clips_music_attribution_info: {
                song_name: 'Midnight City',
                artist_name: 'M83',
            },
        })),
    }));

    const visible = await provider.extract(createMessage(), 'https://www.instagram.com/reel/CODE123/', {});

    assert.ok(Array.isArray(visible));
    assert.ok(visible[0].embeds[0].fields.some(field => field.name === 'Duration' && field.value === '1:33'));
    assert.ok(visible[0].embeds[0].fields.some(field => field.name === 'Audio' && field.value === 'Midnight City - M83'));

    const hidden = await provider.extract(createMessage(), 'https://www.instagram.com/reel/CODE123/', {
        hidden_output_items: ['duration', 'audio'],
    });

    assert.ok(Array.isArray(hidden));
    assert.equal(hidden[0].embeds[0].fields, undefined);
});

test('instagram extract: compact density and link-only media produce a lightweight payload', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => embedHtml(mediaNode({
            edge_sidecar_to_children: {
                edges: Array.from({ length: 3 }, (_, index) => ({
                    node: {
                        __typename: 'GraphImage',
                        display_url: `https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/${index + 1}.jpg`,
                    },
                })),
            },
        })),
    }));

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {
        display_density: 'compact',
        media_display_mode: 'link_only',
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].image, undefined);
    assert.equal(result[0].embeds[0].fields, undefined);
    assert.match(result[0].content, /Media: https:\/\/scontent\.cdninstagram\.com\/v\/t51\.2885-15\/1\.jpg/);
    assert.doesNotMatch(result[0].content, /2\.jpg/);
});

test('instagram extract: share URLs are resolved before scraping', async () => {
    const requestedUrls = [];
    const provider = loadInstagramProviderWithFetch(async (url, options = {}) => {
        requestedUrls.push(String(url));
        if (options.method === 'HEAD') {
            return {
                headers: { get: key => key === 'location' ? 'https://www.instagram.com/reel/REALCODE/' : null },
                url: String(url),
            };
        }
        return {
            ok: true,
            text: async () => embedHtml(mediaNode({ __typename: 'GraphVideo', video_url: 'https://scontent-nrt1-1.cdninstagram.com/v/t50/video.mp4' })),
        };
    });

    const result = await provider.extract(
        createMessage('https://www.instagram.com/share/reel/SHARECODE/'),
        'https://www.instagram.com/share/reel/SHARECODE/',
        {}
    );

    assert.ok(Array.isArray(result));
    assert.equal(requestedUrls[0], 'https://www.instagram.com/share/reel/SHARECODE/');
    assert.equal(requestedUrls[1], 'https://www.instagram.com/reel/REALCODE/embed/captioned/');
    assert.equal(result[0].embeds[0].url, 'https://www.instagram.com/reel/REALCODE/');
    assert.equal(result[0].files[0].endsWith('/v/t50/video.mp4'), true);
});

test('instagram extract: falls back to oEmbed thumbnail when embed HTML has no media payload', async () => {
    const requestedUrls = [];
    const provider = loadInstagramProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        requestedUrls.push(rawUrl);
        if (rawUrl.includes('/api/v1/oembed/')) {
            return {
                ok: true,
                text: async () => JSON.stringify({
                    title: 'fallback caption',
                    author_name: 'artist',
                    author_url: 'https://www.instagram.com/artist/',
                    thumbnail_url: 'https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/fallback.jpg',
                }),
            };
        }
        if (rawUrl.includes('/embed/captioned/')) {
            return { ok: true, text: async () => '<html><body>no public media data</body></html>' };
        }
        throw new Error(`Unexpected fetch after oEmbed fallback: ${rawUrl}`);
    });

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

    assert.ok(Array.isArray(result));
    assert.equal(requestedUrls[0], 'https://www.instagram.com/p/CODE123/embed/captioned/');
    assert.ok(requestedUrls.includes('https://www.instagram.com/api/v1/oembed/?url=https%3A%2F%2Fwww.instagram.com%2Fp%2FCODE123%2F'));
    assert.equal(requestedUrls.some(url => url.includes('/graphql/query/')), false);
    assert.equal(result[0].embeds[0].title, '@artist');
    assert.equal(result[0].embeds[0].description.includes('fallback caption'), true);
    assert.equal(result[0].embeds[0].image.url, 'https://scontent.cdninstagram.com/v/t51.2885-15/fallback.jpg');
});

test('instagram extract: profile links build a profile card', async () => {
    const requestedUrls = [];
    const provider = loadInstagramProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        requestedUrls.push(rawUrl);
        if (rawUrl === 'https://www.instagram.com/artist.profile/') {
            return {
                ok: true,
                status: 200,
                text: async () => profileHtml(),
            };
        }
        throw new Error(`Unexpected profile fetch: ${rawUrl}`);
    });

    const result = await provider.extract(
        createMessage('https://www.instagram.com/artist.profile/'),
        'https://www.instagram.com/artist.profile/',
        {}
    );

    assert.ok(Array.isArray(result));
    assert.deepEqual(requestedUrls, ['https://www.instagram.com/artist.profile/']);
    assert.equal(result[0].embeds[0].title, 'Artist Profile (@artist.profile)');
    assert.equal(result[0].embeds[0].url, 'https://www.instagram.com/artist.profile/');
    assert.equal(result[0].embeds[0].thumbnail.url, 'https://scontent.cdninstagram.com/v/t51.2885-19/profile.jpg');
    assert.equal(result[0].embeds[0].description.includes('profile bio'), true);
    assert.deepEqual(result[0].embeds[0].fields.map(field => [field.name, field.value]), [
        ['Posts', '12'],
        ['Followers', '3,456'],
        ['Following', '78'],
    ]);
    assert.equal(result[0].components[0].components[1].data.custom_id, 'delete:instagram');
});

test('instagram extract: profile links retry alternate profile API candidates', async () => {
    const requestedUrls = [];
    const provider = loadInstagramProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        requestedUrls.push(rawUrl);
        if (rawUrl === 'https://www.instagram.com/artist.profile/'
            || rawUrl === 'https://www.instagram.com/api/v1/users/web_profile_info/?username=artist.profile') {
            return { ok: true, status: 200, text: async () => '<html>login wall</html>' };
        }
        if (rawUrl.startsWith('https://i.instagram.com/api/v1/users/web_profile_info/')) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    data: {
                        user: {
                            username: 'artist.profile',
                            full_name: 'Artist Profile',
                            biography: 'profile bio',
                            profile_pic_url: 'https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-19/profile.jpg',
                            is_private: true,
                            is_verified: true,
                            edge_owner_to_timeline_media: { count: 12 },
                        },
                    },
                }),
            };
        }
        throw new Error(`Unexpected profile retry fetch: ${rawUrl}`);
    });

    const result = await provider.extract(
        createMessage('https://www.instagram.com/artist.profile/'),
        'https://www.instagram.com/artist.profile/',
        {}
    );

    assert.ok(Array.isArray(result));
    assert.deepEqual(requestedUrls, [
        'https://www.instagram.com/artist.profile/',
        'https://www.instagram.com/api/v1/users/web_profile_info/?username=artist.profile',
        'https://i.instagram.com/api/v1/users/web_profile_info/?username=artist.profile',
    ]);
    assert.equal(result[0].embeds[0].title, 'Artist Profile (@artist.profile)');
    assert.equal(result[0].embeds[0].thumbnail.url, 'https://scontent.cdninstagram.com/v/t51.2885-19/profile.jpg');
    assert.ok(result[0].embeds[0].fields.some(field => field.name === 'Status' && field.value === 'Verified / Private'));
});

test('instagram extract: profile links prefer crawler HTML to avoid profile API rate limits', async () => {
    const requestedUrls = [];
    const provider = loadInstagramProviderWithFetch(async (url) => {
        const rawUrl = String(url);
        requestedUrls.push(rawUrl);
        if (rawUrl.includes('/api/v1/users/web_profile_info/')) {
            return { ok: false, status: 429, text: async () => 'Too Many Requests' };
        }
        if (rawUrl === 'https://www.instagram.com/artist.profile/') {
            return {
                ok: true,
                status: 200,
                text: async () => profileHtml(),
            };
        }
        throw new Error(`Unexpected profile fallback fetch: ${rawUrl}`);
    });

    const result = await provider.extract(
        createMessage('https://www.instagram.com/artist.profile/'),
        'https://www.instagram.com/artist.profile/',
        {}
    );

    assert.ok(Array.isArray(result));
    assert.deepEqual(requestedUrls, ['https://www.instagram.com/artist.profile/']);
    assert.equal(result[0].embeds[0].title, 'Artist Profile (@artist.profile)');
    assert.equal(result[0].embeds[0].description.includes('profile bio'), true);
    assert.deepEqual(result[0].embeds[0].fields.map(field => [field.name, field.value]), [
        ['Posts', '12'],
        ['Followers', '3,456'],
        ['Following', '78'],
    ]);
});

test('instagram extract: blocked GraphQL fallback returns null without logging a stack', async () => {
    const provider = loadInstagramProviderWithFetch(async (url) => {
        if (String(url).includes('/graphql/query/')) {
            return { ok: false, status: 403, text: async () => 'Forbidden' };
        }
        if (String(url).includes('/api/v1/oembed/')) {
            return { ok: false, status: 404, text: async () => 'Not found' };
        }
        return { ok: true, text: async () => '<html><body>no public media data</body></html>' };
    });

    const originalLog = console.log;
    const logged = [];
    console.log = (...args) => { logged.push(args); };
    try {
        const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});
        assert.equal(result, null);
        assert.equal(logged.length, 0);
    } finally {
        console.log = originalLog;
    }
});
