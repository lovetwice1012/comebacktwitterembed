'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, fetchPrice, normalizeSource } = require('../../src/providers/priceWatch');

function response(status, body, url = 'https://example.test/') {
    return {
        ok: status >= 200 && status < 300,
        status,
        url,
        json: async () => body,
        text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    };
}

test('price-watch registry discovers only Amazon and Steam adapters', () => {
    assert.deepEqual(Object.keys(PROVIDERS).sort(), ['amazon', 'steam']);
});

test('Amazon price watcher reads the displayed sale and reference price without credentials', async () => {
    const source = normalizeSource('amazon', { url: 'https://www.amazon.co.jp/dp/B012345678', locale: 'ja' });
    const html = [
        '<span id="productTitle">Fixture product</span>',
        '<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">￥1,500</span></span></div>',
        '<div id="basisPrice"><span class="a-text-strike"><span class="a-offscreen">￥2,000</span></span></div>',
    ].join('');
    const snapshot = await fetchPrice({ provider_id: 'amazon', product_url: source.productUrl, source_locale: 'ja' }, {
        fetch: async () => response(200, html, source.productUrl),
    });
    assert.equal(snapshot.priceAmount, 1500);
    assert.equal(snapshot.referencePriceAmount, 2000);
    assert.equal(snapshot.discountPercent, 25);
    assert.equal(snapshot.currency, 'JPY');
});

test('Steam price watcher uses guest app details and preserves the regional currency', async () => {
    const source = normalizeSource('steam', { url: 'https://store.steampowered.com/app/730/CounterStrike_2/', locale: 'ja' });
    const snapshot = await fetchPrice({ provider_id: 'steam', product_url: source.productUrl, source_locale: 'ja' }, {
        fetch: async url => {
            assert.match(String(url), /appdetails/);
            return response(200, {
                730: { success: true, data: { name: 'Fixture game', price_overview: { currency: 'JPY', initial: 300000, final: 150000, discount_percent: 50 } } },
            });
        },
    });
    assert.equal(snapshot.priceAmount, 1500);
    assert.equal(snapshot.referencePriceAmount, 3000);
    assert.equal(snapshot.discountPercent, 50);
});
test('Steam price sources preserve explicit markets without merging different currencies into one source', async () => {
    const jp = normalizeSource('steam', { url: 'https://store.steampowered.com/app/730?cc=jp', locale: 'ja' });
    const us = normalizeSource('steam', { url: 'https://store.steampowered.com/app/730?cc=us&utm_source=fixture', locale: 'ja' });
    assert.equal(jp.productKey, 'app:730', 'keep the existing default-market identity');
    assert.equal(us.productKey, 'app:730:cc:us');
    assert.equal(us.productUrl, 'https://store.steampowered.com/app/730?cc=us');
    const snapshot = await fetchPrice({ provider_id: 'steam', product_url: us.productUrl, source_locale: us.sourceLocale }, { fetch: async raw => {
        assert.equal(new URL(raw).searchParams.get('cc'), 'us');
        return response(200, { 730: { success: true, data: { name: 'Fixture', price_overview: { currency: 'USD', initial: 1000, final: 500, discount_percent: 50 } } } });
    } });
    assert.equal(snapshot.currency, 'USD'); assert.equal(snapshot.productUrl, us.productUrl);
    assert.equal(normalizeSource('steam', { url: 'https://s.team/p/00042', locale: 'en-US' }).productKey, 'package:42');
    assert.throws(() => normalizeSource('steam', { url: 'https://store.steampowered.com.evil.test/app/730', locale: 'ja' }));
});
