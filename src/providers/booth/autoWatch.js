'use strict';

const { extractItemIds } = require('./boothSourceParser');
const { extractItemMetadata } = require('./boothSourceParser/watch');
const { createJsonProjector, readHtmlProjection, responseChunks } = require('../autoWatch/streaming');

const CARD_FIELDS = ['id', 'shop_item_url', 'name', 'published_at', 'datePublished'];
const CARD_PATHS = CARD_FIELDS.flatMap(field => [[field], ['*', field]]);

function decodeAttributeChunk(text, state, final = false) {
    let input = state.tail + text;
    state.tail = '';
    if (!final) {
        const amp = input.lastIndexOf('&');
        if (amp >= 0 && /^&(?:#(?:x[0-9a-f]{0,8}|\d{0,10})?|a(?:m(?:p)?|p(?:o(?:s)?)?)?|q(?:u(?:o(?:t)?)?)?|l(?:t)?|g(?:t)?|n(?:b(?:s(?:p)?)?)?)?$/i.test(input.slice(amp))) {
            state.tail = input.slice(amp);
            input = input.slice(0, amp);
        }
    }
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    return input.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, key) => {
        if (key[0] !== '#') return named[key.toLowerCase()] || raw;
        const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : raw;
    });
}

function compactCardMarkup(data) {
    const cards = Array.isArray(data) ? data : [data];
    return cards.filter(card => card && typeof card === 'object').map(card => {
        // The normal parser already trims titles to this display length and
        // ignores URL query/fragment components when resolving an item ID.
        const compact = { ...card };
        if (typeof compact.name === 'string') compact.name = compact.name.trim().slice(0, 1024);
        if (typeof compact.shop_item_url === 'string') {
            try {
                const url = new URL(compact.shop_item_url);
                if (url.protocol === 'https:' && !url.username && !url.password) compact.shop_item_url = `${url.origin}${url.pathname}`;
            } catch { /* The source parser will ignore an invalid URL. */ }
        }
        const encoded = JSON.stringify(compact).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        return `<div data-item="${encoded}"></div>`;
    }).join('');
}

// BOOTH embeds its whole shop index in entity-encoded HTML attributes. Project
// JSON as the attribute arrives, then split the resulting index into individual
// cards so a large legitimate shop does not require one huge HTML token.
async function* projectedCardChunks(response) {
    let pending = '', stage = 'search', attribute = '', quote = '', tagQuote = '', markup = '';
    let projector, decoder, invalid;
    for await (const chunk of responseChunks(response)) {
        let input = pending + chunk;
        pending = '';
        while (input) {
            if (stage === 'search') {
                const match = /\bdata-items?\b/i.exec(input);
                if (!match) {
                    // Only the short possible attribute-name suffix crosses a
                    // socket boundary. All other markup proceeds immediately.
                    const emit = Math.max(0, input.length - 16);
                    if (emit) yield input.slice(0, emit);
                    pending = input.slice(emit);
                    break;
                }
                if (match.index) yield input.slice(0, match.index);
                attribute = match[0];
                input = input.slice(match.index + match[0].length);
                stage = 'equal';
            } else if (stage === 'equal' || stage === 'quote') {
                input = input.replace(/^\s+/, '');
                if (!input) break;
                if (stage === 'equal' && input[0] === '=') {
                    input = input.slice(1); stage = 'quote';
                } else if (stage === 'quote' && /["']/.test(input[0])) {
                    quote = input[0]; input = input.slice(1);
                    decoder = { tail: '' }; projector = createJsonProjector(CARD_PATHS); invalid = false;
                    stage = 'json';
                } else {
                    yield `${attribute}${stage === 'quote' ? '= ' : ' '}`;
                    stage = 'search';
                }
            } else if (stage === 'json') {
                const end = input.indexOf(quote);
                const raw = end < 0 ? input : input.slice(0, end);
                const decoded = decodeAttributeChunk(raw, decoder, end >= 0);
                if (!invalid) {
                    try { await projector.write(decoded); } catch (error) {
                        if (error?.code === 'AUTO_WATCH_RESOURCE_PRESSURE') throw error;
                        invalid = true;
                    }
                }
                if (end < 0) break;
                markup = '';
                if (!invalid) {
                    try { markup = compactCardMarkup(await projector.end()); } catch (error) {
                        if (error?.code === 'AUTO_WATCH_RESOURCE_PRESSURE') throw error;
                        // Invalid data attributes have always been ignored by
                        // the guest card parser; ordinary item links remain.
                    }
                }
                yield `${attribute}=""`;
                input = input.slice(end + 1);
                tagQuote = ''; stage = 'tagEnd';
            } else if (stage === 'tagEnd') {
                let end = -1;
                for (let i = 0; i < input.length; i++) {
                    const char = input[i];
                    if (tagQuote) { if (char === tagQuote) tagQuote = ''; }
                    else if (char === '"' || char === "'") tagQuote = char;
                    else if (char === '>') { end = i; break; }
                }
                if (end < 0) { yield input; break; }
                yield input.slice(0, end + 1);
                if (markup) yield markup;
                markup = ''; input = input.slice(end + 1); stage = 'search';
            }
        }
    }
    if (stage === 'search' && pending) yield pending;
    else if (stage === 'equal' || stage === 'quote') yield `${attribute}${stage === 'quote' ? '=' : ''}`;
    // An unterminated JSON attribute cannot contain a valid complete card.
}

function readShopProjection(response) {
    return readHtmlProjection({ ...response, body: projectedCardChunks(response) }, { preserveHtml: true });
}

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
        readBody: readShopProjection,
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
