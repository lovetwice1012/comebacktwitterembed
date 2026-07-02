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

function createMessage(overrides = {}) {
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        channel: { id: 'channel-1', nsfw: false },
        channelId: 'channel-1',
        content: 'https://www.pixiv.net/artworks/123456',
        ...overrides,
    };
}

function okJson(body) {
    return {
        ok: true,
        json: async () => ({ error: false, message: '', body }),
    };
}

function createInfo() {
    return {
        illustId: '123456',
        title: 'sample',
        description: 'desc',
        userName: 'artist',
        userId: '77',
        tags: { tags: [{ tag: 'tag' }] },
        aiType: 1,
        xRestrict: 0,
        illustType: 0,
        viewCount: 1000,
        bookmarkCount: 200,
        likeCount: 300,
        commentCount: 40,
        createDate: '2024-01-01T00:00:00+09:00',
        urls: {
            regular: 'https://i.pximg.net/img-master/img/2024/01/01/00/00/00/123456_p0_master1200.jpg',
        },
    };
}

function createRestrictedInfo() {
    return {
        ...createInfo(),
        xRestrict: 1,
        urls: {
            mini: null,
            thumb: null,
            small: null,
            regular: null,
            original: null,
        },
    };
}

function createPages(imageCount) {
    return Array.from({ length: imageCount }, (_, index) => ({
        urls: {
            regular: `https://i.pximg.net/img-master/img/2024/01/01/00/00/00/123456_p${index}_master1200.jpg`,
        },
    }));
}

function createPixivFetch(imageCount) {
    return async (url) => {
        if (String(url).includes('/pages?')) return okJson(createPages(imageCount));
        return okJson(createInfo());
    };
}

test('pixiv extract: default mode shows 4 images in a single message', async () => {
    const provider = loadPixivProviderWithFetch(createPixivFetch(55));
    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {});

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1, 'should be a single message');
    assert.equal(result[0].embeds.length, 4, 'first (only) message has 4 embeds');
    assert.equal(result[0].send, 'channel');
    // 1枚目のembedのみメタデータを持つ
    assert.ok(result[0].embeds[0].title, 'first embed has title');
    assert.ok(!result[0].embeds[1].title, 'second embed has no title');
    assert.equal(result[0].embeds[0].fields.find(f => f.name === 'Pages').value, '1-4 / 55');
    assert.equal(result[0].embeds[0].image.url, 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p0_master1200.jpg');
    assert.equal(result[0].analytics.content.contentType, 'illustration');
    assert.equal(result[0].analytics.metrics.views, 1000);
    assert.equal(result[0].analytics.metrics.bookmarks, 200);
    assert.ok(result[0].analytics.facets.some(facet => facet.key === 'tag' && facet.value === 'tag'));
});

test('pixiv extract: GUI output settings control description length and tags', async () => {
    const provider = loadPixivProviderWithFetch(async (url) => {
        if (String(url).includes('/pages?')) return okJson(createPages(1));
        return okJson({
            ...createInfo(),
            description: '0123456789',
            tags: { tags: [{ tag: 'hidden-tag' }] },
        });
    });

    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_caption_max_length: 5,
        hidden_output_items: ['tags'],
    });

    assert.equal(result[0].embeds[0].description, '0123…');
    assert.equal((result[0].embeds[0].fields || []).some(field => field.name === 'Tags'), false);

    const noDescription = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_caption_max_length: 0,
    });

    assert.equal(noDescription[0].embeds[0].description, undefined);
});

test('pixiv extract: tag limit and artwork labels are configurable', async () => {
    const provider = loadPixivProviderWithFetch(async (url) => {
        if (String(url).includes('/pages?')) return okJson(createPages(1));
        if (String(url).includes('/ugoira_meta?')) return okJson({});
        return okJson({
            ...createInfo(),
            aiType: 2,
            xRestrict: 2,
            illustType: 2,
            tags: { tags: Array.from({ length: 8 }, (_value, index) => ({ tag: `tag${index + 1}` })) },
        });
    });

    const visible = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_tag_limit: 5,
    });
    const hidden = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        hidden_output_items: ['ai', 'maturity', 'type'],
        pixiv_tag_limit: 'all',
    });

    assert.equal(visible[0].embeds[0].title, '[AI] sample [R-18G]');
    assert.equal(visible[0].embeds[0].fields.find(field => field.name === 'Tags').value, '#tag1 #tag2 #tag3 #tag4 #tag5');
    assert.equal(visible[0].embeds[0].fields.find(field => field.name === 'Type').value, 'Ugoira');
    assert.equal(hidden[0].embeds[0].title, 'sample');
    assert.equal(hidden[0].embeds[0].fields.find(field => field.name === 'Type'), undefined);
    assert.match(hidden[0].embeds[0].fields.find(field => field.name === 'Tags').value, /#tag8/);
});

test('pixiv extract: R-18 display mode can hide media or send spoiler attachments', async () => {
    const provider = loadPixivProviderWithFetch(async (url) => {
        if (String(url).includes('/pages?')) return okJson(createPages(3));
        return okJson({
            ...createInfo(),
            xRestrict: 1,
        });
    });

    const metadataOnly = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18_display_mode: 'metadata_only',
    });

    assert.equal(metadataOnly[0].embeds.length, 1);
    assert.equal(metadataOnly[0].embeds[0].image, undefined);
    assert.equal(metadataOnly[0].files, undefined);
    assert.equal(metadataOnly[0].embeds[0].title, 'sample [R-18]');
    assert.equal((metadataOnly[0].embeds[0].fields || []).some(field => field.name === 'Pages'), false);
    assert.equal(metadataOnly[0].components[0].components[0].data.custom_id, 'translate');

    const spoiler = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18_display_mode: 'spoiler_attachment',
    });

    assert.equal(spoiler[0].embeds.length, 1);
    assert.equal(spoiler[0].embeds[0].image, undefined);
    assert.deepEqual(spoiler[0].files, [
        { attachment: 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p0_master1200.jpg', name: 'SPOILER_pixiv-123456-1.jpg', fallbackUrl: 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p0_master1200.jpg' },
        { attachment: 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p1_master1200.jpg', name: 'SPOILER_pixiv-123456-2.jpg', fallbackUrl: 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p1_master1200.jpg' },
        { attachment: 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p2_master1200.jpg', name: 'SPOILER_pixiv-123456-3.jpg', fallbackUrl: 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p2_master1200.jpg' },
    ]);
    assert.equal(spoiler[0].embeds[0].fields.find(field => field.name === 'Pages').value, '1-3 / 3');
    assert.equal(spoiler[0].components[0].components[0].data.custom_id, 'translate');
});

test('pixiv extract: R-18G and non-NSFW channel policies can suppress sensitive expansion', async () => {
    const provider = loadPixivProviderWithFetch(async (url) => {
        if (String(url).includes('/pages?')) return okJson(createPages(2));
        return okJson({
            ...createInfo(),
            xRestrict: 2,
        });
    });

    const r18gSuppressed = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18g_display_mode: 'suppress',
    });
    assert.deepEqual(r18gSuppressed, [{
        suppressSourceEmbeds: true,
        allowedMentions: { repliedUser: false },
    }]);

    const nonNsfwSuppressed = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: true,
    });
    assert.equal(nonNsfwSuppressed[0].suppressSourceEmbeds, true);

    const explicitlyAllowed = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: true,
        pixiv_r18g_sensitive_content_allowed_targets: { user: [], channel: ['channel-1'], role: [] },
    });
    assert.equal(explicitlyAllowed[0].embeds[0].image.url, 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p0_master1200.jpg');

    const r18OnlyRestrictionIgnored = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18_non_nsfw_channel_sensitive_restriction_enabled: true,
    });
    assert.equal(r18OnlyRestrictionIgnored[0].embeds[0].image.url, 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p0_master1200.jpg');

    const r18AllowTargetIgnored = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: true,
        pixiv_r18_sensitive_content_allowed_targets: { user: [], channel: ['channel-1'], role: [] },
    });
    assert.equal(r18AllowTargetIgnored[0].suppressSourceEmbeds, true);

    const nsfwChannel = await provider.extract(createMessage({ channel: { id: 'channel-1', nsfw: true } }), 'https://www.pixiv.net/artworks/123456', {
        pixiv_r18g_non_nsfw_channel_sensitive_restriction_enabled: true,
    });
    assert.equal(nsfwChannel[0].embeds[0].image.url, 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p0_master1200.jpg');
});

test('pixiv extract: ugoira direct media URLs can be attached, linked, or hidden', async () => {
    const provider = loadPixivProviderWithFetch(async (url) => {
        if (String(url).includes('/pages?')) return okJson(createPages(1));
        if (String(url).includes('/ugoira_meta?')) {
            return okJson({
                src: 'https://cdn.example/ugoira-preview.mp4',
                originalSrc: 'https://i.pximg.net/img-zip-ugoira/img/2024/01/01/00/00/00/123456_ugoira1920x1080.zip',
            });
        }
        return okJson({
            ...createInfo(),
            illustType: 2,
        });
    });

    const attached = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {});
    assert.deepEqual(attached[0].files, ['https://cdn.example/ugoira-preview.mp4']);

    const linked = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        media_display_mode: 'link_only',
    });
    assert.equal(linked[0].files, undefined);
    assert.match(linked[0].content, /Ugoira: https:\/\/cdn\.example\/ugoira-preview\.mp4/);

    const hidden = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        hidden_output_items: ['ugoira_media'],
    });
    assert.equal(hidden[0].files, undefined);
});

test('pixiv extract: compact density and attachment media mode reduce fields and attach images', async () => {
    const provider = loadPixivProviderWithFetch(createPixivFetch(3));

    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {
        display_density: 'compact',
        media_display_mode: 'attachment',
        alwaysreplyifpostedtweetlink: true,
    });

    assert.ok(Array.isArray(result));
    assert.equal(result[0].send, 'reply-source');
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].title, 'sample');
    assert.equal(result[0].embeds[0].image, undefined);
    assert.equal((result[0].embeds[0].fields || []).some(field => field.name === 'Pages'), false);
    assert.equal((result[0].embeds[0].fields || []).some(field => field.name === 'Tags'), true);
    assert.equal(result[0].files.length, 3);
    assert.match(result[0].files[0], /https:\/\/www\.phixiv\.net\/i\/img-master\/img\/2024\/01\/01\/00\/00\/00\/123456_p0_master1200\.jpg/);
});

test('pixiv extract: pages 404 with hidden images returns null without logging an error', async () => {
    const provider = loadPixivProviderWithFetch(async (url) => {
        if (String(url).includes('/pages?')) {
            return {
                ok: false,
                status: 404,
                json: async () => ({ error: true, message: '', body: [] }),
            };
        }
        return okJson(createRestrictedInfo());
    });
    const originalLog = console.log;
    let logged = false;
    console.log = () => {
        logged = true;
    };

    try {
        const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/115161455', {});

        assert.equal(result, null);
        assert.equal(logged, false);
    } finally {
        console.log = originalLog;
    }
});

test('pixiv extract: 10-image mode shows 10 images in a single message', async () => {
    const provider = loadPixivProviderWithFetch(createPixivFetch(120));

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
    const provider = loadPixivProviderWithFetch(createPixivFetch(3));

    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456', {});

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].embeds.length, 3, 'shows all 3 available images');
    assert.equal(result[0].embeds[0].fields.find(f => f.name === 'Pages').value, '1-3 / 3');
});

test('pixiv extract: hash page selector shows that single image', async () => {
    const provider = loadPixivProviderWithFetch(createPixivFetch(3));

    const result = await provider.extract(createMessage(), 'https://www.pixiv.net/artworks/123456#2', {});

    assert.ok(Array.isArray(result));
    assert.equal(result[0].embeds.length, 1);
    assert.equal(result[0].embeds[0].image.url, 'https://www.phixiv.net/i/img-master/img/2024/01/01/00/00/00/123456_p1_master1200.jpg');
    assert.equal(result[0].embeds[0].fields.find(f => f.name === 'Pages').value, '2 / 3');
});
