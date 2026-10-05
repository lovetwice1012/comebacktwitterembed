'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../../src/providers/tiktok/tiktokSourceParser');

function hydrationHtml(scope) {
    return `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: scope })}</script>`;
}

test('tiktok source parser: raw HTML returns post and profile payloads without dropping source fields', () => {
    const item = { id: '123', desc: 'caption', video: { duration: 12 }, stats: { diggCount: 34 } };
    const profile = { user: { uniqueId: 'creator' }, stats: { followerCount: 456 } };
    const html = hydrationHtml({
        'webapp.video-detail': { itemInfo: { itemStruct: item } },
        'webapp.user-detail': { userInfo: profile },
    });

    assert.deepEqual(parser.parseTikTokVideoHtml(html), item);
    assert.deepEqual(parser.parseTikTokProfileHtml(html), profile);
    assert.equal(parser.parseTikTokVideoHtml(hydrationHtml({})), null);
    assert.equal(parser.parseTikTokProfileHtml(hydrationHtml({})), null);
});

test('tiktok source parser: malformed or missing hydration scripts retain thrown errors', () => {
    const opening = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';
    for (const parse of [parser.parseTikTokVideoHtml, parser.parseTikTokProfileHtml]) {
        assert.throws(() => parse('<html>login wall</html>'), /Script tag .* not found/);
        assert.throws(() => parse(opening + '{}'), /End tag .* not found/);
        assert.throws(() => parse(opening + 'invalid JSON</script>'), SyntaxError);
    }
});

test('tiktok source parser: media selection preserves HQ ordering, deduplication, and image fallbacks', () => {
    const data = {
        video: {
            PlayAddrStruct: { UrlList: ['https://example.com/default.mp4'] },
            playAddr: 'https://example.com/default.mp4',
            downloadAddr: 'https://example.com/download.mp4',
            bitrateInfo: [
                { CodecType: 'h264', PlayAddr: { UrlList: ['https://example.com/h264.mp4'] } },
                { CodecType: 'h265', PlayAddr: { UrlList: ['https://example.com/h265.mp4'] } },
            ],
        },
        author: { avatarMedium: 'https://example.com/avatar.jpg' },
        imagePost: { images: [
            { imageURL: { urlList: ['', 'https://example.com/first.jpg'], uri: 'fallback' } },
            { imageURL: { urlPrefix: 'https://example.com/second.jpg' } },
            { imageURL: { uri: 'https://example.com/third.jpg' } },
            {},
        ] },
    };

    assert.deepEqual(parser.getVideoUrlCandidates(data, true), [
        'https://example.com/h265.mp4', 'https://example.com/default.mp4',
        'https://example.com/download.mp4', 'https://example.com/h264.mp4',
    ]);
    assert.equal(parser.pickVideoUrl(data, false), 'https://example.com/default.mp4');
    assert.equal(parser.pickCoverUrl(data), 'https://example.com/avatar.jpg');
    assert.deepEqual(parser.pickImageUrls(data), [
        'https://example.com/first.jpg', 'https://example.com/second.jpg', 'https://example.com/third.jpg',
    ]);
    assert.equal(parser.isPhotoPost(data), true);
    assert.equal(parser.isPhotoPost({ imagePost: { images: [] } }), false);
});

test('tiktok source parser: URL parsing distinguishes posts, profiles, and unresolved short links', () => {
    assert.deepEqual(parser.parseTikTokUrl('https://m.tiktok.com/v/123.html'), {
        needsResolve: false, id: '123', kind: 'video', canonicalUrl: 'https://www.tiktok.com/@i/video/123',
    });
    assert.deepEqual(parser.parseTikTokUrl('https://www.tiktok.com/@creator?lang=en'), {
        needsResolve: false, id: 'creator', kind: 'profile', canonicalUrl: 'https://www.tiktok.com/@creator',
    });
    assert.deepEqual(parser.parseTikTokUrl('https://vm.tiktok.com/SHORT/'), {
        needsResolve: true, url: 'https://vm.tiktok.com/SHORT/',
    });
    assert.equal(parser.parseTikTokUrl('https://example.com/@creator/video/123'), null);
});
