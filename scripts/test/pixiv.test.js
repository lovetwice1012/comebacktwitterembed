'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loader = require('../../src/providers/_loader');

test('loader: pixiv provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const pixiv = providers.find(p => p.id === 'pixiv');
    assert.ok(pixiv, 'pixiv provider should be registered');
    assert.ok(pixiv.urlPattern instanceof RegExp);
    assert.ok(pixiv.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof pixiv.extract, 'function');
    assert.equal(pixiv.enabledByDefault, false);
});

test('loader: extractAllUrls picks up pixiv variants (artworks / i / member_illust / phixiv / ppxiv / lang prefix)', () => {
    const samples = [
        'https://www.pixiv.net/artworks/124748386',
        'https://pixiv.net/en/artworks/124748386',
        'https://www.pixiv.net/artworks/124748386/2',
        'https://www.pixiv.net/artworks/124748386/1-3',
        'https://www.pixiv.net/i/124748386',
        'https://www.pixiv.net/member_illust.php?illust_id=124748386',
        'https://www.phixiv.net/artworks/124748386',
        'https://c.ppxiv.net/artworks/124748386',
    ];
    const matches = loader.extractAllUrls(samples.join('\n'));
    const pixivMatches = matches.filter(m => m.provider.id === 'pixiv');
    assert.equal(pixivMatches.length, samples.length, 'all sample URLs should be detected');
});

test('loader: pixiv urlPattern does not match unrelated urls', () => {
    const text = 'https://twitter.com/u/status/1 https://example.com/pixiv https://www.pixiv.net/users/123';
    const matches = loader.extractAllUrls(text).filter(m => m.provider.id === 'pixiv');
    assert.equal(matches.length, 0, '/users/ and look-alikes must not match');
});

test('loader: cleanContent strips <...> / ||...|| wrapped pixiv urls', () => {
    const input = 'a <https://www.pixiv.net/artworks/1> b ||https://phixiv.net/artworks/2|| c https://pixiv.net/artworks/3 d';
    const cleaned = loader.cleanContent(input);
    assert.ok(!cleaned.includes('<https://www.pixiv.net/artworks/1>'));
    assert.ok(!cleaned.includes('||https://phixiv.net/artworks/2||'));
    assert.ok(cleaned.includes('https://pixiv.net/artworks/3'));
});
