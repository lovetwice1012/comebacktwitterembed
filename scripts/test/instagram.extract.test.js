'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const instagramModulePath = require.resolve('../../src/providers/instagram');
const fetchModulePath = require.resolve('node-fetch');
const { captionPage } = require('./helpers/instagram-caption-fixture.cjs');
const { reelPoster, reelVideoHtml } = require('./helpers/instagram-reel-fixture.cjs');

test('instagram extract: a Reel poster cannot stop embed lookup and MP4 attachment delivery', async () => {
    const requests = [];
    const provider = loadInstagramProviderWithFetch(async url => {
        requests.push(String(url));
        return { ok: true, text: async () => String(url).includes('/embed/') ? reelVideoHtml() : reelPoster() };
    });
    const url = 'https://www.instagram.com/reel/Ddmd-UrRH2B/';
    const result = await provider.extract(createMessage(url), url, {});
    assert.equal(requests.length, 2);
    assert.equal(result[0].files[0].attachment, 'https://example.com/Ddmd-UrRH2B.mp4?sig=fixture');
    assert.equal(result[0].files[0].name, 'instagram-1.mp4');
    assert.equal(result[0].embeds[0].image, undefined);
    assert.match(result[0].embeds[0].description, /Reel caption #cat/);
});

test('instagram extract: reported English photo routes never render page scripts or their CSS colors as hashtags', async () => {
    for (const url of ['https://www.instagram.com/p/DeAdSjuBvPY/', 'https://www.instagram.com/tinykittenshq/p/DeAcEspS-ry/']) {
        const shortcode = url.includes('DeAcEspS-ry') ? 'DeAcEspS-ry' : 'DeAdSjuBvPY';
        const provider = loadInstagramProviderWithFetch(async () => ({ ok: true, text: async () => captionPage({ shortcode }) }));
        const result = await provider.extract(createMessage(url), url, {});
        const embed = result[0].embeds[0];
        assert.match(embed.description, /An English photo caption #rescuecat/);
        assert.equal(embed.fields.find(field => field.name === 'Hashtags').value, '#rescuecat');
        assert.doesNotMatch(JSON.stringify(embed), /ScheduledServerJS|__bbox|#0866FF/);
        assert.equal(embed.image.url, 'https://example.com/media.jpg');
    }
});

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

function crawlerHtml(node) {
    return `<html><body><script>window.__ig = ${JSON.stringify({ data: node })};</script></body></html>`;
}

function xigImage(index) {
    return {
        __typename: 'XIGPolarisImageMedia',
        media_type: 1,
        display_uri: `https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/${index}.webp`,
    };
}

function relatedCarousel() {
    return {
        __typename: 'XIGPolarisCarouselMedia',
        code: 'OTHERPOST',
        media_type: 8,
        owner: { username: 'other.artist' },
        carousel_media: [xigImage('unrelated-1'), xigImage('unrelated-2')],
    };
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
    assert.equal(requestedUrls[0], 'https://www.instagram.com/p/CODE123/');
    assert.equal(result[0].send, 'channel');
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].title, '@artist');
    assert.equal(result[0].embeds[0].image.url.startsWith('https://scontent.cdninstagram.com/'), true);
    assert.equal(result[0].components[1].components[1].data.custom_id, 'delete:instagram');
});

test('instagram extract: discovers a standalone crawler image without video or carousel fields', async () => {
    const imageUrl = 'https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/requested.webp';
    for (const imageFields of [
        { display_uri: imageUrl },
        { display_url: imageUrl },
        { image_versions2: { candidates: [{ url: imageUrl }] } },
    ]) {
        const provider = loadInstagramProviderWithFetch(async () => ({
            ok: true,
            text: async () => crawlerHtml({ __typename: 'XIGPolarisImageMedia', code: 'CODE123', ...imageFields }),
        }));

        const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

        assert.ok(Array.isArray(result));
        assert.equal(result[0].embeds[0].image.url, 'https://scontent.cdninstagram.com/v/t51.2885-15/requested.webp');
        assert.deepEqual(result[0].files, []);
    }
});

test('instagram extract: selects the requested single image ahead of unrelated carousels and videos', async () => {
    const requested = { ...xigImage('requested'), code: 'CODE123', owner: { username: 'artist' } };
    const related = [relatedCarousel(), {
        __typename: 'XIGPolarisVideoMedia',
        shortcode: 'OTHERVIDEO',
        video_url: 'https://scontent-nrt1-1.cdninstagram.com/v/t50/unrelated.mp4',
    }];
    const pages = [
        crawlerHtml({ related, post: requested }),
        crawlerHtml({ post: requested, related }),
        crawlerHtml(related) + crawlerHtml(requested),
        crawlerHtml(related) + embedHtml(mediaNode({
            shortcode: 'CODE123', display_url: requested.display_uri,
        })),
        crawlerHtml({ related: { ...relatedCarousel(), code: undefined }, post: requested }),
    ];

    for (const html of pages) {
        let fetchCount = 0;
        const provider = loadInstagramProviderWithFetch(async () => {
            fetchCount++;
            return { ok: true, text: async () => html };
        });
        const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

        assert.ok(Array.isArray(result));
        assert.equal(result[0].embeds.length, 1);
        assert.equal(result[0].embeds[0].title, '@artist');
        assert.equal(result[0].embeds[0].image.url, 'https://scontent.cdninstagram.com/v/t51.2885-15/requested.webp');
        assert.deepEqual(result[0].files, []);

        const cached = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});
        assert.equal(cached[0].embeds[0].image.url, result[0].embeds[0].image.url);
        assert.equal(fetchCount, 1);
    }
});

test('instagram extract: unrelated carousel children cannot replace missing post data', () => {
    const provider = loadInstagramProviderWithFetch(async () => { throw new Error('No fetch expected'); });
    const html = crawlerHtml(relatedCarousel());

    assert.equal(provider.__test.parseInstagramHtml(html, 'CODE123'), null);
});

test('instagram extract: uses page preview when only unrelated structured media is present', () => {
    const provider = loadInstagramProviderWithFetch(async () => { throw new Error('No fetch expected'); });
    const html = `<meta property="og:url" content="https://www.instagram.com/p/CODE123/" />
        <meta property="og:image" content="https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/requested.jpg" />
        ${crawlerHtml(relatedCarousel())}`;

    const data = provider.__test.parseInstagramHtml(html, 'CODE123');

    assert.equal(data.medias.length, 1);
    assert.equal(data.medias[0].url, 'https://scontent.cdninstagram.com/v/t51.2885-15/requested.jpg');
});

test('instagram extract: rejects a page preview explicitly belonging to another post', () => {
    const provider = loadInstagramProviderWithFetch(async () => { throw new Error('No fetch expected'); });
    const html = `<meta property="og:url" content="https://www.instagram.com/p/OTHERPOST/" />
        <meta property="og:image" content="https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/unrelated.jpg" />
        ${crawlerHtml(relatedCarousel())}`;

    assert.equal(provider.__test.parseInstagramHtml(html, 'CODE123'), null);
});

test('instagram extract: matching carousel retains children and requested image order', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => crawlerHtml({
            related: relatedCarousel(),
            post: {
                __typename: 'XIGPolarisCarouselMedia',
                code: 'CODE123',
                carousel_media: [xigImage('requested-1'), xigImage('requested-2')],
            },
        }),
    }));
    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});
    assert.deepEqual(result[0].embeds.map(embed => embed.image.url.split('/').pop()), [
        'requested-1.webp', 'requested-2.webp',
    ]);

    const selected = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/?img_index=2', {});
    assert.equal(selected[0].embeds.length, 1);
    assert.equal(selected[0].embeds[0].image.url.split('/').pop(), 'requested-2.webp');
});

test('instagram extract: GraphQL fallback also selects the requested shortcode', async () => {
    const provider = loadInstagramProviderWithFetch(async url => {
        if (String(url).includes('/graphql/query/')) {
            return { ok: true, text: async () => JSON.stringify({ data: {
                related: relatedCarousel(),
                xdt_shortcode_media: mediaNode({ shortcode: 'CODE123' }),
            } }) };
        }
        return { ok: true, text: async () => '<html>No media</html>' };
    });

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

    assert.ok(Array.isArray(result));
    assert.equal(result[0].embeds[0].image.url, 'https://scontent.cdninstagram.com/v/t51.2885-15/sample.jpg?sig=1');
    assert.deepEqual(result[0].files, []);
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
    assert.deepEqual(result[0].files.map(file => file.name), [
        'instagram-1.jpg', 'instagram-2.jpg', 'instagram-3.jpg',
        'instagram-4.jpg', 'instagram-5.jpg', 'instagram-6.jpg',
    ]);
    assert.equal(result[0].components[0].components[0].data.custom_id, 'translate');
});

test('instagram extract: crawler carousel data retains every image', async () => {
    const requested = [];
    const provider = loadInstagramProviderWithFetch(async (url, options = {}) => {
        requested.push({ url: String(url), userAgent: options.headers?.['User-Agent'] });
        return {
            ok: true,
            text: async () => crawlerHtml({
                __typename: 'XIGPolarisCarouselMedia',
                media_type: 8,
                owner: { username: 'artist' },
                caption: { text: 'carousel caption' },
                carousel_media: Array.from({ length: 6 }, (_, index) => xigImage(index + 1)),
            }),
        };
    });

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

    assert.equal(requested[0].url, 'https://www.instagram.com/p/CODE123/');
    assert.equal(requested[0].userAgent, 'facebookexternalhit/1.1');
    assert.equal(result[0].files.length, 6);
    assert.deepEqual(result[0].files.map(file => file.attachment.split('?')[0].split('/').pop()), [
        '1.webp', '2.webp', '3.webp', '4.webp', '5.webp', '6.webp',
    ]);
    assert.match(result[0].embeds[0].fields.find(field => field.name === 'Media').value, /1-6 \/ 6/);
});

test('instagram extract: crawler mixed carousel uses the video stream, not its thumbnail', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => crawlerHtml({
            __typename: 'XIGPolarisCarouselMedia',
            media_type: 8,
            owner: { username: 'artist' },
            carousel_media: [
                xigImage(1),
                {
                    __typename: 'XIGPolarisVideoMedia',
                    media_type: 2,
                    display_uri: 'https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/video-thumbnail.jpg',
                    video_versions: [{ url: 'https://scontent-nrt1-1.cdninstagram.com/v/t50/video.mp4' }],
                },
                xigImage(3),
            ],
        }),
    }));

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/p/CODE123/', {});

    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].files.length, 3);
    assert.deepEqual(result[0].files.map(file => file.name), [
        'instagram-1.webp', 'instagram-2.mp4', 'instagram-3.webp',
    ]);
    assert.equal(result[0].files[1].attachment.endsWith('/v/t50/video.mp4'), true);
    assert.equal(result[0].files[1].attachment.includes('thumbnail'), false);
});

test('instagram extract: does not upload a video thumbnail as a video file when no stream is available', async () => {
    const provider = loadInstagramProviderWithFetch(async () => ({
        ok: true,
        text: async () => crawlerHtml({
            __typename: 'XIGPolarisVideoMedia',
            media_type: 2,
            display_uri: 'https://scontent-nrt1-1.cdninstagram.com/v/t51.2885-15/video-thumbnail.jpg',
            video_versions: [],
        }),
    }));

    const result = await provider.extract(createMessage(), 'https://www.instagram.com/reel/CODE123/', {});

    assert.equal(result[0].files.length, 0);
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].image.url.endsWith('video-thumbnail.jpg'), true);
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
    assert.equal(requestedUrls[1], 'https://www.instagram.com/reel/REALCODE/');
    assert.equal(result[0].embeds[0].url, 'https://www.instagram.com/reel/REALCODE/');
    assert.equal(result[0].files[0].attachment.endsWith('/v/t50/video.mp4'), true);
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
    assert.equal(requestedUrls[0], 'https://www.instagram.com/p/CODE123/');
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

test('instagram extract: reloaded providers retain independent transports and media caches', async () => {
    const calls = { first: 0, second: 0 };
    const load = name => loadInstagramProviderWithFetch(async () => {
        calls[name]++;
        return { ok: true, text: async () => embedHtml(mediaNode({ owner: { username: name } })) };
    });
    const first = load('first');
    const second = load('second');
    const url = 'https://www.instagram.com/p/CODE123/';
    const expand = provider => provider.extract(createMessage(url), url, {});

    assert.notEqual(first.urlPattern, second.urlPattern);
    assert.notEqual(first.cleanPattern, second.cleanPattern);
    assert.equal(first.urlPattern.test(url), true);
    assert.equal(second.urlPattern.test(url), true);

    assert.equal((await expand(first))[0].embeds[0].title, '@first');
    assert.equal((await expand(second))[0].embeds[0].title, '@second');
    assert.equal((await expand(first))[0].embeds[0].title, '@first');
    assert.deepEqual(calls, { first: 1, second: 1 });

    second.__test._clearCache();
    await expand(first);
    await expand(second);
    assert.deepEqual(calls, { first: 1, second: 2 });
});

test('instagram client: profile API backoff stays local and resets with the cache', async () => {
    const { createInstagramClient } = require('../../src/providers/instagram/client');
    let rateLimitedCalls = 0;
    const rateLimited = createInstagramClient(async url => {
        if (String(url).includes('/api/v1/users/web_profile_info/')) {
            rateLimitedCalls++;
            return { ok: false, status: 429, text: async () => 'Too Many Requests' };
        }
        return { ok: true, status: 200, text: async () => '<html>login wall</html>' };
    });
    const healthy = createInstagramClient(async url => ({
        ok: true,
        status: 200,
        text: async () => String(url).includes('/api/v1/users/web_profile_info/')
            ? JSON.stringify({ data: { user: { username: 'healthy' } } })
            : '<html>login wall</html>',
    }));

    await assert.rejects(rateLimited.fetchProfileData('artist'), { status: 429 });
    await assert.rejects(rateLimited.fetchProfileData('other'), /html missing user/);
    assert.equal(rateLimitedCalls, 1);
    assert.equal((await healthy.fetchProfileData('healthy')).username, 'healthy');

    rateLimited.clearCache();
    await assert.rejects(rateLimited.fetchProfileData('artist'), { status: 429 });
    assert.equal(rateLimitedCalls, 2);
});
