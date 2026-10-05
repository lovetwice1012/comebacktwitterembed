'use strict';

const { extractItemIds } = require('./boothSourceParser');
const { extractItemMetadata } = require('./boothSourceParser/watch');

const {
    MINUTE,
    conditionalHeaders,
    dedupeItems,
    monitorError,
    requestText,
    sourceError,
    urlFromInput,
} = require('../autoWatch/_shared');

function normalizeSource(input) {
    const raw = String(input || '').trim();
    if (!raw) throw sourceError('BOOTH requires a shop subdomain or shop URL.');
    let shop = raw.toLowerCase();
    const url = urlFromInput(raw);
    if (url) {
        const match = url.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.booth\.pm$/);
        if (!match) throw sourceError('BOOTH source must be a shop subdomain such as example.booth.pm.');
        shop = match[1];
    } else {
        const match = shop.match(/^([a-z0-9][a-z0-9-]*)\.booth\.pm$/);
        if (match) shop = match[1];
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(shop) || ['accounts', 'asset', 'www'].includes(shop)) throw sourceError('Invalid BOOTH shop subdomain.');
    return { sourceKey: shop, sourceUrl: `https://${shop}.booth.pm/items` };
}

function itemLinks(html, shop) {
    const metadata = extractItemMetadata(html, shop);
    return dedupeItems(extractItemIds(html, shop).map(id => ({
        contentId: id,
        url: `https://${shop}.booth.pm/items/${id}`,
        publishedAtMs: metadata.get(id)?.publishedAtMs ?? null,
        title: metadata.get(id)?.title ?? null,
    })).sort((left, right) => Number(right.contentId) - Number(left.contentId)));
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
    if (!context.config.enableGuestCrawls) throw monitorError('AUTO_WATCH_GUEST_CRAWL_DISABLED', 'BOOTH guest crawling is disabled.', { retryAfterMs: 6 * 60 * MINUTE });
    const response = await requestText(context, `https://${source.source_key}.booth.pm/items`, {
        headers: conditionalHeaders(source, {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)',
        }),
    });
    if (response.notModified) return { notModified: true, state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
    return { items: itemLinks(response.body, source.source_key), state: source.state || {}, etag: response.etag, lastModified: response.lastModified, rateLimit: response.rateLimit };
}

module.exports = {
    id: 'booth',
    label: 'BOOTH',
    guestOnly: true,
    minPollMs: 15 * MINUTE,
    defaultPollMs: 30 * MINUTE,
    globalSpacingMs: 2000,
    requestCost: 1,
    normalizeSource,
    fetch,
    initialCursor,
    isHistoricalAtBaseline,
    _internal: { initialCursor, isHistoricalAtBaseline, itemLinks, normalizeSource },
};
