'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractNextData, parseSpotifyPage, normalizeSpotifyInfo, extractArtistAlbumIds } = require('../../src/providers/spotify/spotifySourceParser');

function page(pageProps) {
    return '<script id="__NEXT_DATA__" type="application/json">'
        + JSON.stringify({ props: { pageProps } }) + '</script>';
}

test('Spotify source parser normalizes embedded track metadata', () => {
    const html = page({ state: { data: { entity: {
        id: 'track1', title: 'Track title', artists: [{ name: 'Artist', uri: 'spotify:artist:artist1' }, {}],
        visualIdentity: { image: [{ url: 'small.jpg', maxWidth: 100 }, { url: 'large.jpg', maxWidth: 640 }] },
        duration: 180000, audioPreview: { url: 'preview.mp3' }, albumOfTrack: { name: 'Album' },
        track_number: '3', contentRating: { label: 'explicit' },
        trackList: [{ uri: 'spotify:track:track2', title: 'Another', duration: 90000 }, {}],
    } } } });
    const item = parseSpotifyPage(html, 'track', 'requested');
    assert.equal(item.id, 'track1');
    assert.equal(item.name, 'Track title');
    assert.deepEqual(item.artists, [{ name: 'Artist', uri: 'spotify:artist:artist1' }]);
    assert.equal(item.image.url, 'large.jpg');
    assert.equal(item.previewUrl, 'preview.mp3');
    assert.equal(item.albumName, 'Album');
    assert.equal(item.trackNumber, 3);
    assert.equal(item.explicit, true);
    assert.deepEqual(item.trackList, [{ id: 'track2', title: 'Another', subtitle: undefined, durationMs: 90000 }]);
    assert.equal(item.canonicalUrl, 'https://open.spotify.com/track/requested');
});

test('Spotify source parser preserves page errors and lets callers supply oEmbed fallback', () => {
    assert.equal(parseSpotifyPage('<html></html>', 'album', 'album1'), null);
    assert.throws(() => parseSpotifyPage(page({ status: 404 }), 'album', 'album1'), /spotify album not found: album1/);
    assert.throws(() => extractNextData('<script id="__NEXT_DATA__" type="application/json">broken</script>'), SyntaxError);
    const item = normalizeSpotifyInfo('album', 'album1', null, { title: 'Fallback album', thumbnail_url: 'cover.jpg', thumbnail_width: 300 });
    assert.equal(item.name, 'Fallback album');
    assert.equal(item.image.url, 'cover.jpg');
    assert.equal(item.previewUrl, null);
    assert.deepEqual(item.trackList, []);
});

test('Spotify source parser discovers artist album links and URIs in source order', () => {
    const first = 'A'.repeat(22);
    const second = 'B'.repeat(22);
    assert.deepEqual(extractArtistAlbumIds(`<a href="/album/${first}">First</a> spotify:album:${second} <a href="https://open.spotify.com/album/${first}">Again</a>`), [first, second]);
    assert.deepEqual(extractArtistAlbumIds(null), []);
});
