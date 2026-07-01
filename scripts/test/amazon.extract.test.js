'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const amazonModulePath = require.resolve('../../src/providers/amazon');
const fetchModulePath = require.resolve('node-fetch');

function loadAmazonProviderWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalAmazonModule = require.cache[amazonModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[amazonModulePath];

    try {
        return require(amazonModulePath);
    } finally {
        delete require.cache[amazonModulePath];
        if (originalAmazonModule) require.cache[amazonModulePath] = originalAmazonModule;
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

function productJsonLdHtml(overrides = {}, body = '') {
    const product = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Echo Dot smart speaker',
        description: 'A compact smart speaker with Alexa.',
        image: ['https://images.example/echo.jpg'],
        brand: { '@type': 'Brand', name: 'Amazon' },
        aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: '4.7',
            reviewCount: '12345',
        },
        offers: {
            '@type': 'Offer',
            price: '49.99',
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
        },
        ...overrides,
    };
    return `<html><head><script type="application/ld+json">${JSON.stringify(product)}</script></head><body>${body}</body></html>`;
}

function productDomHtml() {
    return `
        <html>
            <head><meta property="og:description" content="Water resistant reader"></head>
            <body>
                <span id="productTitle">Kindle Paperwhite</span>
                <a id="bylineInfo">Brand: Kindle</a>
                <span class="a-offscreen">$139.99</span>
                <i id="acrPopover">4.5 out of 5 stars</i>
                <span id="acrCustomerReviewText">1,234 ratings</span>
                <img id="landingImage" data-a-dynamic-image='{"https://images.example/small.jpg":[100,100],"https://images.example/large.jpg":[900,900]}'>
            </body>
        </html>
    `;
}

function musicJsonLdHtml(overrides = {}) {
    const track = {
        '@context': 'https://schema.org',
        '@type': 'MusicRecording',
        name: 'Sample Song',
        description: 'A sample track on Amazon Music.',
        image: 'https://images.example/music.jpg',
        byArtist: { '@type': 'MusicGroup', name: 'Sample Artist' },
        inAlbum: { '@type': 'MusicAlbum', name: 'Sample Album' },
        datePublished: '2026-01-02',
        ...overrides,
    };
    return `<html><head><script type="application/ld+json">${JSON.stringify(track)}</script></head></html>`;
}

function musicSocialHtml() {
    return `
        <html>
            <head>
                <meta property="og:title" content="Fallback Song \u2013 Fallback Artist">
                <meta property="og:description" content="On Amazon Music">
                <meta property="og:image" content="https://images.example/social.jpg">
                <meta property="music:duration" content="245">
            </head>
        </html>
    `;
}

function musicOembedJson() {
    return {
        version: '1.0',
        provider_name: 'Amazon Music',
        title: 'Fallback Song',
        thumbnail_url: 'https://images.example/oembed.jpg',
        html: '<iframe src="https://music.amazon.com/embed/B0TRACK123/?id=test"></iframe>',
    };
}

function musicEmbedHtml() {
    return `
        <html>
            <head><title>Amazon Music - Track Fallback Song</title></head>
            <body>
                <input id="ALBUM_TITLE" type="hidden" value="Fallback Album">
                <a aria-label="song, Fallback Song">Fallback Song</a>
                <a aria-label="artist, Fallback Artist">Fallback Artist</a>
                <picture role="none" class="imageWrapper loaded">
                    <source type="image/webp" srcset="https://images.example/embed._UX358_FMwebp_QL85_.jpg 1x, https://images.example/embed._UX716_FMwebp_QL85_.jpg 2x">
                    <source srcset="https://images.example/embed._UX358_FMjpg_QL85_.jpg 1x, https://images.example/embed._UX716_FMjpg_QL85_.jpg 2x">
                    <img role="none" loading="lazy" data-src="https://images.example/embed-original.jpg" src="https://images.example/embed._UX358_FMjpg_QL85_.jpg" alt="Fallback Artist">
                </picture>
            </body>
        </html>
    `;
}

function primeVideoJsonLdHtml(overrides = {}) {
    const video = {
        '@context': 'https://schema.org',
        '@type': 'TVSeries',
        name: 'Example Show',
        description: 'A Prime Video original series.',
        image: 'https://images.example/prime.jpg',
        genre: ['Drama', 'Sci-Fi'],
        aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: '8.2',
            ratingCount: '4567',
        },
        actor: [
            { '@type': 'Person', name: 'Example Lead' },
            { '@type': 'Person', name: 'Second Cast' },
        ],
        partOfSeason: {
            '@type': 'TVSeason',
            name: 'Season 2',
            seasonNumber: 2,
        },
        datePublished: '2024-05-03',
        contentRating: '16+',
        duration: 'PT1H42M',
        ...overrides,
    };
    return `<html><head><script type="application/ld+json">${JSON.stringify(video)}</script></head></html>`;
}

function primeVideoDomHtml() {
    return `
        <html>
            <head><meta property="og:description" content="A rental romcom on Prime Video."></head>
            <body>
                <picture>
                    <source type="image/avif" srcset="https://images.example/show._SX360_FMavif_.jpg 360w, https://images.example/show._SX1920_FMavif_.jpg 1920w">
                    <source type="image/webp" srcset="https://images.example/show._SX720_FMwebp_.jpg 720w">
                    <source type="image/jpeg" srcset="https://images.example/show._SX360_FMjpg_.jpg 360w, https://images.example/show._SX1920_FMjpg_.jpg 1920w">
                    <img alt="\u5f7c\u5973\u3001\u304a\u501f\u308a\u3057\u307e\u3059" src="https://images.example/show._SX1080_FMjpg_.jpg" data-testid="base-image">
                </picture>
                <div data-testid="dv-node-dp-genres">
                    <span data-testid="genre-texts"><a>\u30a2\u30cb\u30e1</a></span>
                    <span data-testid="genre-texts"><a>\u30b3\u30e1\u30c7\u30a3</a></span>
                    <span data-testid="genre-texts"><a>\u30ed\u30de\u30f3\u30b9</a></span>
                </div>
                <div data-testid="star-rating-badge" data-automation-id="star-rating-badge" aria-label="9\u4eba\u306eAmazon\u30ab\u30b9\u30bf\u30de\u30fc\u306b\u3088\u308a\u30015\u3064\u661f\u306e\u3046\u30612.4\u306e\u8a55\u4fa1\u304c\u3055\u308c\u3066\u3044\u307e\u3059\u3002">
                    <span>2.4/5</span>
                </div>
                <span role="img" data-automation-id="imdb-rating-badge" aria-label="IMDb\u306e\u8a55\u4fa1\uff1a6.7">IMDb 6.7/10</span>
                <span role="img" data-automation-id="release-year-badge" aria-label="\u516c\u958b\u5e74: 2020">2020</span>
                <span role="img" aria-label="\u30b7\u30fc\u30ba\u30f3\u6570\uff1a5">\u30b7\u30fc\u30ba\u30f3\u6570\uff1a5</span>
            </body>
        </html>
    `;
}

function okHtml(html, finalUrl) {
    return {
        ok: true,
        url: finalUrl,
        text: async () => html,
    };
}

function fieldValue(embed, name) {
    return (embed.fields || []).find(field => field.name === name)?.value;
}

test('amazon extract: builds an embed from JSON-LD product data', async () => {
    const requests = [];
    const provider = loadAmazonProviderWithFetch(async (url) => {
        requests.push(url);
        return okHtml(productJsonLdHtml(), url);
    });

    const url = 'https://www.amazon.com/Echo-Dot/dp/B08N5WRWNW?tag=affiliate-20';
    const result = await provider.extract(createMessage(url), url, {});

    assert.deepEqual(requests, [url]);
    assert.equal(result.length, 1);

    const step = result[0];
    const embed = step.embeds[0];
    assert.equal(embed.title, 'Echo Dot smart speaker');
    assert.equal(embed.url, 'https://amazon.com/dp/B08N5WRWNW');
    assert.equal(embed.description, 'A compact smart speaker with Alexa.');
    assert.equal(embed.image.url, 'https://images.example/echo.jpg');
    assert.equal(fieldValue(embed, 'Price'), 'USD 49.99');
    assert.equal(fieldValue(embed, 'Brand'), 'Amazon');
    assert.equal(fieldValue(embed, 'Rating'), '4.7 / 5 (12,345)');
    assert.equal(fieldValue(embed, 'Review count'), '12,345');
    assert.equal(fieldValue(embed, 'Availability'), 'In Stock');
    assert.equal(fieldValue(embed, 'ASIN'), 'B08N5WRWNW');
    assert.equal(step.components[0].components[0].data.url, url);
    assert.equal(step.components[0].components[1].data.custom_id, 'showMediaAsAttachments');
    assert.equal(step.suppressSourceEmbeds, true);
});

test('amazon extract: GUI output setting can hide product price', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(productJsonLdHtml(), url));

    const url = 'https://www.amazon.com/Echo-Dot/dp/B08N5WRWNW';
    const result = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['price'],
    });

    const embed = result[0].embeds[0];
    assert.equal(fieldValue(embed, 'Price'), undefined);
    assert.equal(fieldValue(embed, 'Brand'), 'Amazon');
});

test('amazon extract: compact display density hides compact product fields', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(productJsonLdHtml(), url));

    const url = 'https://www.amazon.com/Echo-Dot/dp/B08N5WRWNW';
    const standard = await provider.extract(createMessage(url), url, {});
    const compact = await provider.extract(createMessage(url), url, {
        display_density: 'compact',
    });

    const standardEmbed = standard[0].embeds[0];
    const compactEmbed = compact[0].embeds[0];

    assert.equal(fieldValue(standardEmbed, 'Price'), 'USD 49.99');
    assert.equal(fieldValue(standardEmbed, 'Rating'), '4.7 / 5 (12,345)');
    assert.equal(fieldValue(standardEmbed, 'Availability'), 'In Stock');
    assert.equal(fieldValue(compactEmbed, 'Price'), undefined);
    assert.equal(fieldValue(compactEmbed, 'Rating'), undefined);
    assert.equal(fieldValue(compactEmbed, 'Availability'), undefined);
    assert.ok((compactEmbed.fields || []).length < (standardEmbed.fields || []).length);
});

test('amazon extract: honors product description length setting', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(productJsonLdHtml({
        description: '0123456789abcdefghijklmnopqrstuvwxyz',
    }), url));

    const url = 'https://www.amazon.com/Echo-Dot/dp/B08N5WRWNW';
    const limited = await provider.extract(createMessage(url), url, {
        amazon_description_max_length: 10,
    });

    assert.equal(limited[0].embeds[0].description, '0123456...');

    const hidden = await provider.extract(createMessage(url), url, {
        amazon_description_max_length: 0,
    });

    assert.equal(hidden[0].embeds[0].description, undefined);
});

test('amazon extract: product rating and availability fields can be hidden', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(productJsonLdHtml(), url));

    const url = 'https://www.amazon.com/Echo-Dot/dp/B08N5WRWNW';
    const visible = await provider.extract(createMessage(url), url, {});
    assert.equal(fieldValue(visible[0].embeds[0], 'Rating'), '4.7 / 5 (12,345)');
    assert.equal(fieldValue(visible[0].embeds[0], 'Availability'), 'In Stock');

    const hidden = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['rating', 'availability'],
    });
    assert.equal(fieldValue(hidden[0].embeds[0], 'Rating'), undefined);
    assert.equal(fieldValue(hidden[0].embeds[0], 'Availability'), undefined);
});

test('amazon extract: product seller and shipping fields can be hidden', async () => {
    const html = productJsonLdHtml({
        offers: {
            '@type': 'Offer',
            price: '49.99',
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
            seller: { '@type': 'Organization', name: 'Amazon.com' },
            shippingDetails: { '@type': 'OfferShippingDetails', name: 'Free shipping' },
        },
    });
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(html, url));

    const url = 'https://www.amazon.com/Echo-Dot/dp/B08N5WRWNW';
    const visible = await provider.extract(createMessage(url), url, {});
    assert.equal(fieldValue(visible[0].embeds[0], 'Seller'), 'Amazon.com');
    assert.equal(fieldValue(visible[0].embeds[0], 'Shipping'), 'Free shipping');

    const hidden = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['seller', 'shipping'],
    });
    assert.equal(fieldValue(hidden[0].embeds[0], 'Seller'), undefined);
    assert.equal(fieldValue(hidden[0].embeds[0], 'Shipping'), undefined);
});

test('amazon extract: product review count, coupon, and deal fields can be hidden', async () => {
    const html = productJsonLdHtml({}, `
        <span id="couponText">Coupon: Save 10% with coupon</span>
        <span id="dealBadge">Limited time deal</span>
    `);
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(html, url));

    const url = 'https://www.amazon.com/Echo-Dot/dp/B08N5WRWNW';
    const visible = await provider.extract(createMessage(url), url, {});
    assert.equal(fieldValue(visible[0].embeds[0], 'Review count'), '12,345');
    assert.equal(fieldValue(visible[0].embeds[0], 'Coupon'), 'Save 10% with coupon');
    assert.equal(fieldValue(visible[0].embeds[0], 'Deal'), 'Limited time deal');

    const hidden = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['review_count', 'coupon', 'deal'],
    });
    assert.equal(fieldValue(hidden[0].embeds[0], 'Review count'), undefined);
    assert.equal(fieldValue(hidden[0].embeds[0], 'Coupon'), undefined);
    assert.equal(fieldValue(hidden[0].embeds[0], 'Deal'), undefined);
});

test('amazon extract: falls back to product page DOM when JSON-LD is unavailable', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(productDomHtml(), url));

    const url = 'https://www.amazon.co.jp/-/en/dp/B0DOMTEST1/ref=something';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, 'Kindle Paperwhite');
    assert.equal(embed.url, 'https://amazon.co.jp/dp/B0DOMTEST1');
    assert.equal(embed.description, 'Water resistant reader');
    assert.equal(embed.image.url, 'https://images.example/large.jpg');
    assert.equal(fieldValue(embed, 'Price'), '$139.99');
    assert.equal(fieldValue(embed, 'Brand'), 'Kindle');
    assert.equal(fieldValue(embed, 'Rating'), '4.5 / 5 (1,234)');
    assert.equal(fieldValue(embed, 'Review count'), '1,234');
});

test('amazon extract: resolves short links using the final fetch URL', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => {
        assert.equal(url, 'https://a.co/d/abc123');
        return okHtml(productJsonLdHtml({ name: 'Short link item' }), 'https://www.amazon.co.jp/-/en/dp/B0SHORT123?ref_=abc');
    });

    const url = 'https://a.co/d/abc123';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, 'Short link item');
    assert.equal(embed.url, 'https://amazon.co.jp/dp/B0SHORT123');
    assert.equal(fieldValue(embed, 'ASIN'), 'B0SHORT123');
    assert.equal(result[0].components[0].components[0].data.url, url);
});

test('amazon extract: builds Amazon Music embeds from music.amazon track links', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(musicJsonLdHtml(), url));

    const url = 'https://music.amazon.com/albums/B0ALBUM123?trackAsin=B0TRACK123&ref=dm_sh_sample';
    const result = await provider.extract(createMessage(url), url, {});
    const step = result[0];
    const embed = step.embeds[0];

    assert.equal(embed.title, 'Sample Song');
    assert.equal(embed.url, 'https://music.amazon.com/tracks/B0TRACK123');
    assert.equal(embed.description, 'A sample track on Amazon Music.');
    assert.equal(embed.image.url, 'https://images.example/music.jpg');
    assert.equal(fieldValue(embed, 'Type'), 'Track');
    assert.equal(fieldValue(embed, 'Artist'), 'Sample Artist');
    assert.equal(fieldValue(embed, 'Album'), 'Sample Album');
    assert.equal(fieldValue(embed, 'Date'), '2026-01-02');
    assert.equal(fieldValue(embed, 'ID'), 'B0TRACK123');
    assert.equal(step.components[0].components[0].data.label, 'Open in Amazon Music');
    assert.equal(step.components[0].components[0].data.url, url);
    assert.ok(embed.footer.text.endsWith(' - Amazon Music'));
});

test('amazon extract: enriches Amazon Music embeds from oEmbed and embed markup', async () => {
    const requests = [];
    const provider = loadAmazonProviderWithFetch(async (url) => {
        requests.push(url);
        if (String(url).includes('/embed/oembed')) return okHtml(JSON.stringify(musicOembedJson()), url);
        if (String(url).includes('/embed/B0TRACK123')) return okHtml(musicEmbedHtml(), url);
        return okHtml(musicSocialHtml(), url);
    });

    const url = 'https://music.amazon.com/tracks/B0TRACK123';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.deepEqual(requests, [
        url,
        'https://music.amazon.com/tracks/B0TRACK123',
        'https://music.amazon.com/embed/oembed?url=https%3A%2F%2Fmusic.amazon.com%2Ftracks%2FB0TRACK123',
        'https://music.amazon.com/embed/B0TRACK123/?id=test',
    ]);
    assert.equal(embed.title, 'Fallback Song');
    assert.equal(embed.description, undefined);
    assert.equal(embed.image.url, 'https://images.example/embed-original.jpg');
    assert.equal(fieldValue(embed, 'Artist'), 'Fallback Artist');
    assert.equal(fieldValue(embed, 'Album'), 'Fallback Album');
    assert.equal(fieldValue(embed, 'Duration'), '4m 5s');
});

test('amazon extract: resolves short links to Amazon Music URLs', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => {
        if (url === 'https://amzn.to/music123') {
            return okHtml(musicJsonLdHtml({ name: 'Short Music Link' }), 'https://music.amazon.co.jp/playlists/B0PLAYLIST1');
        }
        return okHtml(JSON.stringify(musicOembedJson()), url);
    });

    const url = 'https://amzn.to/music123';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, 'Short Music Link');
    assert.equal(embed.url, 'https://music.amazon.co.jp/playlists/B0PLAYLIST1');
    assert.equal(fieldValue(embed, 'Type'), 'Playlist');
    assert.equal(fieldValue(embed, 'ID'), 'B0PLAYLIST1');
});

test('amazon extract: builds Prime Video embeds from primevideo.com detail links', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(primeVideoJsonLdHtml(), url));

    const url = 'https://www.primevideo.com/detail/0NQ1QFP6B4R6TM8O2590IV5716';
    const result = await provider.extract(createMessage(url), url, {});
    const step = result[0];
    const embed = step.embeds[0];

    assert.equal(embed.title, 'Example Show');
    assert.equal(embed.url, 'https://www.primevideo.com/detail/0NQ1QFP6B4R6TM8O2590IV5716');
    assert.equal(embed.description, 'A Prime Video original series.');
    assert.equal(embed.image.url, 'https://images.example/prime.jpg');
    assert.equal(fieldValue(embed, 'Genre'), 'Drama, Sci-Fi');
    assert.equal(fieldValue(embed, 'Cast'), 'Example Lead, Second Cast');
    assert.equal(fieldValue(embed, 'Season'), 'Season 2');
    assert.equal(fieldValue(embed, 'Year'), '2024');
    assert.equal(fieldValue(embed, 'Maturity'), '16+');
    assert.equal(fieldValue(embed, 'Duration'), '1h 42m');
    assert.equal(fieldValue(embed, 'Rating'), '8.2 (4,567)');
    assert.equal(fieldValue(embed, 'ID'), '0NQ1QFP6B4R6TM8O2590IV5716');
    assert.equal(step.components[0].components[0].data.label, 'Open in Prime Video');
    assert.ok(embed.footer.text.endsWith(' - Prime Video'));
});

test('amazon extract: falls back to Prime Video DOM picture and badges', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(primeVideoDomHtml(), url));

    const url = 'https://www.amazon.co.jp/gp/video/detail/B0H569Z3BN/ref=atv_dp_share_cu_r';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, '\u5f7c\u5973\u3001\u304a\u501f\u308a\u3057\u307e\u3059');
    assert.equal(embed.url, 'https://amazon.co.jp/gp/video/detail/B0H569Z3BN');
    assert.equal(embed.description, 'A rental romcom on Prime Video.');
    assert.equal(embed.image.url, 'https://images.example/show._SX1920_FMjpg_.jpg');
    assert.equal(fieldValue(embed, 'Genre'), '\u30a2\u30cb\u30e1, \u30b3\u30e1\u30c7\u30a3, \u30ed\u30de\u30f3\u30b9');
    assert.equal(fieldValue(embed, 'Season'), '\u30b7\u30fc\u30ba\u30f3\u6570\uff1a5');
    assert.equal(fieldValue(embed, 'Year'), '2020');
    assert.equal(fieldValue(embed, 'Rating'), 'Amazon 2.4/5 (9), IMDb 6.7/10');
});

test('amazon extract: hides Prime Video fields and supports link-only image media', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(primeVideoJsonLdHtml(), url));

    const url = 'https://www.primevideo.com/detail/0NQ1QFP6B4R6TM8O2590IV5716';
    const result = await provider.extract(createMessage(url), url, {
        hidden_output_items: ['genre', 'cast', 'season', 'year', 'maturity', 'duration', 'rating'],
        media_display_mode: 'link_only',
    });
    const step = result[0];
    const embed = step.embeds[0];

    assert.equal(embed.image, undefined);
    assert.equal(embed.thumbnail, undefined);
    assert.equal(step.files, undefined);
    assert.equal(step.content, 'Image: https://images.example/prime.jpg');
    assert.equal(fieldValue(embed, 'Genre'), undefined);
    assert.equal(fieldValue(embed, 'Cast'), undefined);
    assert.equal(fieldValue(embed, 'Season'), undefined);
    assert.equal(fieldValue(embed, 'Year'), undefined);
    assert.equal(fieldValue(embed, 'Maturity'), undefined);
    assert.equal(fieldValue(embed, 'Duration'), undefined);
    assert.equal(fieldValue(embed, 'Rating'), undefined);
});

test('amazon extract: supports amazon gp video detail links', async () => {
    const provider = loadAmazonProviderWithFetch(async (url) => okHtml(primeVideoJsonLdHtml({ name: 'Amazon Video Detail' }), url));

    const url = 'https://www.amazon.com/gp/video/detail/B0H569Z3BN/ref=atv_dp_share_cu_r';
    const result = await provider.extract(createMessage(url), url, {});
    const embed = result[0].embeds[0];

    assert.equal(embed.title, 'Amazon Video Detail');
    assert.equal(embed.url, 'https://amazon.com/gp/video/detail/B0H569Z3BN');
    assert.equal(fieldValue(embed, 'ID'), 'B0H569Z3BN');
});

test('amazon urlPattern: matches product and short Amazon links', () => {
    const provider = loadAmazonProviderWithFetch(async () => okHtml('', ''));
    const re = new RegExp(provider.urlPattern.source, provider.urlPattern.flags);
    const sample = [
        'https://www.amazon.com/dp/B08N5WRWNW',
        'https://amazon.co.jp/-/en/dp/B0DOMTEST1',
        'https://music.amazon.com/albums/B0ALBUM123?trackAsin=B0TRACK123',
        'https://www.primevideo.com/detail/0NQ1QFP6B4R6TM8O2590IV5716',
        'https://www.amazon.com/gp/video/detail/B0H569Z3BN',
        'https://a.co/d/abc123',
        'https://amzn.to/xyz',
        'https://amazonaws.com/not-amazon',
    ].join(' ');

    const matches = sample.match(re) || [];
    assert.deepEqual(matches, [
        'https://www.amazon.com/dp/B08N5WRWNW',
        'https://amazon.co.jp/-/en/dp/B0DOMTEST1',
        'https://music.amazon.com/albums/B0ALBUM123?trackAsin=B0TRACK123',
        'https://www.primevideo.com/detail/0NQ1QFP6B4R6TM8O2590IV5716',
        'https://www.amazon.com/gp/video/detail/B0H569Z3BN',
        'https://a.co/d/abc123',
        'https://amzn.to/xyz',
    ]);
});

test('amazon parse: rejects non-product Amazon pages', () => {
    const provider = require('../../src/providers/amazon');
    assert.equal(
        provider._internal.parseAmazonUrl('https://www.amazon.com/dp/B08N5WRWNW).').asin,
        'B08N5WRWNW'
    );
    assert.equal(provider._internal.parseAmazonUrl('https://music.amazon.com/tracks/B0TRACK123').id, 'B0TRACK123');
    assert.equal(provider._internal.parseAmazonUrl('https://music.amazon.com/search/example'), null);
    assert.equal(provider._internal.parseAmazonUrl('https://www.amazon.com/s?k=headphones'), null);
    assert.equal(provider._internal.parseAmazonUrl('https://example.com/dp/B08N5WRWNW'), null);
});
