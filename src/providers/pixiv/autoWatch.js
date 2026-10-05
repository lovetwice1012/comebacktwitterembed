'use strict';

const {
    MINUTE,
    conditionalHeaders,
    dateMs,
    dedupeItems,
    monitorError,
    requestJson,
    sourceError,
    urlFromInput,
} = require('../autoWatch/_shared');

function normalizeSource(input) {
    const raw = String(input || '').trim();
    if (!raw) throw sourceError('Pixiv requires a numeric user ID or profile URL.');
    let userId = raw;
    const url = urlFromInput(raw);
    if (url) {
        if (!/(^|\.)pixiv\.net$/i.test(url.hostname)) throw sourceError('Pixiv source must be a pixiv.net profile URL.');
        const parts = url.pathname.split('/').filter(Boolean);
        const index = parts.indexOf('users');
        userId = index >= 0 ? parts[index + 1] : '';
    }
    if (!/^\d{1,20}$/.test(userId)) throw sourceError('Invalid Pixiv user ID.');
    return { sourceKey: String(userId), sourceUrl: `https://www.pixiv.net/users/${userId}` };
}

function artworkItems(body) {
    const artworks = { ...(body?.illusts || {}), ...(body?.manga || {}) };
    return dedupeItems(Object.entries(artworks).map(([id, metadata]) => ({
        contentId: id,
        url: `https://www.pixiv.net/artworks/${encodeURIComponent(id)}`,
        publishedAtMs: dateMs(metadata?.createDate || metadata?.uploadDate),
        title: metadata?.title || null,
    })).sort((left, right) => (right.publishedAtMs || Number(right.contentId) || 0) - (left.publishedAtMs || Number(left.contentId) || 0)));
}

function initialCursor(items) {
    const max = (Array.isArray(items) ? items : []).reduce((current, item) => {
        const value = Number(item?.contentId);
        return Number.isSafeInteger(value) && value > current ? value : current;
    }, 0);
    return max > 0 ? { baselineMaxNumericContentId: String(max) } : {};
}

function isHistoricalAtBaseline(cursor, item) {
    const baseline = Number(cursor?.baselineMaxNumericContentId);
    const value = Number(item?.contentId);
    return Number.isSafeInteger(baseline) && Number.isSafeInteger(value) && value <= baseline;
}

async function fetch(source, context) {
    if (!context.config.enableGuestCrawls) throw monitorError('AUTO_WATCH_GUEST_CRAWL_DISABLED', 'Pixiv guest crawling is disabled.', { retryAfterMs: 6 * 60 * MINUTE });
    const response = await requestJson(context, `https://www.pixiv.net/ajax/user/${encodeURIComponent(source.source_key)}/profile/all`, {
        headers: conditionalHeaders(source, {
            Accept: 'application/json',
            Referer: `https://www.pixiv.net/users/${encodeURIComponent(source.source_key)}`,
            'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)',
        }),
    });
    if (response.notModified) return { notModified: true, state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
    if (response.body?.error) throw monitorError('AUTO_WATCH_UPSTREAM_ERROR', 'Pixiv profile endpoint returned an error.');
    if (!response.body?.body || !Object.hasOwn(response.body.body, 'illusts') || !Object.hasOwn(response.body.body, 'manga')) throw monitorError('AUTO_WATCH_GUEST_CONTENT_UNAVAILABLE', 'Pixiv did not return a complete guest profile index.');
    return { items: artworkItems(response.body?.body), state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
}

module.exports = {
    id: 'pixiv',
    label: 'Pixiv',
    guestOnly: true,
    minPollMs: 15 * MINUTE,
    defaultPollMs: 30 * MINUTE,
    globalSpacingMs: 2000,
    requestCost: 1,
    normalizeSource,
    fetch,
    initialCursor,
    isHistoricalAtBaseline,
    _internal: { artworkItems, initialCursor, isHistoricalAtBaseline, normalizeSource },
};
