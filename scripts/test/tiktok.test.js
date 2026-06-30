'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loader = require('../../src/providers/_loader');

test('loader: tiktok provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const tiktok = providers.find(p => p.id === 'tiktok');
    assert.ok(tiktok, 'tiktok provider should be registered');
    assert.ok(tiktok.urlPattern instanceof RegExp);
    assert.ok(tiktok.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof tiktok.extract, 'function');
    assert.equal(tiktok.enabledByDefault, false);
});

test('loader: extractAllUrls picks up tiktok variants', () => {
    const samples = [
        'https://www.tiktok.com/@user/video/7332187682480590112',
        'https://www.tiktok.com/@user/photo/7335753580093164833',
        'https://www.tiktok.com/@user',
        'https://www.tiktok.com/@user/live',
        'https://m.tiktok.com/v/7332187682480590112.html',
        'https://www.tiktok.com/t/ZPRKrbUB1/',
        'https://vm.tiktok.com/ZPRKrbUB1/',
        'https://vt.tiktok.com/ZPRKrbUB1/',
    ];
    const matches = loader.extractAllUrls(samples.join('\n'));
    const tiktokMatches = matches.filter(m => m.provider.id === 'tiktok');
    assert.equal(tiktokMatches.length, samples.length, 'all sample URLs should be detected');
});

test('loader: tiktok urlPattern does not match unrelated urls', () => {
    const text = 'https://example.com/tiktok https://www.tnktok.com/@u/video/1 https://twitter.com/u/status/1';
    const matches = loader.extractAllUrls(text).filter(m => m.provider.id === 'tiktok');
    assert.equal(matches.length, 0);
});

test('loader: cleanContent strips <...> / ||...|| wrapped tiktok urls', () => {
    const input = 'a <https://www.tiktok.com/@u/video/1> b ||https://vm.tiktok.com/ZPRKrbUB1/|| c https://www.tiktok.com/@u/video/3 d';
    const cleaned = loader.cleanContent(input);
    assert.ok(!cleaned.includes('<https://www.tiktok.com/@u/video/1>'));
    assert.ok(!cleaned.includes('||https://vm.tiktok.com/ZPRKrbUB1/||'));
    assert.ok(cleaned.includes('https://www.tiktok.com/@u/video/3'));
});
