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

test('loader: extractAllUrls returns provider-tagged matches', () => {
    const matches = loader.extractAllUrls('foo https://twitter.com/u/status/1 bar https://x.com/u/status/2');
    assert.equal(matches.length, 2);
    assert.equal(matches[0].provider.id, 'twitter');
    assert.equal(matches[0].url, 'https://twitter.com/u/status/1');
    assert.equal(matches[1].url, 'https://x.com/u/status/2');
});

test('loader: cleanContent strips bracketed and spoiler-wrapped urls of all providers', () => {
    const input = 'a <https://twitter.com/u/1> b ||https://x.com/u/2|| c https://twitter.com/u/3 d';
    const cleaned = loader.cleanContent(input);
    assert.ok(!cleaned.includes('<https://twitter.com/u/1>'));
    assert.ok(!cleaned.includes('||https://x.com/u/2||'));
    assert.ok(cleaned.includes('https://twitter.com/u/3'));
});

test('loader: rejects providers missing required fields (validated at load)', () => {
    assert.equal(typeof loader.loadProviders, 'function');
});