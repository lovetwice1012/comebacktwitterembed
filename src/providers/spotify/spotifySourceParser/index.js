'use strict';

// Pure source parsing; this folder can be copied without application dependencies.
function extractNextData(html) {
    const startTag = '<script id="__NEXT_DATA__" type="application/json">';
    const start = html.indexOf(startTag);
    if (start === -1) return null;
    const from = start + startTag.length;
    const end = html.indexOf('</script>', from);
    if (end === -1) return null;
    return JSON.parse(html.slice(from, end));
}

function pickLargestImage(images) {
    if (!Array.isArray(images) || images.length === 0) return null;
    const sorted = images
        .filter(img => img && typeof img.url === 'string' && img.url)
        .sort((a, b) => (b.maxWidth || b.width || 0) - (a.maxWidth || a.width || 0));
    return sorted[0] || null;
}

function trackIdFromUri(uri) {
    if (typeof uri !== 'string') return null;
    const parts = uri.split(':');
    return parts[0] === 'spotify' && parts[1] === 'track' ? parts[2] : null;
}

function normalizeTrackList(trackList) {
    if (!Array.isArray(trackList)) return [];
    return trackList
        .map(track => ({
            id: trackIdFromUri(track?.uri),
            title: track?.title || track?.name,
            subtitle: track?.subtitle,
            durationMs: typeof track?.duration === 'number' ? track.duration : null,
        }))
        .filter(track => track.title);
}

function entityExplicit(entity) {
    if (entity?.isExplicit === true || entity?.explicit === true) return true;
    const rating = entity?.contentRating?.label || entity?.contentRating?.rating || entity?.contentRating;
    return typeof rating === 'string' && /explicit/i.test(rating);
}

function normalizeTrackNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normalizeSpotifyInfo(type, id, entity, fallback = {}) {
    const artists = Array.isArray(entity?.artists)
        ? entity.artists.map(a => ({ name: a?.name, uri: a?.uri })).filter(a => a.name)
        : [];
    const largestImage = pickLargestImage(entity?.visualIdentity?.image)
        || (fallback.thumbnail_url ? { url: fallback.thumbnail_url, maxWidth: fallback.thumbnail_width, maxHeight: fallback.thumbnail_height } : null);
    const trackList = normalizeTrackList(entity?.trackList);

    return {
        type,
        id: entity?.id || id,
        name: entity?.name || entity?.title || fallback.title || null,
        subtitle: entity?.subtitle || null,
        artists,
        previewUrl: type === 'track' ? (entity?.audioPreview?.url || null) : null,
        image: largestImage,
        releaseDate: entity?.releaseDate?.isoString || null,
        durationMs: typeof entity?.duration === 'number' ? entity.duration : null,
        albumName: entity?.album?.name || entity?.albumOfTrack?.name || entity?.albumName || null,
        trackNumber: normalizeTrackNumber(entity?.trackNumber ?? entity?.track_number ?? entity?.trackIndex),
        explicit: entityExplicit(entity),
        trackList,
        canonicalUrl: `https://open.spotify.com/${type}/${id}`,
    };
}

function parseSpotifyPage(html, type, id) {
    const nextData = extractNextData(html);
    const pageProps = nextData?.props?.pageProps || {};
    if (pageProps.status === 404 || pageProps.status === 500) {
        throw new Error(`spotify ${type} not found: ${id}`);
    }
    const entity = pageProps.state?.data?.entity;
    return entity ? normalizeSpotifyInfo(type, id, entity) : null;
}

function extractArtistAlbumIds(html) {
    const ids = new Set();
    for (const match of String(html || '').matchAll(/(?:href=["'](?:https:\/\/open\.spotify\.com)?\/album\/|spotify:album:)([A-Za-z0-9]{22})/gi)) ids.add(match[1]);
    return [...ids];
}
function extractArtistReleases(html) {
    const text = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const sections = [...text.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
    const ids = new Set(); let recognized = false;
    for (let i = 0; i < sections.length; i++) {
        const heading = sections[i][1].replace(/<[^>]*>/g, '').replace(/&amp;/gi, '&').trim();
        if (!/^(?:Albums|Singles and EPs|Singles & EPs|アルバム|シングルとEP|シングル、EP)$/i.test(heading)) continue;
        recognized = true;
        const from = sections[i].index + sections[i][0].length, to = sections[i + 1]?.index ?? text.length;
        for (const id of extractArtistAlbumIds(text.slice(from, to))) ids.add(id);
    }
    return { recognized, ids: [...ids] };
}

module.exports = { extractNextData, parseSpotifyPage, normalizeSpotifyInfo, extractArtistAlbumIds, extractArtistReleases };
