'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');

function fixture({ description, url = 'https://x.com/example/status/1234567890123456789', translateOriginal = false, response = 'translated', locale = 'en-US', quote = { description: 'quoted post' }, realNormalizer = false }) {
    const filename = require.resolve('../../src/components/translate'), actual = createRequire(filename), mod = { exports: {} }, requests = [], edits = [], replies = [];
    const mocks = {
        '../providerFetch': { withDeadline: () => async target => { requests.push(new URL(target)); const index = requests.length - 1;
            return { ok: true, text: async () => Array.isArray(response) ? response[index] : response }; } },
        '../settings': { detectProviderIdFromMessage: () => 'twitter', checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async value => value },
        '../providers/_provider_settings': { getSetting: async () => translateOriginal },
        '../interactionResponse': realNormalizer ? actual('../interactionResponse') : { normalizeEmbed: value => value },
    };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
        id => Object.hasOwn(mocks, id) ? mocks[id] : actual(id), mod, mod.exports);
    const interaction = { guildId: 'fixture', locale, message: {
        embeds: [{ url, description }, quote], components: [], attachments: [],
        edit: async value => { edits.push(value); },
    }, editReply: async value => { replies.push(value); } };
    return { handle: () => mod.exports.handle(interaction), requests, replies, edits };
}

test('translation preserves real Discord quote embeds and supports Latin American Spanish', async () => {
    const { Embed, Locale } = require('discord.js');
    const quote = new Embed({ title: 'Quote', description: 'Quoted text', image: { url: 'https://example.test/quote.png' } });
    const f = fixture({ description: 'original', translateOriginal: true, locale: Locale.SpanishLATAM, quote, realNormalizer: true });
    await f.handle();
    assert.equal(f.requests[0].searchParams.get('target'), 'es');
    for (const result of [f.replies[0], f.edits[0]]) {
        assert.equal(result.embeds[1].description, 'Quoted text');
        assert.equal(result.embeds[1].image.url, 'https://example.test/quote.png');
        assert.equal(Object.hasOwn(result.embeds[1], 'data'), false);
    }
});

test('translation includes every line of an X post while preserving its generated link and optional statistics', async () => {
    const url = 'https://x.com/example/status/1234567890123456789', body = 'one\ntwo\nthree\nfour\nfive\nsix';
    for (const suffix of [`\n\n[View on Twitter](${url})`, `\n\n[Twitter で見る](${url})\n\n:speech_balloon:1件のリプライ • :recycle:2件のリポスト • :heart:3件のいいね`]) {
        const f = fixture({ description: body + suffix, url, translateOriginal: true });
        await f.handle();
        assert.equal(f.requests.length, 1); assert.equal(f.requests[0].searchParams.get('text'), body);
        assert.equal(f.replies[0].embeds[0].description, 'translated' + suffix);
        assert.equal(f.edits[0].embeds[0].description, 'translated' + suffix);
        assert.equal(f.edits[0].embeds[1].description, 'quoted post');
    }
});

test('translation respects text and statistics settings in real X extraction output', async () => {
    const providerPath = require.resolve('../../src/providers/twitter'), fetchPath = require.resolve('node-fetch');
    const oldProvider = require.cache[providerPath], oldFetch = require.cache[fetchPath];
    const body = 'first\nsecond\nthird\nfourth\nfifth\nsixth', url = 'https://twitter.com/a/status/1234567890123456789';
    const tweet = { tweetURL: url, text: body, user_name: 'Fixture', user_screen_name: 'fixture', replies: 1, retweets: 2, likes: 3,
        date: '2024-01-01T00:00:00Z', mediaURLs: [], qrtURL: null };
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async target =>
        ({ text: async () => String(target).includes('altterx.sprink.cloud') ? 'ok' : JSON.stringify(tweet) }) };
    delete require.cache[providerPath];
    try {
        const provider = require(providerPath);
        const message = { guild: { id: 'fixture', members: { me: { permissions: { has: () => false } } } },
            channel: { send: async () => ({}) }, author: { id: '111111111111111111', username: 'fixture' }, content: url };
        for (const settings of [{ twitter_stats_layout: 'description' }, { twitter_stats_layout: 'fields' }, { hidden_output_items: ['stats'] }]) {
            const [step] = await provider.extract(message, url, { legacy_mode: true, ...settings });
            const f = fixture({ description: step.embeds[0].description, url }); await f.handle();
            assert.equal(f.requests[0].searchParams.get('text'), body);
            assert.match(f.replies[0].embeds[0].description, /^translated\n\n\[View on Twitter\]/);
        }
        const [linkOnly] = await provider.extract(message, url, { legacy_mode: true, twitter_text_mode: 'link_only', hidden_output_items: ['stats'] });
        const f = fixture({ description: linkOnly.embeds[0].description, url }); await f.handle();
        assert.equal(f.requests.length, 0); assert.equal(f.replies[0].embeds[0].description, linkOnly.embeds[0].description);
        tweet.article = { title: 'Article title', preview_text: 'Article preview' };
        const [article] = await provider.extract(message, url, { legacy_mode: true, twitter_text_mode: 'link_only' });
        const articleTranslation = fixture({ description: article.embeds[0].description, url }); await articleTranslation.handle();
        assert.equal(articleTranslation.requests.length, 1);
        assert.match(articleTranslation.requests[0].searchParams.get('text'), /Article title/);
        assert.doesNotMatch(articleTranslation.requests[0].searchParams.get('text'), /View on Twitter|:speech_balloon:/);
    } finally {
        delete require.cache[providerPath]; if (oldProvider) require.cache[providerPath] = oldProvider;
        if (oldFetch) require.cache[fetchPath] = oldFetch; else delete require.cache[fetchPath];
    }
});

test('link-only and statistics-only X displays are preserved without translating or deleting metadata', async () => {
    const url = 'https://x.com/example/status/1234567890123456789';
    for (const description of [`[View on Twitter](${url})`, ':speech_balloon:0 replies • :recycle:1 retweets • :heart:2 likes']) {
        const f = fixture({ description, url, translateOriginal: true });
        await f.handle();
        assert.equal(f.requests.length, 0); assert.equal(f.replies[0].embeds[0].description, description);
        assert.equal(f.edits[0].embeds[0].description, description);
    }
});

test('article text following generated X metadata is translated without changing the link or statistics', async () => {
    const url = 'https://x.com/example/status/1234567890123456789';
    const metadata = `[View on Twitter](${url})\n\n:speech_balloon:0 replies • :recycle:1 retweets • :heart:2 likes`;
    const f = fixture({ description: `${metadata}\n\nArticle title\nArticle preview`, url });
    await f.handle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].searchParams.get('text'), 'Article title\nArticle preview');
    assert.equal(f.replies[0].embeds[0].description, `${metadata}\n\ntranslated`);
});

test('a long description without recognizable generated metadata is translated in full', async () => {
    const description = 'one\ntwo\nthree\nfour\nfive\nsix';
    const f = fixture({ description }); await f.handle();
    assert.equal(f.requests[0].searchParams.get('text'), description);
    assert.equal(f.replies[0].embeds[0].description, 'translated');
});

test('an empty translation response cannot silently erase the original text', async () => {
    const f = fixture({ description: 'original text', response: '  ', translateOriginal: true });
    await assert.rejects(f.handle(), /TRANSLATION_EMPTY_RESPONSE/);
    assert.equal(f.replies.length, 0); assert.equal(f.edits.length, 0);
});

test('a failed article translation cannot partially edit the original message', async () => {
    const url = 'https://x.com/example/status/1234567890123456789';
    const f = fixture({ description: `post\n\n[View on Twitter](${url})\n\narticle`, response: ['translated post', ''], translateOriginal: true });
    await assert.rejects(f.handle(), /TRANSLATION_EMPTY_RESPONSE/);
    assert.equal(f.requests.length, 2); assert.equal(f.replies.length, 0); assert.equal(f.edits.length, 0);
});
