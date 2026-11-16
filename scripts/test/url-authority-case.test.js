'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractAllUrls, cleanContent } = require('../../src/providers/_loader');

test('recognition ignores scheme and host case while retaining exact source paths', () => {
    const samples = [
        ['youtube', 'HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ'],
        ['pixiv', 'https://WWW.PIXIV.NET/artworks/123456'],
        ['github', 'HTTPS://GITHUB.COM/octocat'],
        ['instagram', 'HTTPS://WWW.INSTAGRAM.COM/Instagram/'],
        ['spotify', 'HTTPS://OPEN.SPOTIFY.COM/track/4cOdK2wGLETKBW3PvgPWqT'],
        ['twitch', 'HTTPS://WWW.TWITCH.TV/twitch'],
        ['tiktok', 'HTTPS://WWW.TIKTOK.COM/@tiktok'],
        ['twitter', 'HTTPS://WWW.X.COM/example/status/1234567890123456789'],
        ['youtube', 'HTTPS://WWW.YOUTUBE.COM:443/watch?v=dQw4w9WgXcQ'],
        ['pixiv', 'HTTP://WWW.PIXIV.NET:80/artworks/123456'],
        ['youtube', 'https://www.youtube.com:00443/watch?v=dQw4w9WgXcQ'],
        ['pixiv', 'http://www.pixiv.net:00080/artworks/123456'],
    ];
    for (const [providerId, url] of samples) {
        const found = extractAllUrls(`prefix https://İ.example/ then ${url} suffix`);
        assert(found.some(item => item.provider.id === providerId && item.url === url), providerId);
    }
});

test('suppressed links stay suppressed regardless of scheme and host case', () => {
    const input = 'keep <HTTPS://WWW.YOUTUBE.COM:443/watch?v=dQw4w9WgXcQ> and ||HTTPS://WWW.INSTAGRAM.COM/Instagram/|| end';
    const cleaned = cleanContent(input);
    assert.equal(cleaned, 'keep  and  end');
    assert.deepEqual(extractAllUrls(cleaned), []);
});

test('multiple normalized authorities retain original offsets, punctuation and selectors', () => {
    const pixiv = 'HTTPS://WWW.PIXIV.NET:443/artworks/123456#2';
    const youtube = 'HTTPS://WWW.YOUTUBE.COM:443/watch?v=dQw4w9WgXcQ';
    const input = `🐱 ${pixiv} then ${youtube}`;
    const found = extractAllUrls(input);
    assert.deepEqual(found.map(item => [item.provider.id, item.url]), [['pixiv', pixiv], ['youtube', youtube]]);
    assert.equal(cleanContent(`🐱 <${pixiv}> and ||${youtube}||`), '🐱  and ');
});

test('case normalization cannot turn foreign or userinfo hosts into supported links', () => {
    for (const url of ['HTTPS://GITHUB.COM.evil.example/octocat', 'HTTPS://user@GITHUB.COM/octocat', 'HTTPS://GITHUB.COM:443@evil.example/octocat', 'HTTPS://GITHUB.COM:444/octocat'])
        assert.equal(extractAllUrls(url).some(item => item.provider.id === 'github'), false);
});

test('X www and non-www aliases deduplicate the same post without changing the chosen source', () => {
    const first = 'HTTPS://WWW.X.COM/example/status/1234567890123456789';
    const found = extractAllUrls(`${first} https://twitter.com/example/status/1234567890123456789`)
        .filter(item => item.provider.id === 'twitter');
    assert.deepEqual(found.map(item => item.url), [first]);
    const internal = `https://x.com/i/web/status/1234567890123456789`;
    const aliases = extractAllUrls(`${internal} https://twitter.com/example/status/1234567890123456789`)
        .filter(item => item.provider.id === 'twitter');
    assert.deepEqual(aliases.map(item => item.url), [internal]);
});
