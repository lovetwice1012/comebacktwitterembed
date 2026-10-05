'use strict';

// YouTube URL recognition, canonical links, and thumbnail URL resolution.
const YOUTUBE_URL_PATTERN =
    /https?:\/\/(?:(?:(?:www|m|music)\.)?youtube\.com|(?:www\.)?youtube-nocookie\.com|(?:www\.)?youtu\.be)\/[^\s<>|]+/g;

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const PLAYLIST_ID_RE = /^[a-zA-Z0-9_-]{18,}$/;

const TRACKING_QUERY_KEYS = [
    'feature',
    'pp',
    'si',
    'is',
    'a',
    'embeds_referring_euri',
    'embeds_referring_origin',
    'embeds_euri',
    'embeds_origin',
    'embeds_widget_referrer',
    'source_ve_path',
    'iv_load_policy',
    'rel',
    'lc',
    'ab_channel',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'gclid',
    'fbclid',
    'cid',
    'mc_cid',
    'mc_eid',
    'yclid',
    'cmp',
    'context',
    'keyword',
    'source',
    'medium',
    'campaign',
    'term',
    'content',
];

function stripTracking(rawUrl) {
    const url = new URL(rawUrl);
    for (const key of TRACKING_QUERY_KEYS) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
}

function parseYouTubeUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    const isYouTube =
        hostname === 'youtube.com'
        || hostname === 'www.youtube.com'
        || hostname === 'm.youtube.com'
        || hostname === 'music.youtube.com'
        || hostname === 'youtu.be'
        || hostname === 'www.youtu.be'
        || hostname === 'youtube-nocookie.com'
        || hostname === 'www.youtube-nocookie.com';
    if (!isYouTube) return null;

    const pathname = url.pathname;
    const segments = pathname.split('/').filter(Boolean);
    const originalUrl = stripTracking(url.toString());

    if ((hostname === 'youtu.be' || hostname === 'www.youtu.be') && VIDEO_ID_RE.test(segments[0] || '')) {
        return { type: 'video', id: segments[0], originalUrl, isShorts: false };
    }

    if (pathname === '/watch') {
        const videoId = url.searchParams.get('v');
        if (videoId && VIDEO_ID_RE.test(videoId)) {
            return { type: 'video', id: videoId, originalUrl, isShorts: false };
        }
        const playlistId = url.searchParams.get('list');
        if (playlistId && PLAYLIST_ID_RE.test(playlistId)) {
            return { type: 'playlist', id: playlistId, originalUrl };
        }
    }

    if (pathname === '/playlist') {
        const playlistId = url.searchParams.get('list');
        if (playlistId && PLAYLIST_ID_RE.test(playlistId)) {
            return { type: 'playlist', id: playlistId, originalUrl };
        }
    }

    if ((segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live' || segments[0] === 'v') && VIDEO_ID_RE.test(segments[1] || '')) {
        return { type: 'video', id: segments[1], originalUrl, isShorts: segments[0] === 'shorts' };
    }

    if (segments[0] === 'channel' && segments[1]) {
        return { type: 'channel', id: segments[1], originalUrl, resolved: true };
    }

    if (segments[0] === 'c' || segments[0] === 'user' || pathname.startsWith('/@')) {
        return { type: 'channel', id: originalUrl, originalUrl, resolved: false };
    }

    return null;
}

function absoluteUrl(value, baseUrl) {
    if (!value) return null;
    if (value.startsWith('//')) return 'https:' + value;
    if (value.startsWith('/')) return baseUrl + value;
    return value;
}

function pickThumbnail(thumbnails, baseUrl) {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
    const best = thumbnails
        .filter(t => t && t.url)
        .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    return best ? absoluteUrl(best.url, baseUrl) : null;
}

function channelPageUrl(channelIdOrUrl, alreadyResolved) {
    if (alreadyResolved) {
        return `https://www.youtube.com/channel/${encodeURIComponent(channelIdOrUrl)}`;
    }
    try {
        return new URL(channelIdOrUrl).toString();
    } catch {
        return `https://www.youtube.com/${encodeURIComponent(String(channelIdOrUrl).replace(/^\/+/, ''))}`;
    }
}

function videoUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

function channelUrl(authorUrl, authorId) {
    if (authorUrl) return absoluteUrl(authorUrl, 'https://www.youtube.com');
    return authorId ? `https://www.youtube.com/channel/${authorId}` : 'https://www.youtube.com';
}

module.exports = {
    YOUTUBE_URL_PATTERN,
    stripTracking,
    parseYouTubeUrl,
    absoluteUrl,
    pickThumbnail,
    channelPageUrl,
    videoUrl,
    channelUrl,
};
