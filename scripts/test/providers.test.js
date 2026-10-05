'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loader = require('../../src/providers/_loader');

test('loader: expands mixed providers in text order and removes repeated links', () => {
    const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXc';
    const twitter = 'https://x.com/example/status/123';
    const github = 'https://github.com/openai/codex';
    for (let i = 0; i < 3; i++) {
        assert.deepEqual(loader.extractAllUrls(`${youtube} ${twitter} ${github} ${youtube} ${twitter}`)
            .map(({ provider, url }) => ({ provider: provider.id, url })), [
            { provider: 'youtube', url: youtube }, { provider: 'twitter', url: twitter }, { provider: 'github', url: github },
        ]);
    }
});

test('loader: X aliases and tracking links share one identity but retain the first URL', () => {
    const first = 'https://twitter.com/old_name/status/123?s=20&utm_source=share';
    assert.deepEqual(loader.extractAllUrls(`${first} https://x.com/new_name/status/123/?t=tracking`)
        .map(item => item.url), [first]);
});

test('loader: deduplication preserves media selections, time offsets and distinct content', () => {
    for (const urls of [
        ['https://www.instagram.com/p/CODE123/?img_index=1', 'https://www.instagram.com/p/CODE123/?img_index=2'],
        ['https://www.youtube.com/watch?v=dQw4w9WgXc&t=10', 'https://www.youtube.com/watch?v=dQw4w9WgXc&t=20'],
        ['https://x.com/u/status/1', 'https://x.com/u/status/2'],
    ]) assert.deepEqual(loader.extractAllUrls(urls.join(' ')).map(item => item.url), urls);
    assert.deepEqual(loader.extractAllUrls(loader.cleanContent('<https://x.com/u/status/1> ||https://x.com/u/status/2||')), []);
});

test('split providers keep global URL matcher state independent when reloaded', () => {
    const samples = {
        amazon: 'https://www.amazon.com/dp/B08N5WRWNW',
        github: 'https://github.com/openai/codex',
        instagram: 'https://www.instagram.com/p/CODE123/',
        youtube: 'https://youtu.be/dQw4w9WgXcQ',
    };
    for (const [id, url] of Object.entries(samples)) {
        const filename = require.resolve(`../../src/providers/${id}`);
        const originalModule = require.cache[filename];
        try {
            delete require.cache[filename];
            const first = require(filename);
            delete require.cache[filename];
            const second = require(filename);

            assert.equal(first.urlPattern.test(url), true, id);
            assert.equal(second.urlPattern.lastIndex, 0, `${id} must own its matcher cursor`);
            assert.equal(second.urlPattern.test(url), true, id);
            assert.notStrictEqual(first.urlPattern, second.urlPattern, id);
        } finally {
            delete require.cache[filename];
            if (originalModule) require.cache[filename] = originalModule;
        }
    }
});

test('cached URL regexes preserve repeated-call results and explicit URL suppression', () => {
    const input = 'hello <https://x.com/u/status/1> ||https://github.com/a/b|| https://x.com/u/status/2';
    const expected = [{ provider: 'twitter', url: 'https://x.com/u/status/2' }];
    for (let i = 0; i < 20; i++) {
        assert.deepEqual(loader.extractAllUrls(loader.cleanContent(input)).map(item => ({ provider: item.provider.id, url: item.url })), expected);
    }
    loader._resetForTest();
    assert.equal(loader.extractAllUrls('https://x.com/u/status/2').length, 1);
});

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
    assert.equal(instagram.enabledByDefault, false);
});

test('loader: amazon provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const amazon = providers.find(p => p.id === 'amazon');
    assert.ok(amazon, 'amazon provider should be registered');
    assert.ok(amazon.urlPattern instanceof RegExp);
    assert.ok(amazon.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof amazon.extract, 'function');
    assert.equal(amazon.enabledByDefault, false);
});

test('loader: github provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const github = providers.find(p => p.id === 'github');
    assert.ok(github, 'github provider should be registered');
    assert.ok(github.urlPattern instanceof RegExp);
    assert.ok(github.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof github.extract, 'function');
    assert.equal(github.enabledByDefault, false);
});

test('loader: steam provider is registered with required keys', () => {
    const providers = loader.loadProviders();
    const steam = providers.find(p => p.id === 'steam');
    assert.ok(steam, 'steam provider should be registered');
    assert.ok(steam.urlPattern instanceof RegExp);
    assert.ok(steam.urlPattern.global, 'urlPattern must have global flag');
    assert.equal(typeof steam.extract, 'function');
    assert.equal(steam.enabledByDefault, false);
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

test('loader: extractAllUrls detects instagram profile URLs', () => {
    const matches = loader.extractAllUrls('profile https://www.instagram.com/artist.profile/ not https://www.instagram.com/accounts/login/');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].provider.id, 'instagram');
    assert.equal(matches[0].url, 'https://www.instagram.com/artist.profile/');
});

test('loader: extractAllUrls detects Amazon product, Music, Prime Video, and short URLs', () => {
    const matches = loader.extractAllUrls('item https://www.amazon.com/dp/B08N5WRWNW music https://music.amazon.com/tracks/B0TRACK123 prime https://www.primevideo.com/detail/0NQ1QFP6B4R6TM8O2590IV5716 short https://a.co/d/abc123');
    assert.equal(matches.length, 4);
    assert.equal(matches[0].provider.id, 'amazon');
    assert.equal(matches[0].url, 'https://www.amazon.com/dp/B08N5WRWNW');
    assert.equal(matches[1].provider.id, 'amazon');
    assert.equal(matches[1].url, 'https://music.amazon.com/tracks/B0TRACK123');
    assert.equal(matches[2].provider.id, 'amazon');
    assert.equal(matches[2].url, 'https://www.primevideo.com/detail/0NQ1QFP6B4R6TM8O2590IV5716');
    assert.equal(matches[3].provider.id, 'amazon');
    assert.equal(matches[3].url, 'https://a.co/d/abc123');
});

test('loader: extractAllUrls detects Steam Store, Community, and short URLs', () => {
    const matches = loader.extractAllUrls('game https://store.steampowered.com/app/730/CounterStrike_2/ workshop https://steamcommunity.com/sharedfiles/filedetails/?id=12345 short https://s.team/a/730');
    assert.equal(matches.length, 3);
    assert.equal(matches[0].provider.id, 'steam');
    assert.equal(matches[0].url, 'https://store.steampowered.com/app/730/CounterStrike_2/');
    assert.equal(matches[1].provider.id, 'steam');
    assert.equal(matches[1].url, 'https://steamcommunity.com/sharedfiles/filedetails/?id=12345');
    assert.equal(matches[2].provider.id, 'steam');
    assert.equal(matches[2].url, 'https://s.team/a/730');
});

test('loader: extractAllUrls detects GitHub repository and issue URLs', () => {
    const matches = loader.extractAllUrls('repo https://github.com/openai/codex issue https://github.com/owner/repo/issues/42 gist https://gist.github.com/octocat/abcdef');
    assert.equal(matches.length, 3);
    assert.equal(matches[0].provider.id, 'github');
    assert.equal(matches[0].url, 'https://github.com/openai/codex');
    assert.equal(matches[1].provider.id, 'github');
    assert.equal(matches[1].url, 'https://github.com/owner/repo/issues/42');
    assert.equal(matches[2].provider.id, 'github');
    assert.equal(matches[2].url, 'https://gist.github.com/octocat/abcdef');
});

test('loader: extractAllUrls returns twitch clip matches', () => {
    const matches = loader.extractAllUrls('clip https://clips.twitch.tv/SampleClip-abc_123 and https://www.twitch.tv/user123/clip/OtherClip-1');
    assert.equal(matches.length, 2);
    assert.equal(matches[0].provider.id, 'twitch');
    assert.equal(matches[0].url, 'https://clips.twitch.tv/SampleClip-abc_123');
    assert.equal(matches[1].provider.id, 'twitch');
    assert.equal(matches[1].url, 'https://www.twitch.tv/user123/clip/OtherClip-1');
});

test('loader: cleanContent strips bracketed and spoiler-wrapped urls of all providers', () => {
    const input = 'a <https://twitter.com/u/1> b ||https://x.com/u/2|| c <https://clips.twitch.tv/SampleClip-abc_123> d ||https://www.instagram.com/artist.profile/|| e https://twitter.com/u/3 f';
    const cleaned = loader.cleanContent(input);
    assert.ok(!cleaned.includes('<https://twitter.com/u/1>'));
    assert.ok(!cleaned.includes('||https://x.com/u/2||'));
    assert.ok(!cleaned.includes('<https://clips.twitch.tv/SampleClip-abc_123>'));
    assert.ok(!cleaned.includes('||https://www.instagram.com/artist.profile/||'));
    assert.ok(cleaned.includes('https://twitter.com/u/3'));
});

test('loader: rejects providers missing required fields (validated at load)', () => {
    assert.equal(typeof loader.loadProviders, 'function');
});
