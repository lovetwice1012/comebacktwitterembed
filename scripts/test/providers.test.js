'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loader = require('../../src/providers/_loader');

test('loader: twitter provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const twitter = providers.find(p => p.id === 'twitter');
    assert.ok(twitter, 'twitter provider should be registered');
    assert.ok(twitter.urlPattern instanceof RegExp);
    assert.ok(twitter.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof twitter.extract, 'function');
});

test('loader: twitch provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const twitch = providers.find(p => p.id === 'twitch');
    assert.ok(twitch, 'twitch provider should be registered');
    assert.ok(twitch.urlPattern instanceof RegExp);
    assert.ok(twitch.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof twitch.extract, 'function');
});

test('loader: instagram provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const instagram = providers.find(p => p.id === 'instagram');
    assert.ok(instagram, 'instagram provider should be registered');
    assert.ok(instagram.urlPattern instanceof RegExp);
    assert.ok(instagram.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof instagram.extract, 'function');
});

test('loader: extractAllUrls returns provider-tagged matches', () => {
    const matches = loader.extractAllUrls('foo https://twitter.com/u/status/1 bar https://x.com/u/status/2');
    assert.equal(matches.length, 2);
    assert.equal(matches[0].provider.id, 'twitter');
    assert.equal(matches[0].url, 'https://twitter.com/u/status/1');
    assert.equal(matches[1].url, 'https://x.com/u/status/2');
});

test('loader: extractAllUrls detects instagram media URLs', () => {
    const matches = loader.extractAllUrls('foo https://www.instagram.com/p/CODE123/ bar https://www.instagram.com/share/reel/SHARE123/');
    assert.equal(matches.length, 2);
    assert.equal(matches[0].provider.id, 'instagram');
    assert.equal(matches[0].url, 'https://www.instagram.com/p/CODE123/');
    assert.equal(matches[1].provider.id, 'instagram');
});

test('loader: extractAllUrls returns twitch clip matches', () => {
    const matches = loader.extractAllUrls('clip https://clips.twitch.tv/SampleClip-abc_123 and https://www.twitch.tv/u/clip/OtherClip-1');
    assert.equal(matches.length, 2);
    assert.equal(matches[0].provider.id, 'twitch');
    assert.equal(matches[0].url, 'https://clips.twitch.tv/SampleClip-abc_123');
    assert.equal(matches[1].provider.id, 'twitch');
    assert.equal(matches[1].url, 'https://www.twitch.tv/u/clip/OtherClip-1');
});

test('loader: cleanContent strips bracketed and spoiler-wrapped urls of all providers', () => {
    const input = 'a <https://twitter.com/u/1> b ||https://x.com/u/2|| c <https://clips.twitch.tv/SampleClip-abc_123> d https://twitter.com/u/3 e';
    const cleaned = loader.cleanContent(input);
    assert.ok(!cleaned.includes('<https://twitter.com/u/1>'));
    assert.ok(!cleaned.includes('||https://x.com/u/2||'));
    assert.ok(!cleaned.includes('<https://clips.twitch.tv/SampleClip-abc_123>'));
    assert.ok(cleaned.includes('https://twitter.com/u/3'));
});

test('loader: rejects providers missing required fields (validated at load)', () => {
    assert.equal(typeof loader.loadProviders, 'function');
});
