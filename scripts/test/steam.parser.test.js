'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSteamPage, parseSteamPrice, cleanText, cleanSteamTitle } = require('../../src/providers/steam/steamSourceParser');

test('Steam source parser extracts source metadata without display truncation', () => {
    const description = 'A long description. '.repeat(100).trim();
    const info = parseSteamPage(`
        <title>Fallback title</title>
        <meta property="og:title" content="Example &amp; Friends on Steam">
        <meta name="twitter:title" content="Ignored title">
        <meta property="og:description" content="${description}">
        <meta property="og:image" content="/images/header.jpg">
    `, 'https://store.steampowered.com/app/123');
    assert.deepEqual(info, {
        title: 'Example & Friends',
        description,
        imageUrl: 'https://store.steampowered.com/images/header.jpg',
    });
});

test('Steam source parser retains title and image fallbacks without application labels', () => {
    assert.deepEqual(parseSteamPage('<title>Steam Community :: Example</title><meta name="description" content="Hello &lt;b&gt;world&lt;/b&gt;"><meta name="twitter:image" content="//cdn.example/image.jpg">', 'https://steamcommunity.com/'), {
        title: 'Example', description: 'Hello world', imageUrl: 'https://cdn.example/image.jpg',
    });
    assert.deepEqual(parseSteamPage('<html></html>', 'https://store.steampowered.com/'), { title: '', description: '', imageUrl: '' });
    assert.equal(cleanText('<script>ignored</script><p>One</p><p>Two &amp; three</p>'), 'One Two & three');
    assert.equal(cleanSteamTitle('Game :: Steam'), 'Game');
});

test('Steam source prices select the requested package cart action instead of an included app', () => {
    const html = `<div class="discount_final_price">$1.00</div>
        <div class="game_purchase_action_bg"><div class="game_purchase_price" data-price-final="200">$2.00</div>
            <a href="javascript:addToCart(1234)">Other package</a></div>
        <div class="game_purchase_action_bg"><div class="discount_block" data-price-final="999" data-discount="50">
            <div class="discount_original_price">$19.99</div><div class="discount_final_price">$9.99</div></div>
            <a href="javascript:addToCart( 123, 1 )">Buy</a></div>`;
    assert.deepEqual(parseSteamPrice(html, 'https://store.steampowered.com/sub/123'), {
        final: 999, final_formatted: '$9.99', discount_percent: 50,
    });
    assert.equal(parseSteamPrice(html, 'https://store.steampowered.com/sub/12'), null);
});

test('Steam source prices use bundle purchase totals and bundle discount', () => {
    const html = `<div class="discount_final_price">¥ 1,200</div>
        <div class="game_purchase_action_bg"><div class="discount_block game_purchase_discount no_discount"
            data-price-final="180000" data-bundlediscount="25" data-discount="0">
            <div class="bundle_base_discount">-25%</div><div class="discount_prices"><div class="discount_final_price">¥ 1,800</div></div></div>
            <a href="javascript:addBundleToCart( 234)">Buy</a></div>`;
    assert.deepEqual(parseSteamPrice(html, 'https://store.steampowered.com/bundle/234'), {
        final: 180000, final_formatted: '¥ 1,800', discount_percent: 25,
    });
    assert.equal(parseSteamPrice(html, 'https://store.steampowered.com/sub/234'), null);
});

test('Steam source prices trust app Offer metadata instead of DLC and recommendation prices', () => {
    const html = `<div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
        <meta itemprop="priceCurrency" content="JPY"><meta itemprop="price" content="1,200"></div>
        <div class="game_purchase_action_bg"><div class="game_purchase_price" data-price-final="20500">¥ 205</div></div>`;
    assert.deepEqual(parseSteamPrice(html, 'https://store.steampowered.com/app/620?cc=jp'), { final: 120000, currency: 'JPY' });
    assert.equal(parseSteamPrice(html.replace(/<div itemprop="offers"[\s\S]*?<\/div>/, ''), 'https://store.steampowered.com/app/620?cc=jp'), null);
    assert.equal(parseSteamPrice(html, 'https://steamcommunity.com/app/620/workshop'), null);
});

test('Steam source prices parse market decimal separators without treating comma decimals as thousands', () => {
    for (const [country, raw, amount] of [['de', '9,75', 975], ['de', '1.234,56', 123456], ['us', '1,234.56', 123456]]) {
        const html = `<div itemprop="offers"><meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="${raw}"></div>`;
        assert.deepEqual(parseSteamPrice(html, 'https://store.steampowered.com/app/620', { country }), { final: amount, currency: 'EUR' });
    }
});

test('Steam source prices omit absent or malformed amounts and ignore script price markup', () => {
    for (const raw of ['', 'null', '-5', 'free', '12abc', '9007199254740992']) {
        const html = `<div class="game_purchase_action_bg"><div class="game_purchase_price" data-price-final="${raw}">$9.99</div>
            <a href="javascript:addToCart(123)">Buy</a></div>`;
        assert.equal(parseSteamPrice(html, 'https://store.steampowered.com/sub/123'), null, raw);
    }
    const html = '<script><div class="game_purchase_action_bg"><div class="game_purchase_price" data-price-final="999">$9.99</div><a href="javascript:addToCart(123)">Buy</a></div></script>';
    assert.equal(parseSteamPrice(html, 'https://store.steampowered.com/sub/123'), null);
});
