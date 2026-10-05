'use strict';

// Supported routes and canonical URL identity, without network access.
const INSTAGRAM_URL_PATTERN =
    /https?:\/\/(?:www\.)?instagram\.com\/(?:(?:[A-Za-z0-9_.-]+\/)?(?:(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+(?:\/\d+)?|share(?:\/reel)?\/[A-Za-z0-9_-]+)|(?!(?:p|reel|reels|tv|share|stories|explore|accounts|about|api|graphql|oauth|developer|directory|emails|challenge|web|static|privacy|terms|legal)(?:\/|$))[A-Za-z0-9._]{1,30})\/?(?:\?[^\s<>|]*)?/g;
const INSTAGRAM_CLEAN_PATTERN = new RegExp(`<${INSTAGRAM_URL_PATTERN.source}>|\\|\\|${INSTAGRAM_URL_PATTERN.source}\\|\\|`, INSTAGRAM_URL_PATTERN.flags);

const MEDIA_ROUTES = new Set(['p', 'reel', 'reels', 'tv']);
const RESERVED_PROFILE_ROUTES = new Set([
    'p', 'reel', 'reels', 'tv', 'share', 'stories', 'explore', 'accounts',
    'about', 'api', 'graphql', 'oauth', 'developer', 'directory', 'emails',
    'challenge', 'web', 'static', 'privacy', 'terms', 'legal',
]);

function isInstagramHost(hostname) {
    return hostname === 'instagram.com' || hostname === 'www.instagram.com';
}

function normalizeRoute(route) {
    return route === 'reels' ? 'reel' : route;
}

function parseMediaIndex(value) {
    if (!value || !/^\d+$/.test(value)) return 0;
    return Math.max(0, Number(value));
}

function isValidProfileUsername(username) {
    return /^[A-Za-z0-9._]{1,30}$/.test(username)
        && !RESERVED_PROFILE_ROUTES.has(username.toLowerCase());
}

function parseInstagramUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    if (!isInstagramHost(u.hostname)) return null;

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 1) return null;
    const queryIndex = parseMediaIndex(u.searchParams.get('img_index'));

    if (parts[0] === 'share') {
        const shareCode = parts[parts.length - 1];
        if (!shareCode) return null;
        return {
            kind: 'share',
            shareCode,
            shareRoute: parts[1] === 'reel' ? 'reel' : null,
            mediaIndex: queryIndex,
        };
    }

    if (MEDIA_ROUTES.has(parts[0]) && parts[1]) {
        return {
            kind: 'media',
            route: normalizeRoute(parts[0]),
            shortcode: parts[1],
            mediaIndex: parseMediaIndex(parts[2]) || queryIndex,
        };
    }

    if (parts.length >= 3 && MEDIA_ROUTES.has(parts[1]) && parts[2]) {
        return {
            kind: 'media',
            route: normalizeRoute(parts[1]),
            shortcode: parts[2],
            mediaIndex: parseMediaIndex(parts[3]) || queryIndex,
        };
    }

    if (parts.length === 1 && isValidProfileUsername(parts[0])) {
        return {
            kind: 'profile',
            username: parts[0],
        };
    }

    return null;
}

function buildCanonicalUrl(parsed) {
    if (parsed.kind === 'profile') {
        return `https://www.instagram.com/${parsed.username}/`;
    }
    return `https://www.instagram.com/${parsed.route}/${parsed.shortcode}/`;
}

module.exports = {
    INSTAGRAM_URL_PATTERN,
    INSTAGRAM_CLEAN_PATTERN,
    parseInstagramUrl,
    buildCanonicalUrl,
};
