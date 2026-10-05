'use strict';

const { AMAZON_MUSIC_ROUTE_LABELS } = require('./amazonSourceParser');


const AMAZON_URL_PATTERN =
    /https?:\/\/(?:(?:(?:www|smile|m)\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?|(?:www\.)?music\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?|(?:(?:www|app)\.)?primevideo\.com|watch\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?|a\.co|amzn\.(?:to|asia|eu|in))\/[^\s<>|]+/gi;

const AMAZON_HOST_RE = /^(?:(?:www|smile|m)\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;

const AMAZON_MUSIC_HOST_RE = /^(?:www\.)?music\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;

const AMAZON_VIDEO_HOST_RE = /^watch\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;

const PRIME_VIDEO_HOST_RE = /^(?:(?:www|app)\.)?primevideo\.com$/i;

const AMAZON_SHORT_HOST_RE = /^(?:a\.co|amzn\.(?:to|asia|eu|in))$/i;

const ASIN_RE = /^[A-Z0-9]{10}$/i;

const AMAZON_EXTRACT_TARGETS = ['product', 'prime_video', 'music'];

const AMAZON_KIND_TARGET = {
    product: 'product',
    primeVideo: 'prime_video',
    music: 'music',
};

function normalizeAmazonExtractTargets(settings) {
    if (!Object.prototype.hasOwnProperty.call(settings || {}, 'amazon_extract_targets')) {
        return AMAZON_EXTRACT_TARGETS;
    }
    const values = Array.isArray(settings.amazon_extract_targets) ? settings.amazon_extract_targets : [];
    const allowed = new Set(AMAZON_EXTRACT_TARGETS);
    const out = [];
    for (const value of values) {
        const key = String(value || '').trim();
        if (allowed.has(key) && !out.includes(key)) out.push(key);
    }
    return out;
}

function shouldExtractAmazonParsed(parsed, settings) {
    if (!parsed || parsed.kind === 'short') return true;
    const target = AMAZON_KIND_TARGET[parsed.kind];
    if (!target) return true;
    return normalizeAmazonExtractTargets(settings).includes(target);
}

function normalizeAmazonHost(hostname) {
    return String(hostname || '')
        .toLowerCase()
        .replace(/^(?:www|smile|m)\./, '');
}

function normalizeAmazonMusicHost(hostname) {
    return String(hostname || '')
        .toLowerCase()
        .replace(/^www\./, '');
}

function isAmazonHost(hostname) {
    return AMAZON_HOST_RE.test(String(hostname || '').toLowerCase());
}

function isAmazonMusicHost(hostname) {
    return AMAZON_MUSIC_HOST_RE.test(String(hostname || '').toLowerCase());
}

function isAmazonVideoHost(hostname) {
    return AMAZON_VIDEO_HOST_RE.test(String(hostname || '').toLowerCase());
}

function isPrimeVideoHost(hostname) {
    return PRIME_VIDEO_HOST_RE.test(String(hostname || '').toLowerCase());
}

function isAmazonShortHost(hostname) {
    return AMAZON_SHORT_HOST_RE.test(String(hostname || '').toLowerCase());
}

function normalizeAsin(value) {
    const match = String(value || '').trim().toUpperCase().match(/^([A-Z0-9]{10})(?=$|[^A-Z0-9])/);
    const asin = match?.[1] || '';
    return ASIN_RE.test(asin) ? asin : '';
}

function normalizeEntityId(value) {
    const match = String(value || '').trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]{2,127})(?=$|[^A-Za-z0-9._-])/);
    return match?.[1] || '';
}

function normalizePrimeVideoId(value) {
    const id = normalizeEntityId(value);
    if (!id) return '';
    if (/^amzn1\./i.test(id)) return id;
    return /^[A-Z0-9]{8,80}$/.test(id) ? id : '';
}

function decodedPathSegments(url) {
    return url.pathname.split('/').filter(Boolean).map(part => {
        try {
            return decodeURIComponent(part);
        } catch {
            return part;
        }
    });
}

function asinFromPathSegments(segments) {
    const lower = segments.map(part => part.toLowerCase());

    for (let i = 0; i < segments.length; i++) {
        if (['dp', 'product-reviews', 'offer-listing'].includes(lower[i])) {
            const asin = normalizeAsin(segments[i + 1]);
            if (asin) return asin;
        }

        if (lower[i] === 'gp' && lower[i + 1] === 'product') {
            const asin = normalizeAsin(segments[i + 2]);
            if (asin) return asin;
        }

        if (lower[i] === 'gp' && lower[i + 1] === 'aw' && lower[i + 2] === 'd') {
            const asin = normalizeAsin(segments[i + 3]);
            if (asin) return asin;
        }

        if (lower[i] === 'asin') {
            const asin = normalizeAsin(segments[i + 1]);
            if (asin) return asin;
        }
    }

    return '';
}

function asinFromQuery(url) {
    for (const key of ['asin', 'ASIN', 'pd_rd_i', 'creativeASIN']) {
        const asin = normalizeAsin(url.searchParams.get(key));
        if (asin) return asin;
    }
    return '';
}

function canonicalUrlFor(hostname, asin) {
    return `https://${normalizeAmazonHost(hostname)}/dp/${asin}`;
}

function canonicalAmazonMusicUrlFor(hostname, route, id) {
    return `https://${normalizeAmazonMusicHost(hostname)}/${route}/${encodeURIComponent(id)}`;
}

function canonicalPrimeVideoUrlFor(hostname, id, amazonHosted) {
    if (amazonHosted) return `https://${normalizeAmazonHost(hostname)}/gp/video/detail/${encodeURIComponent(id)}`;
    return `https://www.primevideo.com/detail/${encodeURIComponent(id)}`;
}

function parseAmazonMusicUrl(url) {
    const segments = decodedPathSegments(url);
    const lower = segments.map(part => part.toLowerCase());
    const trackAsin = normalizeAsin(url.searchParams.get('trackAsin') || url.searchParams.get('trackasin'));
    if (trackAsin) {
        return {
            kind: 'music',
            id: trackAsin,
            route: 'tracks',
            host: normalizeAmazonMusicHost(url.hostname),
            canonicalUrl: canonicalAmazonMusicUrlFor(url.hostname, 'tracks', trackAsin),
            openUrl: url.toString(),
        };
    }

    for (let i = 0; i < segments.length; i++) {
        let route = lower[i];
        let idIndex = i + 1;
        if (lower[i] === 'music' && lower[i + 1] === 'player') {
            route = lower[i + 2];
            idIndex = i + 3;
        } else if (lower[i] === 'live' && lower[i + 1] === 'events') {
            route = 'live/events';
            idIndex = i + 2;
        }

        if (!Object.prototype.hasOwnProperty.call(AMAZON_MUSIC_ROUTE_LABELS, route)) continue;
        const id = normalizeEntityId(segments[idIndex]);
        if (!id) continue;
        return {
            kind: 'music',
            id,
            route,
            host: normalizeAmazonMusicHost(url.hostname),
            canonicalUrl: canonicalAmazonMusicUrlFor(url.hostname, route, id),
            openUrl: url.toString(),
        };
    }

    return null;
}

function firstPrimeVideoId(candidates) {
    for (const candidate of candidates) {
        const id = normalizePrimeVideoId(candidate);
        if (id) return id;
    }
    return '';
}

function parsePrimeVideoUrl(url) {
    const segments = decodedPathSegments(url);
    const lower = segments.map(part => part.toLowerCase());
    const detailIndex = lower.indexOf('detail');
    const id = detailIndex === -1 ? '' : firstPrimeVideoId(segments.slice(detailIndex + 1));
    if (!id) return null;
    return {
        kind: 'primeVideo',
        id,
        host: url.hostname.toLowerCase(),
        canonicalUrl: canonicalPrimeVideoUrlFor(url.hostname, id, false),
        openUrl: url.toString(),
    };
}

function parseAmazonVideoUrl(url) {
    const segments = decodedPathSegments(url);
    const lower = segments.map(part => part.toLowerCase());
    const queryId = normalizePrimeVideoId(url.searchParams.get('gti') || url.searchParams.get('asin'));
    if (queryId) {
        return {
            kind: 'primeVideo',
            id: queryId,
            host: url.hostname.toLowerCase(),
            canonicalUrl: canonicalPrimeVideoUrlFor(url.hostname, queryId, false),
            openUrl: url.toString(),
        };
    }

    for (let i = 0; i < segments.length; i++) {
        const isGpVideoDetail = lower[i] === 'gp' && lower[i + 1] === 'video' && lower[i + 2] === 'detail';
        const isVideoDetail = lower[i] === 'video' && lower[i + 1] === 'detail';
        if (!isGpVideoDetail && !isVideoDetail) continue;
        const id = normalizePrimeVideoId(segments[i + (isGpVideoDetail ? 3 : 2)]);
        if (!id) continue;
        return {
            kind: 'primeVideo',
            id,
            host: normalizeAmazonHost(url.hostname),
            canonicalUrl: canonicalPrimeVideoUrlFor(url.hostname, id, isAmazonHost(url.hostname)),
            openUrl: url.toString(),
        };
    }

    return null;
}

function parseAmazonUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (isAmazonShortHost(hostname)) {
        return {
            kind: 'short',
            id: '',
            needsResolve: true,
            host: hostname,
            canonicalUrl: url.toString(),
            openUrl: url.toString(),
        };
    }

    if (isAmazonMusicHost(hostname)) return parseAmazonMusicUrl(url);
    if (isPrimeVideoHost(hostname)) return parsePrimeVideoUrl(url);
    if (isAmazonVideoHost(hostname)) return parseAmazonVideoUrl(url);
    if (!isAmazonHost(hostname)) return null;

    const video = parseAmazonVideoUrl(url);
    if (video) return video;

    const segments = decodedPathSegments(url);
    const asin = asinFromPathSegments(segments) || asinFromQuery(url);
    if (!asin) return null;

    return {
        kind: 'product',
        id: asin,
        asin,
        needsResolve: false,
        host: normalizeAmazonHost(hostname),
        canonicalUrl: canonicalUrlFor(hostname, asin),
        openUrl: url.toString(),
    };
}

module.exports = {
    AMAZON_MUSIC_ROUTE_LABELS,
    AMAZON_URL_PATTERN,
    normalizeAmazonExtractTargets,
    normalizeAmazonMusicHost,
    parseAmazonUrl,
    shouldExtractAmazonParsed,
};
