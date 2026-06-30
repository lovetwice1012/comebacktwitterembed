'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loader = require('../../src/providers/_loader');

test('loader: youtube provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const youtube = providers.find(p => p.id === 'youtube');
    assert.ok(youtube, 'youtube provider should be registered');
    assert.ok(youtube.urlPattern instanceof RegExp);
    assert.ok(youtube.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof youtube.extract, 'function');
    assert.equal(youtube.enabledByDefault, false);
});

test('loader: extractAllUrls picks up youtube variants', () => {
    const samples = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtube.com/shorts/dQw4w9WgXcQ',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ?t=43',
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        'https://www.youtube.com/@youtube',
        'https://www.youtube.com/playlist?list=PL123',
    ];
    const matches = loader.extractAllUrls(samples.join('\n'));
    const youtubeMatches = matches.filter(m => m.provider.id === 'youtube');
    assert.equal(youtubeMatches.length, samples.length, 'all sample URLs should be detected');
});

test('loader: youtube urlPattern does not match unrelated or already-rewritten urls', () => {
    const text = 'https://example.com/youtube https://koutube.com/watch?v=dQw4w9WgXcQ https://koutu.be/dQw4w9WgXcQ https://twitter.com/u/status/1';
    const matches = loader.extractAllUrls(text).filter(m => m.provider.id === 'youtube');
    assert.equal(matches.length, 0);
});

test('loader: cleanContent strips <...> / ||...|| wrapped youtube urls', () => {
    const input = 'a <https://www.youtube.com/watch?v=one> b ||https://youtu.be/two|| c https://youtube.com/shorts/three d';
    const cleaned = loader.cleanContent(input);
    assert.ok(!cleaned.includes('<https://www.youtube.com/watch?v=one>'));
    assert.ok(!cleaned.includes('||https://youtu.be/two||'));
    assert.ok(cleaned.includes('https://youtube.com/shorts/three'));
});
