'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../../src/providers/tiktok');

function createMessage(content) {
    return {
        guild: { id: 'guild-1' },
        author: { username: 'tester', id: 'user-1' },
        user: { username: 'tester', id: 'user-1' },
        content,
    };
}

test('tiktok extract: rewrites long video links to tnktok', async () => {
    const url = 'https://www.tiktok.com/@user/video/7332187682480590112?is_from_webapp=1&sender_device=pc';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'https://www.tnktok.com/@user/video/7332187682480590112');
    assert.equal(result[0].send, 'channel');
    assert.equal(result[0].suppressSourceEmbeds, true);
});

test('tiktok extract: rewrites short links without resolving them locally', async () => {
    const url = 'https://vm.tiktok.com/ZPRKrbUB1/';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].content, 'https://www.tnktok.com/ZPRKrbUB1/');
});

test('tiktok extract: preserves fxTikTok mode query params only', async () => {
    const url = 'https://www.tiktok.com/@user/video/7332187682480590112?addDesc=true&hq=true&_t=tracking';
    const result = await provider.extract(createMessage(url), url, {});

    assert.equal(result[0].content, 'https://www.tnktok.com/@user/video/7332187682480590112?addDesc=true&hq=true');
});

test('tiktok extract: honors reply and delete source settings', async () => {
    const url = 'https://www.tiktok.com/@user/video/7332187682480590112';
    const result = await provider.extract(createMessage(url), url, {
        alwaysreplyifpostedtweetlink: true,
        deletemessageifonlypostedtweetlink: true,
    });

    assert.equal(result[0].send, 'reply-source');
    assert.equal(result[0].deleteSource, true);
});

test('tiktok rewrite: rejects non-tiktok urls', () => {
    assert.equal(provider._internal.rewriteTikTokUrl('https://example.com/@user/video/1'), null);
});
