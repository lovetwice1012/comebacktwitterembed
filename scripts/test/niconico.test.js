'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loader = require('../../src/providers/_loader');

test('loader: niconico provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const niconico = providers.find(p => p.id === 'niconico');
    assert.ok(niconico, 'niconico provider should be registered');
    assert.ok(niconico.urlPattern instanceof RegExp);
    assert.ok(niconico.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof niconico.extract, 'function');
    assert.equal(niconico.enabledByDefault, false);
});

test('loader: extractAllUrls picks up niconico variants', () => {
    const samples = [
        'https://www.nicovideo.jp/watch/sm9',
        'https://nicovideo.jp/watch/1438681954?from=1',
        'https://sp.nicovideo.jp/watch/so12345678',
        'https://nico.ms/sm9',
    ];
    const matches = loader.extractAllUrls(samples.join('\n'));
    const niconicoMatches = matches.filter(m => m.provider.id === 'niconico');
    assert.equal(niconicoMatches.length, samples.length, 'all sample URLs should be detected');
});

test('loader: niconico urlPattern does not match unrelated domains', () => {
    const text = 'https://example.com/watch/sm9 https://notnicovideo.jp/watch/sm9 https://twitter.com/u/status/1';
    const matches = loader.extractAllUrls(text).filter(m => m.provider.id === 'niconico');
    assert.equal(matches.length, 0);
});

test('loader: cleanContent strips <...> / ||...|| wrapped niconico urls', () => {
    const input = 'a <https://www.nicovideo.jp/watch/sm9> b ||https://nico.ms/sm10|| c https://www.nicovideo.jp/watch/sm11 d';
    const cleaned = loader.cleanContent(input);
    assert.ok(!cleaned.includes('<https://www.nicovideo.jp/watch/sm9>'));
    assert.ok(!cleaned.includes('||https://nico.ms/sm10||'));
    assert.ok(cleaned.includes('https://www.nicovideo.jp/watch/sm11'));
});
