'use strict';

const {
    HOUR,
    conditionalHeaders,
    dedupeItems,
    monitorError,
    requestText,
    sourceError,
    urlFromInput,
} = require('../autoWatch/_shared');
const { extractArtistReleases } = require('./spotifySourceParser');
const { extractArtistReleaseMetadata } = require('./spotifySourceParser/watch');

function normalizeSource(input) {
    const raw = String(input || '').trim();
    if (!raw) throw sourceError('Spotify requires an artist ID or artist URL.');
    let artistId = raw;
    const url = urlFromInput(raw);
    if (url) {
        if (url.hostname !== 'open.spotify.com') throw sourceError('Spotify source must be an open.spotify.com artist URL.');
        const parts = url.pathname.split('/').filter(Boolean);
        const offset = /^intl-[A-Za-z-]+$/.test(parts[0] || '') ? 1 : 0;
        if (parts[offset] !== 'artist' || !parts[offset + 1]) throw sourceError('Spotify source must be an artist URL.');
        artistId = parts[offset + 1];
    }
    if (!/^[A-Za-z0-9]{22}$/.test(artistId)) throw sourceError('Invalid Spotify artist ID.');
    return { sourceKey: artistId, sourceUrl: `https://open.spotify.com/artist/${artistId}` };
}

function artistReleaseItems(html) {
    const result = extractArtistReleases(html);
    if (!result.recognized) throw monitorError('AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE', 'Spotify release sections are not guest-visible or the page structure changed.');
    const metadata = extractArtistReleaseMetadata(html);
    return dedupeItems(result.ids.map(id => ({ contentId: id, url: `https://open.spotify.com/album/${id}`,
        publishedAtMs: metadata.get(id)?.publishedAtMs ?? null, title: metadata.get(id)?.title ?? null })));
}

async function fetch(source, context) {
    const response = await requestText(context, `https://open.spotify.com/artist/${encodeURIComponent(source.source_key)}`, {
        headers: conditionalHeaders(source, {
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)',
        }),
    });
    if (response.notModified) return { notModified: true, state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
    return { items: artistReleaseItems(response.body), state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
}

module.exports = {
    id: 'spotify',
    label: 'Spotify',
    guestOnly: true,
    // Spotify documents a rolling limit for its authenticated API, not this
    // guest page. Restrict the HTML route to one request per five seconds.
    minPollMs: HOUR,
    defaultPollMs: 2 * HOUR,
    globalSpacingMs: 5000,
    requestCost: 1,
    normalizeSource,
    fetch,
    _internal: { artistReleaseItems, normalizeSource },
};
