'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../../src/providers/instagram/instagramSourceParser');

test('instagram source parser: requested post identity wins over unrelated carousel metadata', () => {
    const requested = {
        __typename: 'XIGPolarisImageMedia',
        code: 'REQUESTED',
        owner: { username: 'artist' },
        display_uri: 'https://scontent-nrt1-1.cdninstagram.com/requested.webp?sig=1&amp;v=2',
    };
    const related = {
        code: 'UNRELATED',
        carousel_media: [{ display_url: 'https://example.com/unrelated.jpg' }],
    };
    const html = `<script>window.data = ${JSON.stringify({ related, requested })};</script>`;
    const data = parser.parseInstagramHtml(html, 'REQUESTED');

    assert.equal(data.username, 'artist');
    assert.deepEqual(data.medias, [{
        typeName: 'XIGPolarisImageMedia',
        url: 'https://scontent.cdninstagram.com/requested.webp?sig=1&v=2',
    }]);
    assert.equal(parser.parseInstagramHtml(html, 'MISSING'), null);
});

test('instagram source parser: raw GraphQL JSON preserves carousel video streams and metadata', () => {
    const response = JSON.stringify({ data: { xdt_shortcode_media: {
        shortcode: 'CAROUSEL',
        carousel_media: [
            { display_url: 'https://example.com/first.jpg' },
            { media_type: 2, display_url: 'https://example.com/preview.jpg', video_url: 'https://example.com/second.mp4', video_duration: 12.5 },
        ],
    } } });
    const data = parser.parseInstagramGraphql(response, 'CAROUSEL');

    assert.deepEqual(data.medias.map(media => media.url), ['https://example.com/first.jpg', 'https://example.com/second.mp4']);
    assert.equal(data.videoDuration, 12.5);
    assert.equal(parser.parseInstagramGraphql(response, 'MISSING'), null);
    assert.equal(parser.parseInstagramGraphql('not JSON', 'CAROUSEL'), null);
    assert.equal(parser.parseInstagramGraphql('{"require_login":true}', 'CAROUSEL'), null);
});

test('instagram source parser: oEmbed and profile sources retain their normalized data shapes', () => {
    assert.deepEqual(parser.parseInstagramOEmbed(JSON.stringify({
        author_url: 'https://www.instagram.com/artist/',
        title: 'caption',
        thumbnail_url: 'https://scontent-nrt1-1.cdninstagram.com/thumb.jpg',
    })), {
        username: 'artist', caption: 'caption',
        medias: [{ typeName: 'GraphImage', url: 'https://scontent.cdninstagram.com/thumb.jpg' }],
    });
    assert.equal(parser.parseInstagramOEmbed('not JSON'), null);
    assert.equal(parser.normalizeProfileData({ data: {} }), null);
    const profile = parser.normalizeProfileHtmlData('artist', [
        '<meta property="og:title" content="Artist (&#064;artist) &#x2022; Instagram profile">',
        '<meta name="description" content="3,456 Followers, 78 Following, 12 Posts - Artist on Instagram: &quot;profile bio&quot;">',
        '<meta property="og:image" content="https://scontent-nrt1-1.cdninstagram.com/avatar.jpg">',
    ].join(''));
    assert.equal(profile.username, 'artist');
    assert.equal(profile.fullName, 'Artist');
    assert.equal(profile.biography, 'profile bio');
    assert.equal(profile.followers, '3,456');
    assert.equal(profile.posts, '12');
});

test('instagram source parser: URL identity retains route normalization and selected media index', () => {
    const parsed = parser.parseInstagramUrl('https://www.instagram.com/artist/reels/CODE/2?img_index=3');
    assert.deepEqual(parsed, { kind: 'media', route: 'reel', shortcode: 'CODE', mediaIndex: 2 });
    assert.equal(parser.buildCanonicalUrl(parsed), 'https://www.instagram.com/reel/CODE/');
    assert.deepEqual(parser.parseInstagramUrl('https://www.instagram.com/share/reel/SHARE?img_index=3'), {
        kind: 'share', shareCode: 'SHARE', shareRoute: 'reel', mediaIndex: 3,
    });
    assert.equal(parser.parseInstagramUrl('https://example.com/artist/'), null);
});
