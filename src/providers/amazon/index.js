'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');

const AMAZON_COLOR = 0xff9900;
const DESCRIPTION_MAX_LENGTH = 700;
const FIELD_MAX_LENGTH = 1024;
const AMAZON_URL_PATTERN =
    /https?:\/\/(?:(?:(?:www|smile|m)\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?|(?:www\.)?music\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?|(?:(?:www|app)\.)?primevideo\.com|watch\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?|a\.co|amzn\.(?:to|asia|eu|in))\/[^\s<>|]+/gi;

const AMAZON_HOST_RE = /^(?:(?:www|smile|m)\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;
const AMAZON_MUSIC_HOST_RE = /^(?:www\.)?music\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;
const AMAZON_VIDEO_HOST_RE = /^watch\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;
const PRIME_VIDEO_HOST_RE = /^(?:(?:www|app)\.)?primevideo\.com$/i;
const AMAZON_SHORT_HOST_RE = /^(?:a\.co|amzn\.(?:to|asia|eu|in))$/i;
const ASIN_RE = /^[A-Z0-9]{10}$/i;
const AMAZON_MUSIC_ROUTE_LABELS = {
    albums: 'Album',
    tracks: 'Track',
    artists: 'Artist',
    playlists: 'Playlist',
    podcasts: 'Podcast',
    'podcast-episodes': 'Podcast episode',
    'live/events': 'Live event',
    stations: 'Station',
};
const REQUEST_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};

const STR = {
    requesterPrefix: { ja: 'Requested by ', en: 'Requested by ' },
    anonymousRequester: { ja: 'Anonymous requester', en: 'Anonymous requester' },
    openButton: { ja: 'Open in Amazon', en: 'Open in Amazon' },
    openMusicButton: { ja: 'Open in Amazon Music', en: 'Open in Amazon Music' },
    openPrimeVideoButton: { ja: 'Open in Prime Video', en: 'Open in Prime Video' },
    showMediaAsAttachmentsButton: { ja: 'Show image as attachment', en: 'Show image as attachment' },
    translateButton: { ja: 'Translate', en: 'Translate' },
    deleteButton: { ja: 'Delete', en: 'Delete' },
    typeField: { ja: 'Type', en: 'Type' },
    priceField: { ja: 'Price', en: 'Price' },
    brandField: { ja: 'Brand', en: 'Brand' },
    ratingField: { ja: 'Rating', en: 'Rating' },
    availabilityField: { ja: 'Availability', en: 'Availability' },
    artistField: { ja: 'Artist', en: 'Artist' },
    albumField: { ja: 'Album', en: 'Album' },
    dateField: { ja: 'Date', en: 'Date' },
    genreField: { ja: 'Genre', en: 'Genre' },
    yearField: { ja: 'Year', en: 'Year' },
    maturityField: { ja: 'Maturity', en: 'Maturity' },
    durationField: { ja: 'Duration', en: 'Duration' },
    asinField: { ja: 'ASIN', en: 'ASIN' },
    idField: { ja: 'ID', en: 'ID' },
    fallbackTitle: { ja: 'Amazon item ', en: 'Amazon item ' },
    musicFallbackTitle: { ja: 'Amazon Music ', en: 'Amazon Music ' },
    primeVideoFallbackTitle: { ja: 'Prime Video ', en: 'Prime Video ' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLanguage(settings) {
    return settings?.defaultLanguage === 'ja' ? 'ja' : 'en';
}

function decodeHtml(value) {
    return String(value ?? '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)));
}

function stripHtml(value) {
    return decodeHtml(value)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function cleanText(value) {
    return stripHtml(value)
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(value, maxLength) {
    const text = String(value ?? '').trim();
    if (!text || text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 3).trimEnd() + '...';
}

function extractAttr(tag, attrName) {
    if (!tag) return '';
    const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = tag.match(re);
    return match ? decodeHtml(match[2] || match[3] || match[4] || '') : '';
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMetaContent(html, name) {
    const attr = escapeRegExp(name);
    const tag = html.match(new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    return tag ? cleanText(extractAttr(tag, 'content')) : '';
}

function readElementHtmlById(html, id) {
    const attr = escapeRegExp(id);
    const match = html.match(new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*\\bid=["']${attr}["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
    return match ? match[2] : '';
}

function readElementTextById(html, id) {
    return cleanText(readElementHtmlById(html, id));
}

function readTitleTag(html) {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match ? cleanText(match[1]) : '';
}

function cleanAmazonTitle(value) {
    return cleanText(value)
        .replace(/^Amazon\.[^:]+:\s*/i, '')
        .replace(/\s*:\s*Amazon\.[^:]+(?:\s*:\s*.*)?$/i, '')
        .trim();
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

async function fetchAmazonPage(rawUrl) {
    const res = await fetch(rawUrl, { headers: REQUEST_HEADERS, redirect: 'follow' });
    if (!res.ok) {
        /** @type {Error & {status?: number}} */
        const err = new Error(`amazon page ${res.status} for ${rawUrl}`);
        err.status = res.status;
        throw err;
    }
    return {
        html: await res.text(),
        finalUrl: res.url || rawUrl,
    };
}

function parseJsonSafely(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function jsonLdScripts(html) {
    const out = [];
    const re = /<script\b(?=[^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        const parsed = parseJsonSafely(decodeHtml(match[1]).trim());
        if (parsed) out.push(parsed);
    }
    return out;
}

function typeIncludes(type, acceptedTypes) {
    if (Array.isArray(type)) return type.some(item => typeIncludes(item, acceptedTypes));
    return acceptedTypes.has(String(type || '').toLowerCase());
}

function findJsonLdNode(value, predicate, depth = 0) {
    if (!value || depth > 8) return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findJsonLdNode(item, predicate, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (typeof value !== 'object') return null;
    if (predicate(value)) return value;

    if (Array.isArray(value['@graph'])) {
        const found = findJsonLdNode(value['@graph'], predicate, depth + 1);
        if (found) return found;
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            const found = findJsonLdNode(child, predicate, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function findJsonLdByType(html, typeNames, fallbackPredicate = null) {
    const acceptedTypes = new Set(typeNames.map(type => String(type).toLowerCase()));
    for (const script of jsonLdScripts(html)) {
        const found = findJsonLdNode(script, node => (
            typeIncludes(node['@type'], acceptedTypes)
            || (fallbackPredicate && fallbackPredicate(node))
        ));
        if (found) return found;
    }
    return null;
}

function findProductJsonLd(html) {
    return findJsonLdByType(html, ['Product'], node => node.name && (node.offers || node.image));
}

function firstArrayItem(value) {
    return Array.isArray(value) ? value[0] : value;
}

function imageFromValue(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'object') return item.url || item.contentUrl || '';
    return '';
}

function brandName(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string') return cleanText(item);
    if (typeof item === 'object') return cleanText(item.name || item.brand || '');
    return '';
}

function thingName(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string') return cleanText(item);
    if (typeof item === 'object') return cleanText(item.name || item.title || '');
    return '';
}

function thingNames(value) {
    const values = Array.isArray(value) ? value : [value];
    const out = [];
    const seen = new Set();
    for (const item of values) {
        const name = thingName(item);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

function offerFromValue(value) {
    const offer = firstArrayItem(value);
    if (!offer || typeof offer !== 'object') return {};
    const spec = firstArrayItem(offer.priceSpecification) || {};
    return {
        price: offer.price ?? offer.lowPrice ?? spec.price,
        currency: offer.priceCurrency ?? spec.priceCurrency,
        availability: offer.availability,
    };
}

function cleanPriceText(value) {
    const text = cleanText(value).replace(/\s+/g, ' ');
    return /\d/.test(text) ? text : '';
}

function formatOfferPrice(offers) {
    const offer = offerFromValue(offers);
    const price = cleanPriceText(offer.price);
    if (!price) return '';
    const currency = cleanText(offer.currency || '');
    if (!currency || /[^\d.,\s]/.test(price) || /[A-Z]{3}/i.test(price)) return price;
    return `${currency} ${price}`;
}

function availabilityText(value) {
    const raw = cleanText(value);
    if (!raw) return '';
    const tail = raw.split(/[/#]/).filter(Boolean).pop() || raw;
    return tail
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .trim();
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return cleanText(value);
    return n.toLocaleString('en-US');
}

function formatRating(aggregateRating) {
    if (!aggregateRating || typeof aggregateRating !== 'object') return '';
    const rating = cleanText(aggregateRating.ratingValue || aggregateRating.rating || '');
    if (!rating) return '';
    const count = aggregateRating.reviewCount ?? aggregateRating.ratingCount;
    return count ? `${rating} / 5 (${formatNumber(count)})` : `${rating} / 5`;
}

function formatAggregateRating(aggregateRating) {
    if (!aggregateRating || typeof aggregateRating !== 'object') return '';
    const rating = cleanText(aggregateRating.ratingValue || aggregateRating.rating || '');
    if (!rating) return '';
    const count = aggregateRating.reviewCount ?? aggregateRating.ratingCount;
    return count ? `${rating} (${formatNumber(count)})` : rating;
}

function absoluteUrl(rawUrl, baseUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (value.startsWith('//')) return 'https:' + value;
    try {
        return new URL(value, baseUrl).toString();
    } catch {
        return value;
    }
}

function readLandingImage(html, baseUrl) {
    const tag = html.match(/<img\b(?=[^>]*\bid=["'](?:landingImage|imgBlkFront)["'])[^>]*>/i)?.[0] || '';
    const dynamic = extractAttr(tag, 'data-a-dynamic-image');
    const dynamicJson = dynamic ? parseJsonSafely(dynamic) : null;
    if (dynamicJson && typeof dynamicJson === 'object') {
        let bestUrl = '';
        let bestArea = -1;
        for (const [candidateUrl, dimensions] of Object.entries(dynamicJson)) {
            const width = Number(dimensions?.[0]) || 0;
            const height = Number(dimensions?.[1]) || 0;
            const area = width * height;
            if (area > bestArea) {
                bestArea = area;
                bestUrl = candidateUrl;
            }
        }
        if (bestUrl) return absoluteUrl(bestUrl, baseUrl);
    }

    return absoluteUrl(
        extractAttr(tag, 'data-old-hires') || extractAttr(tag, 'src'),
        baseUrl
    );
}

function readPriceFromHtml(html) {
    for (const id of ['priceblock_dealprice', 'priceblock_ourprice', 'priceblock_saleprice']) {
        const price = cleanPriceText(readElementHtmlById(html, id));
        if (price) return price;
    }

    const offscreen = html.match(/<span\b(?=[^>]*class=["'][^"']*a-offscreen[^"']*["'])[^>]*>([\s\S]*?)<\/span>/i);
    return offscreen ? cleanPriceText(offscreen[1]) : '';
}

function readRatingFromHtml(html) {
    const ratingArea = readElementHtmlById(html, 'acrPopover') || html;
    const ratingMatch = stripHtml(ratingArea).match(/([0-5](?:\.\d+)?)\s+out of\s+5/i)
        || stripHtml(html).match(/([0-5](?:\.\d+)?)\s+out of\s+5/i);
    if (!ratingMatch) return '';

    const reviewText = readElementTextById(html, 'acrCustomerReviewText');
    const reviewMatch = reviewText.match(/[\d,.]+/);
    return reviewMatch ? `${ratingMatch[1]} / 5 (${reviewMatch[0]})` : `${ratingMatch[1]} / 5`;
}

function readGenericImage(html, node, baseUrl) {
    return absoluteUrl(
        imageFromValue(node?.image)
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        baseUrl
    );
}

function readGenericDescription(html, node) {
    return truncate(
        cleanText(node?.description || readMetaContent(html, 'og:description') || readMetaContent(html, 'description')),
        DESCRIPTION_MAX_LENGTH
    );
}

function cleanAmazonMusicTitle(value) {
    return cleanText(value)
        .replace(/\s+on Amazon Music(?: Unlimited)?$/i, '')
        .replace(/\s*-\s*Amazon Music.*$/i, '')
        .trim();
}

function cleanPrimeVideoTitle(value) {
    return cleanText(value)
        .replace(/^Prime Video:\s*/i, '')
        .replace(/\s*-\s*Prime Video\s*$/i, '')
        .trim();
}

function musicTypeLabel(route) {
    return AMAZON_MUSIC_ROUTE_LABELS[route] || 'Music';
}

function formatList(value) {
    if (!Array.isArray(value)) return cleanText(value);
    return value.map(item => cleanText(item)).filter(Boolean).join(', ');
}

function formatIsoDuration(value) {
    const raw = cleanText(value);
    const match = raw.match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (!match) return raw;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds && !hours) parts.push(`${seconds}s`);
    return parts.join(' ') || raw;
}

function yearFromDate(value) {
    const match = cleanText(value).match(/\b(\d{4})\b/);
    return match?.[1] || '';
}

function extractProductInfo(html, parsed) {
    const product = findProductJsonLd(html) || {};
    const offer = offerFromValue(product.offers);
    const baseUrl = parsed.canonicalUrl;
    const title = cleanAmazonTitle(
        product.name
        || readElementTextById(html, 'productTitle')
        || readMetaContent(html, 'og:title')
        || readTitleTag(html)
    );
    const description = truncate(
        cleanText(product.description || readMetaContent(html, 'og:description') || readMetaContent(html, 'description')),
        DESCRIPTION_MAX_LENGTH
    );
    const imageUrl = absoluteUrl(
        imageFromValue(product.image)
        || readLandingImage(html, baseUrl)
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        baseUrl
    );

    return {
        title,
        description,
        imageUrl,
        price: formatOfferPrice(product.offers) || readPriceFromHtml(html),
        brand: brandName(product.brand) || cleanText(readElementTextById(html, 'bylineInfo')).replace(/^Brand:\s*/i, ''),
        rating: formatRating(product.aggregateRating) || readRatingFromHtml(html),
        availability: availabilityText(offer.availability),
    };
}

function extractAmazonMusicInfo(html, parsed) {
    const music = findJsonLdByType(
        html,
        ['MusicAlbum', 'MusicRecording', 'MusicGroup', 'PodcastSeries', 'PodcastEpisode', 'Playlist', 'Event', 'CreativeWork'],
        node => node.name && (node.image || node.byArtist || node.author)
    ) || {};
    const title = cleanAmazonMusicTitle(
        music.name
        || readMetaContent(html, 'og:title')
        || readMetaContent(html, 'twitter:title')
        || readTitleTag(html)
    );

    return {
        title,
        description: readGenericDescription(html, music),
        imageUrl: readGenericImage(html, music, parsed.canonicalUrl),
        musicType: musicTypeLabel(parsed.route),
        artist: thingNames(music.byArtist || music.artist || music.author || music.creator).join(', '),
        album: thingName(music.inAlbum || music.album || music.partOfAlbum),
        date: cleanText(music.datePublished || music.releaseDate || ''),
    };
}

function extractPrimeVideoInfo(html, parsed) {
    const video = findJsonLdByType(
        html,
        ['Movie', 'TVSeries', 'TVSeason', 'TVEpisode', 'VideoObject', 'CreativeWork'],
        node => node.name && (node.image || node.genre || node.aggregateRating)
    ) || {};
    const title = cleanPrimeVideoTitle(
        video.name
        || video.headline
        || readMetaContent(html, 'og:title')
        || readMetaContent(html, 'twitter:title')
        || readTitleTag(html)
    );

    return {
        title,
        description: readGenericDescription(html, video),
        imageUrl: readGenericImage(html, video, parsed.canonicalUrl),
        genre: formatList(video.genre),
        rating: formatAggregateRating(video.aggregateRating),
        year: yearFromDate(video.datePublished || video.releasedEvent?.startDate || ''),
        maturityRating: cleanText(video.contentRating || ''),
        duration: formatIsoDuration(video.duration || ''),
    };
}

function extractAmazonInfo(html, parsed) {
    if (parsed.kind === 'music') return extractAmazonMusicInfo(html, parsed);
    if (parsed.kind === 'primeVideo') return extractPrimeVideoInfo(html, parsed);
    return extractProductInfo(html, parsed);
}

function addField(fields, name, value, inline = true) {
    const text = truncate(cleanText(value), FIELD_MAX_LENGTH);
    if (!text) return;
    fields.push({ name, value: text, inline });
}

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(word => word && text.includes(word));
}

function requesterName(message, lang, anonymous) {
    if (anonymous) return tr(STR.anonymousRequester, lang);
    return `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
}

function serviceNameFor(parsed) {
    if (parsed.kind === 'music') return 'Amazon Music';
    if (parsed.kind === 'primeVideo') return 'Prime Video';
    return 'Amazon';
}

function openButtonLabelFor(parsed, lang) {
    if (parsed.kind === 'music') return tr(STR.openMusicButton, lang);
    if (parsed.kind === 'primeVideo') return tr(STR.openPrimeVideoButton, lang);
    return tr(STR.openButton, lang);
}

function fallbackTitleFor(parsed, lang) {
    if (parsed.kind === 'music') return `${tr(STR.musicFallbackTitle, lang)}${parsed.id}`;
    if (parsed.kind === 'primeVideo') return `${tr(STR.primeVideoFallbackTitle, lang)}${parsed.id}`;
    return `${tr(STR.fallbackTitle, lang)}${parsed.asin || parsed.id}`;
}

function addProductFields(fields, info, parsed, lang) {
    addField(fields, tr(STR.priceField, lang), info.price);
    addField(fields, tr(STR.brandField, lang), info.brand);
    addField(fields, tr(STR.ratingField, lang), info.rating);
    addField(fields, tr(STR.availabilityField, lang), info.availability);
    addField(fields, tr(STR.asinField, lang), parsed.asin);
}

function addMusicFields(fields, info, parsed, lang) {
    addField(fields, tr(STR.typeField, lang), info.musicType);
    addField(fields, tr(STR.artistField, lang), info.artist);
    addField(fields, tr(STR.albumField, lang), info.album);
    addField(fields, tr(STR.dateField, lang), info.date);
    addField(fields, tr(STR.idField, lang), parsed.id);
}

function addPrimeVideoFields(fields, info, parsed, lang) {
    addField(fields, tr(STR.genreField, lang), info.genre);
    addField(fields, tr(STR.yearField, lang), info.year);
    addField(fields, tr(STR.maturityField, lang), info.maturityRating);
    addField(fields, tr(STR.durationField, lang), info.duration);
    addField(fields, tr(STR.ratingField, lang), info.rating);
    addField(fields, tr(STR.idField, lang), parsed.id);
}

function buildComponents(lang, parsed, hasImage) {
    const rows = [];
    const firstRow = [
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(openButtonLabelFor(parsed, lang))
            .setURL(parsed.openUrl || parsed.canonicalUrl),
    ];
    if (hasImage) {
        firstRow.push(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Primary)
                .setLabel(tr(STR.showMediaAsAttachmentsButton, lang))
                .setCustomId('showMediaAsAttachments')
        );
    }
    rows.push({ type: ComponentType.ActionRow, components: firstRow });
    rows.push({
        type: ComponentType.ActionRow,
        components: [
            new ButtonBuilder()
                .setStyle(ButtonStyle.Primary)
                .setLabel(tr(STR.translateButton, lang))
                .setCustomId('translate'),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Danger)
                .setLabel(tr(STR.deleteButton, lang))
                .setCustomId('delete:amazon'),
        ],
    });
    return rows;
}

function buildEmbed(parsed, info, message, s) {
    const lang = normalizeLanguage(s);
    const fields = [];
    if (parsed.kind === 'music') addMusicFields(fields, info, parsed, lang);
    else if (parsed.kind === 'primeVideo') addPrimeVideoFields(fields, info, parsed, lang);
    else addProductFields(fields, info, parsed, lang);

    const embed = {
        title: info.title || fallbackTitleFor(parsed, lang),
        url: parsed.canonicalUrl,
        description: info.description || undefined,
        color: AMAZON_COLOR,
        fields,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName(message, lang, s?.anonymous_expand === true)} - ${serviceNameFor(parsed)}` },
    };
    if (info.imageUrl) embed.image = { url: info.imageUrl };
    return embed;
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const initialParsed = parseAmazonUrl(url);
    if (!initialParsed) return null;

    let parsed = initialParsed;
    let html = '';
    try {
        const page = await fetchAmazonPage(url);
        html = page.html;
        const resolvedParsed = parseAmazonUrl(page.finalUrl);
        if (resolvedParsed?.id) {
            parsed = {
                ...resolvedParsed,
                openUrl: initialParsed.openUrl || url,
            };
        }
    } catch (err) {
        if (!initialParsed.id) {
            recordProviderError('amazon', err, message, url, { endpointKey: 'amazon/page' });
            return null;
        }
    }

    if (!parsed.id) return null;

    const info = html ? extractAmazonInfo(html, parsed) : {};
    const bannedTarget = [
        info.title,
        info.description,
        info.brand,
        info.artist,
        info.album,
        info.genre,
    ].filter(Boolean).join('\n');
    if (containsBannedWord(bannedTarget, s.bannedWords)) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [buildEmbed(parsed, info, message, s)],
        components: buildComponents(normalizeLanguage(s), parsed, !!info.imageUrl),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const amazonProvider = {
    id: 'amazon',
    enabledByDefault: false,
    urlPattern: AMAZON_URL_PATTERN,
    extract,
};

module.exports = amazonProvider;
module.exports._internal = {
    extractAmazonMusicInfo,
    extractPrimeVideoInfo,
    extractProductInfo,
    parseAmazonUrl,
    readLandingImage,
    readMetaContent,
};
