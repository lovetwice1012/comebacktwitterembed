'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const parser = require('../../src/providers/amazon/amazonSourceParser');

function jsonLdHtml(value) {
    return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

test('amazon parser: copied folder parses all source types without the provider or dependencies', (t) => {
    const temporaryRoot = path.resolve(os.tmpdir());
    const copiedFolder = fs.mkdtempSync(path.join(temporaryRoot, 'amazon-source-parser-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(copiedFolder)), temporaryRoot);
        assert.ok(path.basename(copiedFolder).startsWith('amazon-source-parser-'));
        fs.rmSync(copiedFolder, { recursive: true, force: true });
    });
    fs.cpSync(path.resolve(__dirname, '../../src/providers/amazon/amazonSourceParser'), copiedFolder, { recursive: true });
    const copied = require(copiedFolder);

    const product = copied.extractProductInfo(jsonLdHtml({
        '@type': 'Product',
        name: 'Portable product',
        image: '/product.jpg',
        offers: { price: '12.50', priceCurrency: 'USD' },
    }), { canonicalUrl: 'https://amazon.com/dp/B08N5WRWNW' });
    assert.equal(product.title, 'Portable product');
    assert.equal(product.imageUrl, 'https://amazon.com/product.jpg');
    assert.equal(product.price, '$12.50');
    assert.equal(product.priceAmount, 12.5);
    assert.equal(product.priceCurrency, 'USD');

    const music = copied.extractAmazonMusicInfo(jsonLdHtml({
        '@type': 'MusicRecording',
        name: 'Portable song',
        byArtist: { name: 'Example Artist' },
    }), { canonicalUrl: 'https://music.amazon.com/tracks/B0TRACK123', route: 'tracks' });
    assert.equal(music.title, 'Portable song');
    assert.equal(music.artist, 'Example Artist');
    assert.equal(music.musicType, 'Track');

    const video = copied.extractPrimeVideoInfo(jsonLdHtml({
        '@type': 'Movie',
        name: 'Portable movie',
        genre: ['Drama', 'Comedy'],
        duration: 'PT1H42M',
    }), { canonicalUrl: 'https://www.primevideo.com/detail/B0H569Z3BN' });
    assert.equal(video.title, 'Portable movie');
    assert.equal(video.genre, 'Drama, Comedy');
    assert.equal(video.duration, '1h 42m');
});

test('amazon parser: description limits are numeric and retain the default', () => {
    const description = 'x'.repeat(750);
    for (const [extract, type, parsed] of [
        [parser.extractProductInfo, 'Product', { canonicalUrl: 'https://amazon.com/dp/B08N5WRWNW' }],
        [parser.extractAmazonMusicInfo, 'MusicRecording', { canonicalUrl: 'https://music.amazon.com/tracks/B0TRACK123', route: 'tracks' }],
        [parser.extractPrimeVideoInfo, 'Movie', { canonicalUrl: 'https://www.primevideo.com/detail/B0H569Z3BN' }],
    ]) {
        const html = jsonLdHtml({ '@type': type, name: 'Example', description });
        assert.equal(extract(html, parsed).description, 'x'.repeat(697) + '...');
        assert.equal(extract(html, parsed, 12).description, 'x'.repeat(9) + '...');
        assert.equal(extract(html, parsed, 0).description, '');
    }
});

test('amazon parser: music accepts fetched oEmbed metadata without performing requests', () => {
    const info = parser.extractAmazonMusicInfo(
        '<meta property="og:description" content="On Amazon Music"><a aria-label="artist, Example Artist">Example Artist</a>',
        { canonicalUrl: 'https://music.amazon.com/tracks/B0TRACK123', route: 'tracks' },
        12,
        { oembed: { title: 'Example song', description: 'abcdefghijklmnopqrstuvwxyz', thumbnail_url: '/cover.jpg' } }
    );

    assert.equal(info.title, 'Example song');
    assert.equal(info.artist, 'Example Artist');
    assert.equal(info.description, 'abcdefghi...');
    assert.equal(info.imageUrl, 'https://music.amazon.com/cover.jpg');
    assert.equal(parser.iframeSrcFromHtml('<iframe src="/embed/track?a=1&amp;b=2"></iframe>', 'https://music.amazon.com/embed/oembed'),
        'https://music.amazon.com/embed/track?a=1&b=2');
});

test('amazon provider parser adapters keep settings and density out of the pure parser', () => {
    const adapters = require('../../src/providers/amazon/parsing');
    const html = jsonLdHtml({ '@type': 'Product', name: 'Example', description: 'x'.repeat(750) });
    const parsed = { kind: 'product', canonicalUrl: 'https://amazon.com/dp/B08N5WRWNW' };

    assert.equal(adapters.extractProductInfo(html, parsed, { display_density: 'compact' }).description,
        'x'.repeat(197) + '...');
    assert.equal(adapters.extractProductInfo(html, parsed, { amazon_description_max_length: 12 }).description,
        'x'.repeat(9) + '...');
});

function parseProductPrice(html, host = 'amazon.com', locale = 'en-US') {
    return parser.extractProductInfo(html, { canonicalUrl: `https://${host}/dp/B08N5WRWNW` }, 700, locale);
}

test('amazon prices: structured offers format in the requested locale without converting currency', () => {
    for (const [value, currency, host, locale, expected] of [
        ['1234.56', 'EUR', 'amazon.de', 'de', '1.234,56 €'],
        [27980, 'JPY', 'amazon.co.jp', 'ja', '￥27,980'],
        ['0', 'JPY', 'amazon.co.jp', 'ja', '￥0'],
        ['12.50', 'GBP', 'amazon.co.uk', 'en-GB', '£12.50'],
        ['12.50', 'USD', 'amazon.co.jp', 'en-GB', 'US$12.50'],
    ]) {
        const info = parseProductPrice(jsonLdHtml({ '@type': 'Product', name: 'Example', offers: { price: value, priceCurrency: currency } }), host, locale);
        assert.equal(info.price.replace(/\u00a0/g, ' '), expected);
        assert.equal(info.priceAmount, Number(value));
        assert.equal(info.priceCurrency, currency);
    }
});

test('amazon prices: main sale price wins over ratings, list price, unit prices and stale JSON-LD', () => {
    const html = jsonLdHtml({ '@type': 'Product', name: 'Example', offers: { price: '99.99', priceCurrency: 'EUR' } }) + `
        <span class="a-offscreen">4.5 out of 5 stars</span>
        <div id="corePriceDisplay_desktop_feature_div">
            <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">99,99 €</span></span>
            <span class="pricePerUnit"><span class="a-price"><span class="a-offscreen">0,25 €</span></span></span>
            <span class="a-price"><span class="a-offscreen">2,50 €</span></span>
            <span class="a-price priceToPay"><span class="a-offscreen">12,50 €</span></span>
        </div>`;
    const info = parseProductPrice(html, 'amazon.de', 'de');
    assert.equal(info.priceAmount, 12.5);
    assert.equal(info.priceCurrency, 'EUR');
    assert.equal(info.price.replace(/\u00a0/g, ' '), '12,50 €');
});

test('amazon prices: nested whole/fraction markup and empty accessibility span retain the full amount', () => {
    for (const [symbol, whole, fraction, host, amount] of [
        ['￥', '27,980', '', 'amazon.co.jp', 27980],
        ['€', '1.234<span class="a-price-decimal">,</span>', '56', 'amazon.de', 1234.56],
        ['$', '1,234<span class="a-price-decimal">.</span>', '56', 'amazon.com', 1234.56],
    ]) {
        const html = `<div id="corePriceDisplay_desktop_feature_div"><div><span class="a-price priceToPay apex-pricetopay-value">
            <span class="a-offscreen"></span><span aria-hidden="true">
            <span class="a-price-symbol">${symbol}</span><span class="a-price-whole">${whole}</span><span class="a-price-fraction">${fraction}</span>
            </span></span></div></div>`;
        assert.equal(parseProductPrice(html, host).priceAmount, amount);
    }
});

test('amazon prices: localized separators and marketplace dollar currencies parse correctly', () => {
    for (const [raw, host, expected, currency] of [
        ['1.234,56 €', 'amazon.de', 1234.56, 'EUR'],
        ['1&#8239;234,56 €', 'amazon.fr', 1234.56, 'EUR'],
        ['₹1,23,456.78', 'amazon.in', 123456.78, 'INR'],
        ['$1,234.56', 'amazon.ca', 1234.56, 'CAD'],
        ['$0.00', 'amazon.com.au', 0, 'AUD'],
        ['R$1.234,56', 'amazon.com.br', 1234.56, 'BRL'],
        ['US$12.50', 'amazon.co.jp', 12.5, 'USD'],
        ['27980円', 'amazon.com', 27980, 'JPY'],
        ['19,99&nbsp;&euro;', 'amazon.de', 19.99, 'EUR'],
        ['&pound;19.99', 'amazon.co.uk', 19.99, 'GBP'],
        ['&yen;1,299', 'amazon.co.jp', 1299, 'JPY'],
    ]) {
        const info = parseProductPrice(`<span id="priceblock_ourprice">${raw}</span>`, host);
        assert.equal(info.priceAmount, expected, raw);
        assert.equal(info.priceCurrency, currency, raw);
    }
});

test('amazon prices: metadata is a fallback after the current product price', () => {
    const meta = '<meta property="product:price:amount" content="24.50"><meta property="product:price:currency" content="GBP">';
    assert.equal(parseProductPrice(meta, 'amazon.co.uk', 'en-GB').price, '£24.50');
    assert.equal(parseProductPrice(meta + '<span id="priceblock_dealprice">£12.50</span>', 'amazon.co.uk').priceAmount, 12.5);
});

test('amazon prices: explicit apexPriceToPay stays eligible when a-text-price is a styling class', () => {
    const html = '<div id="corePrice_feature_div"><span class="a-price a-text-price a-size-medium apexPriceToPay" data-a-color="price"><span class="a-offscreen">£22.86</span></span></div>';
    assert.equal(parseProductPrice(html, 'amazon.co.uk').priceAmount, 22.86);
    assert.equal(parseProductPrice(html.replace('data-a-color="price"', 'data-a-strike="true"'), 'amazon.co.uk').price, '');
});

test('amazon prices: missing, malformed, unrelated and ambiguous prices are omitted', () => {
    for (const html of [
        '<span class="a-offscreen">4.5 out of 5 stars</span>',
        '<span class="a-price"><span class="a-offscreen">$12.50</span></span>',
        '<div id="corePrice_feature_div"><span class="a-price a-text-price"><span class="a-offscreen">$12.50</span></span></div>',
        '<div id="corePrice_feature_div"><span class="pricePerUnit"><span class="a-price"><span class="a-offscreen">$0.50</span></span></span></div>',
        '<span id="priceblock_ourprice">Save $12.50</span>',
        '<span id="priceblock_ourprice">$12,34,56</span>',
        '<span id="priceblock_ourprice">$12.50 - $24.00</span>',
        '<span id="priceblock_ourprice">-$12.50</span>',
        ...[undefined, null, '', 'Not available', -1, {}, '1e500'].map(price => jsonLdHtml({ '@type': 'Product', name: 'Example', offers: { price, priceCurrency: 'USD' } })),
        jsonLdHtml({ '@type': 'Product', name: 'Example', offers: { price: 12.5, priceCurrency: 'BAD' } }),
    ]) {
        const info = parseProductPrice(html);
        assert.equal(info.price, '', html);
        assert.equal(info.priceAmount, null, html);
    }
    assert.equal(parseProductPrice('<span id="priceblock_ourprice">$12.50</span>', 'amazon.co.jp').price, '');
});

test('amazon provider parser adapter keeps the full configured currency display locale', () => {
    const adapters = require('../../src/providers/amazon/parsing');
    const html = jsonLdHtml({ '@type': 'Product', name: 'Example', offers: { price: '12.50', priceCurrency: 'USD' } });
    const parsed = { canonicalUrl: 'https://amazon.com/dp/B08N5WRWNW' };
    assert.equal(adapters.extractProductInfo(html, parsed, { defaultLanguage: 'en-GB' }).price, 'US$12.50');
    assert.equal(adapters.extractProductInfo(html, parsed, { defaultLanguage: 'en-US' }).price, '$12.50');
});
