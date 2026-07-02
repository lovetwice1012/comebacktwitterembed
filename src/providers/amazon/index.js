'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
const { createProviderAnalytics, facet, finiteNumber } = require('../../analytics/providerMetrics');
const {
    applyEmbedMedia,
    attachmentMediaUrls,
    buildFailureResponse,
    mediaButtonAllowed,
    mediaLinksContent,
    resolveDensityMaxLength,
    shouldShowOutputItem,
} = require('../_output_controls');
const { toApiLocaleFamily } = require('../../discordLocales');

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
const AMAZON_EXTRACT_TARGETS = ['product', 'prime_video', 'music'];
const AMAZON_KIND_TARGET = {
    product: 'product',
    primeVideo: 'prime_video',
    music: 'music',
};
const REQUEST_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};
const AMAZON_MUSIC_SOCIAL_HEADERS = {
    ...REQUEST_HEADERS,
    'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
};
const AMAZON_MUSIC_EMBED_HEADERS = {
    ...REQUEST_HEADERS,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
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
    sellerField: { ja: 'Seller', en: 'Seller' },
    shippingField: { ja: 'Shipping', en: 'Shipping' },
    ratingField: { ja: 'Rating', en: 'Rating' },
    reviewCountField: { ja: 'Review count', en: 'Review count' },
    availabilityField: { ja: 'Availability', en: 'Availability' },
    couponField: { ja: 'Coupon', en: 'Coupon' },
    dealField: { ja: 'Deal', en: 'Deal' },
    artistField: { ja: 'Artist', en: 'Artist' },
    albumField: { ja: 'Album', en: 'Album' },
    dateField: { ja: 'Date', en: 'Date' },
    genreField: { ja: 'Genre', en: 'Genre' },
    castField: { ja: 'Cast', en: 'Cast' },
    seasonField: { ja: 'Season', en: 'Season' },
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
    return toApiLocaleFamily(settings?.defaultLanguage);
}

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

function amazonDescriptionMaxLength(settings) {
    return resolveDensityMaxLength(settings, 'amazon_description_max_length', DESCRIPTION_MAX_LENGTH, {
        compact: 200,
        detail: DESCRIPTION_MAX_LENGTH,
        hardMax: DESCRIPTION_MAX_LENGTH,
    });
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

function readElementsHtmlByAttr(html, attrName, attrValue) {
    const attr = escapeRegExp(attrName);
    const value = escapeRegExp(attrValue);
    const re = new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*\\b${attr}\\s*=\\s*["']${value}["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const out = [];
    let match;
    while ((match = re.exec(html)) !== null) {
        out.push(match[2]);
    }
    return out;
}

function readFirstElementHtmlByAttr(html, attrName, attrValue) {
    return readElementsHtmlByAttr(html, attrName, attrValue)[0] || '';
}

function readElementTextsByAttr(html, attrName, attrValue) {
    return readElementsHtmlByAttr(html, attrName, attrValue)
        .map(value => cleanText(value))
        .filter(Boolean);
}

function readOpeningTagsByAttr(html, attrName, attrValue) {
    const attr = escapeRegExp(attrName);
    const value = escapeRegExp(attrValue);
    return html.match(new RegExp(`<[a-zA-Z0-9:-]+\\b(?=[^>]*\\b${attr}\\s*=\\s*["']${value}["'])[^>]*>`, 'gi')) || [];
}

function readFirstOpeningTagByAttr(html, attrName, attrValue) {
    return readOpeningTagsByAttr(html, attrName, attrValue)[0] || '';
}

function readAttributeValues(html, attrName) {
    const attr = escapeRegExp(attrName);
    const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
    const out = [];
    let match;
    while ((match = re.exec(html)) !== null) {
        const value = cleanText(decodeHtml(match[2] || match[3] || match[4] || ''));
        if (value) out.push(value);
    }
    return out;
}

function readFirstElementTextById(html, ids) {
    for (const id of ids) {
        const text = readElementTextById(html, id);
        if (text) return text;
    }
    return '';
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

async function fetchAmazonPage(rawUrl, headers = REQUEST_HEADERS) {
    const res = await fetch(rawUrl, { headers, redirect: 'follow' });
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

async function fetchJsonPage(rawUrl, headers = REQUEST_HEADERS) {
    const res = await fetch(rawUrl, { headers, redirect: 'follow' });
    if (!res.ok) {
        /** @type {Error & {status?: number}} */
        const err = new Error(`amazon json ${res.status} for ${rawUrl}`);
        err.status = res.status;
        throw err;
    }
    const text = await res.text();
    const parsed = parseJsonSafely(text);
    if (!parsed || typeof parsed !== 'object') {
        /** @type {Error & {status?: number}} */
        const err = new Error(`amazon json parse failed for ${rawUrl}`);
        err.status = res.status;
        throw err;
    }
    return parsed;
}

function amazonMusicOembedUrl(parsed) {
    const host = parsed.host || normalizeAmazonMusicHost(new URL(parsed.canonicalUrl).hostname);
    return `https://${host}/embed/oembed?url=${encodeURIComponent(parsed.canonicalUrl)}`;
}

function iframeSrcFromHtml(html, baseUrl) {
    const tag = String(html || '').match(/<iframe\b[^>]*>/i)?.[0] || '';
    return absoluteUrl(extractAttr(tag, 'src'), baseUrl);
}

async function fetchAmazonMusicSupplement(parsed) {
    const supplement = { socialHtml: '', embedHtml: '', oembed: null };

    try {
        const page = await fetchAmazonPage(parsed.canonicalUrl, AMAZON_MUSIC_SOCIAL_HEADERS);
        supplement.socialHtml = page.html;
    } catch {
        // Amazon Music still has enough fallbacks below when social metadata is unavailable.
    }

    try {
        const oembedUrl = amazonMusicOembedUrl(parsed);
        const oembed = await fetchJsonPage(oembedUrl, AMAZON_MUSIC_SOCIAL_HEADERS);
        supplement.oembed = oembed;
        const iframeSrc = iframeSrcFromHtml(oembed.html, oembedUrl);
        if (iframeSrc) {
            const embedPage = await fetchAmazonPage(iframeSrc, AMAZON_MUSIC_EMBED_HEADERS);
            supplement.embedHtml = embedPage.html;
        }
    } catch {
        // oEmbed is supplemental only; keep the normal page metadata if it fails.
    }

    return supplement;
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
        seller: thingName(offer.seller || offer.offeredBy || offer.vendor),
        shipping: thingName(offer.shippingDetails)
            || thingName(offer.availableDeliveryMethod)
            || cleanText(offer.shippingDetails?.shippingRate?.value || ''),
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

function reviewCountText(aggregateRating) {
    if (!aggregateRating || typeof aggregateRating !== 'object') return '';
    const count = aggregateRating.reviewCount ?? aggregateRating.ratingCount;
    return count === undefined || count === null || count === '' ? '' : formatNumber(count);
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

function readReviewCountFromHtml(html) {
    const reviewText = readElementTextById(html, 'acrCustomerReviewText');
    const reviewMatch = reviewText.match(/[\d,.]+/);
    return reviewMatch ? reviewMatch[0] : '';
}

function normalizePromoText(value) {
    return cleanText(value)
        .replace(/\s+/g, ' ')
        .replace(/^Coupon:\s*/i, '')
        .replace(/^Deal:\s*/i, '')
        .trim();
}

function readCouponFromHtml(html) {
    return normalizePromoText(readFirstElementTextById(html, [
        'couponText',
        'couponBadge',
        'couponBadgeRegular',
        'couponApplyText',
    ]));
}

function readDealFromHtml(html) {
    return normalizePromoText(readFirstElementTextById(html, [
        'dealBadge',
        'dealBadge_feature_div',
        'dealprice_savings',
        'priceblock_savings',
        'priceSavingPercentage',
        'promoPriceBlockMessage',
    ]));
}

function readGenericImage(html, node, baseUrl) {
    return absoluteUrl(
        imageFromValue(node?.image)
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        baseUrl
    );
}

function readGenericDescription(html, node, settings) {
    return truncate(
        cleanText(node?.description || readMetaContent(html, 'og:description') || readMetaContent(html, 'description')),
        amazonDescriptionMaxLength(settings)
    );
}

function firstCleanText(...values) {
    for (const value of values) {
        const text = cleanText(value);
        if (text) return text;
    }
    return '';
}

function cleanAmazonMusicTitle(value) {
    return cleanText(value)
        .replace(/^Amazon Music\s*-\s*(?:Track|Album|Playlist|Artist|Podcast)\s+/i, '')
        .replace(/\s+on Amazon Music(?: Unlimited)?$/i, '')
        .replace(/\s*-\s*Amazon Music.*$/i, '')
        .trim();
}

function musicTypeLabel(route) {
    return AMAZON_MUSIC_ROUTE_LABELS[route] || 'Music';
}

function isGenericAmazonMusicDescription(value) {
    const text = cleanText(value).toLowerCase();
    return !text
        || text === 'on amazon music'
        || text.startsWith('amazon music embed widget')
        || text === 'stream music and podcasts free on amazon music. no credit card required.';
}

function meaningfulAmazonMusicDescription(...values) {
    for (const value of values) {
        const text = cleanText(value);
        if (text && !isGenericAmazonMusicDescription(text)) return text;
    }
    return '';
}

function splitAmazonMusicTitleAndArtist(value) {
    const text = cleanAmazonMusicTitle(value);
    const parts = text.split(/\s+[–—]\s+/).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return { title: text, artist: '' };
    return {
        title: parts[0],
        artist: parts.slice(1).join(' - '),
    };
}

function amazonMusicSeoTitleInfo(value) {
    const text = cleanAmazonMusicTitle(value);
    const match = text.match(/^(.+?)\s+(?:song|track)\s+by\s+(.+?)(?:\s+from\s+(.+?))?\s+on Amazon Music$/i)
        || text.match(/^(.+?)\s+album\s+by\s+(.+?)\s+on Amazon Music$/i);
    if (!match) return {};
    return {
        title: cleanText(match[1]),
        artist: cleanText(match[2]),
        album: cleanText(match[3] || ''),
    };
}

function readInputValueById(html, id) {
    const attr = escapeRegExp(id);
    const tag = html.match(new RegExp(`<input\\b(?=[^>]*\\bid=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    return tag ? cleanText(extractAttr(tag, 'value')) : '';
}

function readAriaLabelValue(html, prefixes) {
    for (const prefix of prefixes) {
        const attr = escapeRegExp(prefix);
        const tag = html.match(new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*\\baria-label=["']${attr}\\s*,\\s*([^"']+)["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
        if (!tag) continue;
        const label = cleanText(tag[2]);
        const body = cleanText(tag[3]);
        if (body && body.length <= Math.max(label.length + 20, 80)) return body;
        if (label) return label;
    }
    return '';
}

function readImageSrcByAlt(html, alt) {
    const attr = escapeRegExp(alt);
    const tag = html.match(new RegExp(`<img\\b(?=[^>]*\\balt=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    return tag ? extractAttr(tag, 'src') : '';
}

function amazonMusicPictureBlocks(html) {
    const blocks = html.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi) || [];
    const preferred = blocks.filter(block => /\bclass\s*=\s*["'][^"']*\bimageWrapper\b/i.test(block));
    return preferred.length > 0 ? preferred : blocks;
}

function readAmazonMusicDetailImage(html, baseUrl) {
    const candidates = [];
    let order = 0;
    for (const block of amazonMusicPictureBlocks(html)) {
        const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || '';
        const dataSrc = absoluteUrl(extractAttr(imgTag, 'data-src'), baseUrl);
        if (dataSrc) return dataSrc;

        const sourceTags = block.match(/<source\b[^>]*>/gi) || [];
        for (const tag of sourceTags) {
            candidates.push(...srcSetCandidates(
                extractAttr(tag, 'srcset'),
                baseUrl,
                sourceTypePriority(extractAttr(tag, 'type')),
                order
            ));
            order += 100;
        }

        candidates.push(...srcSetCandidates(
            extractAttr(imgTag, 'srcset'),
            baseUrl,
            sourceTypePriority(''),
            order
        ));
        order += 100;

        const imgSrc = absoluteUrl(extractAttr(imgTag, 'src'), baseUrl);
        if (imgSrc) {
            candidates.push({
                url: imgSrc,
                width: widthFromImageUrl(imgSrc),
                density: 1,
                priority: sourceTypePriority(''),
                order,
            });
            order += 100;
        }
    }

    candidates.sort((a, b) => (
        a.priority - b.priority
        || b.width - a.width
        || b.density - a.density
        || a.order - b.order
    ));
    return candidates[0]?.url || '';
}

function formatSecondsDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = Math.floor(seconds % 60);
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (rest || parts.length === 0) parts.push(`${rest}s`);
    return parts.join(' ');
}

function formatVerboseDuration(value) {
    const match = cleanText(value).match(/\b(?:(\d+)\s+HOURS?\s+)?(?:(\d+)\s+MINUTES?\s+)?(?:(\d+)\s+SECONDS?)\b/i);
    if (!match) return '';
    const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
    return formatSecondsDuration(seconds);
}

function readAmazonMusicVisibleMeta(html) {
    const text = cleanText(html);
    const match = text.match(/\b((?:(?:\d+)\s+HOURS?\s+)?(?:(?:\d+)\s+MINUTES?\s+)?(?:(?:\d+)\s+SECONDS?))(?:\s*[•|]\s*([A-Z]{3}\s+\d{1,2}\s+\d{4}|\d{4}))?/i);
    if (!match) return { duration: '', date: '' };
    return {
        duration: formatVerboseDuration(match[1]),
        date: cleanText(match[2] || ''),
    };
}

function extractAmazonMusicHtmlInfo(html, parsed) {
    const ogTitle = readMetaContent(html, 'og:title') || readMetaContent(html, 'twitter:title');
    const splitTitle = splitAmazonMusicTitleAndArtist(ogTitle);
    const seoTitle = amazonMusicSeoTitleInfo(readTitleTag(html));
    const visibleMeta = readAmazonMusicVisibleMeta(html);
    const oembedTitle = cleanAmazonMusicTitle(readTitleTag(html).replace(/^Amazon Music\s*-\s*/i, ''));

    return {
        title: firstCleanText(
            readAriaLabelValue(html, ['song', 'track', musicTypeLabel(parsed.route).toLowerCase()]),
            seoTitle.title,
            splitTitle.title,
            oembedTitle
        ),
        description: meaningfulAmazonMusicDescription(
            readMetaContent(html, 'og:description'),
            readMetaContent(html, 'twitter:description'),
            readMetaContent(html, 'description')
        ),
        imageUrl: absoluteUrl(
            readAmazonMusicDetailImage(html, parsed.canonicalUrl)
            || readImageSrcByAlt(html, 'Cover Art')
            || readMetaContent(html, 'og:image')
            || readMetaContent(html, 'twitter:image'),
            parsed.canonicalUrl
        ),
        artist: firstCleanText(
            readAriaLabelValue(html, ['artist']),
            seoTitle.artist,
            splitTitle.artist
        ),
        album: firstCleanText(
            readInputValueById(html, 'ALBUM_TITLE'),
            readAriaLabelValue(html, ['album']),
            seoTitle.album
        ),
        date: visibleMeta.date,
        duration: formatSecondsDuration(readMetaContent(html, 'music:duration')) || visibleMeta.duration,
    };
}

function cleanPrimeVideoTitle(value) {
    return cleanText(value)
        .replace(/^Prime Video:\s*/i, '')
        .replace(/\s*-\s*Prime Video\s*$/i, '')
        .trim();
}

function primeVideoPictureBlocks(html) {
    const blocks = html.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi) || [];
    const preferred = blocks.filter(block => (
        /\bdata-testid\s*=\s*["']base-image["']/i.test(block)
        || /pv-target-images/i.test(block)
    ));
    return preferred.length > 0 ? preferred : blocks;
}

function sourceTypePriority(type) {
    const value = cleanText(type).toLowerCase();
    if (value === 'image/jpeg' || value === 'image/jpg') return 0;
    if (!value) return 1;
    if (value === 'image/webp') return 2;
    if (value === 'image/avif') return 3;
    return 4;
}

function widthFromImageUrl(url) {
    const match = String(url || '').match(/[._](?:S|U)X(\d+)[_.]/i);
    return match ? Number(match[1]) : 0;
}

function srcSetCandidates(srcset, baseUrl, priority, orderStart) {
    return String(srcset || '')
        .split(',')
        .map((entry, index) => {
            const trimmed = entry.trim();
            const width = Number(trimmed.match(/\s+(\d+)w(?:\s*$|\s)/)?.[1] || 0);
            const density = Number(trimmed.match(/\s+(\d+(?:\.\d+)?)x(?:\s*$|\s)/)?.[1] || 0);
            const rawUrl = trimmed.replace(/\s+(?:\d+w|\d+(?:\.\d+)?x)\s*$/, '').trim();
            const url = absoluteUrl(rawUrl, baseUrl);
            return url ? {
                url,
                width: width || widthFromImageUrl(url),
                density,
                priority,
                order: orderStart + index,
            } : null;
        })
        .filter(Boolean);
}

function readPrimeVideoPictureImage(html, baseUrl) {
    const candidates = [];
    let order = 0;
    for (const block of primeVideoPictureBlocks(html)) {
        const sourceTags = block.match(/<source\b[^>]*>/gi) || [];
        for (const tag of sourceTags) {
            const type = extractAttr(tag, 'type');
            const srcset = extractAttr(tag, 'srcset');
            candidates.push(...srcSetCandidates(srcset, baseUrl, sourceTypePriority(type), order));
            order += 100;
        }

        const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || '';
        const imgUrl = absoluteUrl(extractAttr(imgTag, 'src'), baseUrl);
        if (imgUrl) {
            candidates.push({
                url: imgUrl,
                width: widthFromImageUrl(imgUrl),
                priority: sourceTypePriority(''),
                order,
            });
            order += 100;
        }
    }

    candidates.sort((a, b) => (
        a.priority - b.priority
        || b.width - a.width
        || a.order - b.order
    ));
    return candidates[0]?.url || '';
}

function readPrimeVideoPictureAlt(html) {
    for (const block of primeVideoPictureBlocks(html)) {
        const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || '';
        const alt = cleanPrimeVideoTitle(extractAttr(imgTag, 'alt'));
        if (alt) return alt;
    }
    return '';
}

function uniqueTexts(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = cleanText(value);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

function readPrimeVideoGenres(html) {
    const container = readFirstElementHtmlByAttr(html, 'data-testid', 'dv-node-dp-genres') || html;
    const genres = readElementTextsByAttr(container, 'data-testid', 'genre-texts');
    return uniqueTexts(genres).join(', ');
}

function readPrimeVideoCustomerRating(html) {
    const tag = readFirstOpeningTagByAttr(html, 'data-testid', 'star-rating-badge')
        || readFirstOpeningTagByAttr(html, 'data-automation-id', 'star-rating-badge');
    const aria = cleanText(extractAttr(tag, 'aria-label'));
    const body = cleanText(readFirstElementHtmlByAttr(html, 'data-testid', 'star-rating-badge'));
    const rating = aria.match(/5\u3064\u661f\u306e\u3046\u3061\s*([0-5](?:[.,]\d+)?)/)?.[1]
        || aria.match(/([0-5](?:[.,]\d+)?)\s*(?:out of|\/)\s*5/i)?.[1]
        || body.match(/([0-5](?:[.,]\d+)?)\s*\/\s*5/i)?.[1]
        || '';
    if (!rating) return '';

    const count = aria.match(/([\d,.]+)\s*(?:\u4eba|ratings?|reviews?)/i)?.[1] || '';
    return `Amazon ${rating.replace(',', '.')}/5${count ? ` (${count})` : ''}`;
}

function readPrimeVideoImdbRating(html) {
    const tag = readFirstOpeningTagByAttr(html, 'data-automation-id', 'imdb-rating-badge');
    const aria = cleanText(extractAttr(tag, 'aria-label'));
    const body = cleanText(readFirstElementHtmlByAttr(html, 'data-automation-id', 'imdb-rating-badge'));
    const text = body || aria;
    const rating = text.match(/IMDb[^0-9]*([0-9]+(?:[.,][0-9]+)?)(?:\s*\/\s*10)?/i)?.[1] || '';
    return rating ? `IMDb ${rating.replace(',', '.')}/10` : '';
}

function readPrimeVideoRating(html) {
    return [readPrimeVideoCustomerRating(html), readPrimeVideoImdbRating(html)]
        .filter(Boolean)
        .join(', ');
}

function readPrimeVideoReleaseYear(html) {
    const text = readElementTextsByAttr(html, 'data-automation-id', 'release-year-badge')[0]
        || readAttributeValues(html, 'aria-label').find(label => /(?:release year|\u516c\u958b\u5e74)/i.test(label))
        || '';
    return yearFromDate(text);
}

function readPrimeVideoSeason(html) {
    const label = readAttributeValues(html, 'aria-label')
        .find(value => /(?:seasons?|\u30b7\u30fc\u30ba\u30f3\u6570)/i.test(value) && /\d/.test(value));
    return cleanText(label || '');
}

function readPrimeVideoImage(html, node, baseUrl) {
    return absoluteUrl(
        imageFromValue(node?.image)
        || readPrimeVideoPictureImage(html, baseUrl)
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        baseUrl
    );
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

function seasonText(value) {
    const item = firstArrayItem(value);
    if (!item) return '';
    if (typeof item === 'string' || typeof item === 'number') return cleanText(item);
    if (typeof item !== 'object') return '';
    const name = cleanText(item.name || item.title || '');
    const number = cleanText(item.seasonNumber || item.position || '');
    if (name && number && !name.includes(number)) return `${name} (${number})`;
    return name || (number ? `Season ${number}` : '');
}

function extractProductInfo(html, parsed, settings) {
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
        amazonDescriptionMaxLength(settings)
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
        seller: offer.seller,
        shipping: offer.shipping,
        rating: formatRating(product.aggregateRating) || readRatingFromHtml(html),
        reviewCount: reviewCountText(product.aggregateRating) || readReviewCountFromHtml(html),
        availability: availabilityText(offer.availability),
        coupon: readCouponFromHtml(html),
        deal: readDealFromHtml(html),
    };
}

function extractAmazonMusicInfo(html, parsed, settings, supplement = {}) {
    const music = findJsonLdByType(
        html,
        ['MusicAlbum', 'MusicRecording', 'MusicGroup', 'PodcastSeries', 'PodcastEpisode', 'Playlist', 'Event', 'CreativeWork'],
        node => node.name && (node.image || node.byArtist || node.author)
    ) || {};
    const htmlInfo = extractAmazonMusicHtmlInfo(html, parsed);
    const oembed = supplement.oembed || {};

    const oembedTitle = cleanAmazonMusicTitle(oembed.title || '');
    const title = firstCleanText(
        music.name,
        htmlInfo.title,
        oembedTitle
    );
    const artist = firstCleanText(
        htmlInfo.artist,
        thingNames(music.byArtist || music.artist || music.author || music.creator).join(', ')
    );
    const album = firstCleanText(
        htmlInfo.album,
        thingName(music.inAlbum || music.album || music.partOfAlbum)
    );
    const description = truncate(
        meaningfulAmazonMusicDescription(
            music.description,
            htmlInfo.description,
            oembed.description
        ),
        amazonDescriptionMaxLength(settings)
    );
    const imageUrl = absoluteUrl(
        imageFromValue(music.image)
        || htmlInfo.imageUrl
        || oembed.thumbnail_url
        || readMetaContent(html, 'og:image')
        || readMetaContent(html, 'twitter:image'),
        parsed.canonicalUrl
    );

    return {
        title,
        description,
        imageUrl,
        musicType: musicTypeLabel(parsed.route),
        artist,
        album,
        date: firstCleanText(music.datePublished, music.releaseDate, htmlInfo.date),
        duration: htmlInfo.duration,
    };
}

function extractPrimeVideoInfo(html, parsed, settings) {
    const video = findJsonLdByType(
        html,
        ['Movie', 'TVSeries', 'TVSeason', 'TVEpisode', 'VideoObject', 'CreativeWork'],
        node => node.name && (node.image || node.genre || node.aggregateRating)
    ) || {};
    const title = cleanPrimeVideoTitle(
        video.name
        || video.headline
        || readPrimeVideoPictureAlt(html)
        || readMetaContent(html, 'og:title')
        || readMetaContent(html, 'twitter:title')
        || readTitleTag(html)
    );

    return {
        title,
        description: readGenericDescription(html, video, settings),
        imageUrl: readPrimeVideoImage(html, video, parsed.canonicalUrl),
        genre: formatList(video.genre) || readPrimeVideoGenres(html),
        cast: thingNames(video.actor || video.actors || video.performer || video.contributor).join(', '),
        season: seasonText(video.partOfSeason || video.season || video.containsSeason) || readPrimeVideoSeason(html),
        rating: formatAggregateRating(video.aggregateRating) || readPrimeVideoRating(html),
        year: yearFromDate(video.datePublished || video.releasedEvent?.startDate || '') || readPrimeVideoReleaseYear(html),
        maturityRating: cleanText(video.contentRating || ''),
        duration: formatIsoDuration(video.duration || ''),
    };
}

function extractAmazonInfo(html, parsed, settings, supplement) {
    if (parsed.kind === 'music') return extractAmazonMusicInfo(html, parsed, settings, supplement);
    if (parsed.kind === 'primeVideo') return extractPrimeVideoInfo(html, parsed, settings);
    return extractProductInfo(html, parsed, settings);
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

function addProductFields(fields, info, parsed, lang, s) {
    if (shouldShowOutputItem(s, 'price')) addField(fields, tr(STR.priceField, lang), info.price);
    if (shouldShowOutputItem(s, 'brand')) addField(fields, tr(STR.brandField, lang), info.brand);
    if (shouldShowOutputItem(s, 'seller')) addField(fields, tr(STR.sellerField, lang), info.seller);
    if (shouldShowOutputItem(s, 'shipping')) addField(fields, tr(STR.shippingField, lang), info.shipping);
    if (shouldShowOutputItem(s, 'rating')) addField(fields, tr(STR.ratingField, lang), info.rating);
    if (shouldShowOutputItem(s, 'review_count')) addField(fields, tr(STR.reviewCountField, lang), info.reviewCount);
    if (shouldShowOutputItem(s, 'availability')) addField(fields, tr(STR.availabilityField, lang), info.availability);
    if (shouldShowOutputItem(s, 'coupon')) addField(fields, tr(STR.couponField, lang), info.coupon);
    if (shouldShowOutputItem(s, 'deal')) addField(fields, tr(STR.dealField, lang), info.deal);
    if (shouldShowOutputItem(s, 'id')) addField(fields, tr(STR.asinField, lang), parsed.asin);
}

function addMusicFields(fields, info, parsed, lang, s) {
    if (shouldShowOutputItem(s, 'type')) addField(fields, tr(STR.typeField, lang), info.musicType);
    if (shouldShowOutputItem(s, 'artist')) addField(fields, tr(STR.artistField, lang), info.artist);
    if (shouldShowOutputItem(s, 'album')) addField(fields, tr(STR.albumField, lang), info.album);
    if (shouldShowOutputItem(s, 'date')) addField(fields, tr(STR.dateField, lang), info.date);
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.durationField, lang), info.duration);
    if (shouldShowOutputItem(s, 'id')) addField(fields, tr(STR.idField, lang), parsed.id);
}

function addPrimeVideoFields(fields, info, parsed, lang, s) {
    if (shouldShowOutputItem(s, 'genre')) addField(fields, tr(STR.genreField, lang), info.genre);
    if (shouldShowOutputItem(s, 'cast')) addField(fields, tr(STR.castField, lang), info.cast);
    if (shouldShowOutputItem(s, 'season')) addField(fields, tr(STR.seasonField, lang), info.season);
    if (shouldShowOutputItem(s, 'year')) addField(fields, tr(STR.yearField, lang), info.year);
    if (shouldShowOutputItem(s, 'maturity')) addField(fields, tr(STR.maturityField, lang), info.maturityRating);
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.durationField, lang), info.duration);
    if (shouldShowOutputItem(s, 'rating')) addField(fields, tr(STR.ratingField, lang), info.rating);
    if (shouldShowOutputItem(s, 'id')) addField(fields, tr(STR.idField, lang), parsed.id);
}

function buildComponents(lang, parsed, hasImage, settings) {
    const rows = [];
    const firstRow = [
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(openButtonLabelFor(parsed, lang))
            .setURL(parsed.openUrl || parsed.canonicalUrl),
    ];
    if (hasImage && mediaButtonAllowed(settings)) {
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
    if (parsed.kind === 'music') addMusicFields(fields, info, parsed, lang, s);
    else if (parsed.kind === 'primeVideo') addPrimeVideoFields(fields, info, parsed, lang, s);
    else addProductFields(fields, info, parsed, lang, s);

    const embed = {
        title: info.title || fallbackTitleFor(parsed, lang),
        url: parsed.canonicalUrl,
        description: info.description || undefined,
        color: AMAZON_COLOR,
        fields,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName(message, lang, s?.anonymous_expand === true)} - ${serviceNameFor(parsed)}` },
    };
    applyEmbedMedia(embed, info.imageUrl, s);
    return embed;
}

function buildAmazonAnalytics(parsed, info) {
    return createProviderAnalytics({
        content: {
            accountKey: info.brand || info.artist || parsed.kind,
            contentId: parsed.id,
            contentType: parsed.kind || 'product',
            contentUrl: parsed.canonicalUrl,
            title: info.title,
            descriptionPreview: info.description,
            authorName: info.brand || info.artist || info.album,
            mediaCount: info.imageUrl ? 1 : null,
            durationSeconds: finiteNumber(info.duration),
        },
        metrics: {
            price: finiteNumber(info.price),
            rating: finiteNumber(info.rating),
            reviews: finiteNumber(info.reviewCount),
            duration_seconds: finiteNumber(info.duration),
        },
        facets: [
            facet('brand', info.brand),
            facet('category', info.category || parsed.kind),
            facet('availability', info.availability),
            facet('artist', info.artist),
            facet('album', info.album),
            facet('genre', info.genre),
            facet('type', parsed.kind || 'product'),
        ],
    });
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const initialParsed = parseAmazonUrl(url);
    if (!initialParsed) return null;
    if (normalizeAmazonExtractTargets(s).length === 0) return null;
    if (!shouldExtractAmazonParsed(initialParsed, s)) return null;

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
            return buildFailureResponse('amazon', url, s, err);
        }
    }

    if (!parsed.id) return null;
    if (!shouldExtractAmazonParsed(parsed, s)) return null;

    let supplement = null;
    if (parsed.kind === 'music') {
        supplement = await fetchAmazonMusicSupplement(parsed);
        html = [
            html,
            supplement.socialHtml,
            supplement.embedHtml,
        ].filter(Boolean).join('\n');
    }

    const info = html ? extractAmazonInfo(html, parsed, s, supplement) : {};
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
        components: buildComponents(normalizeLanguage(s), parsed, !!info.imageUrl, s),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
        analytics: buildAmazonAnalytics(parsed, info),
    };

    const mediaFiles = attachmentMediaUrls(s, info.imageUrl);
    if (mediaFiles.length > 0) step.files = mediaFiles;
    const mediaContent = mediaLinksContent(s, info.imageUrl, 'Image');
    if (mediaContent) step.content = mediaContent;

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
    settings: [
        'bannedWords',
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'display_density',
        'media_display_mode',
        'amazon_description_max_length',
        'amazon_extract_targets',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'album', label: { en: 'Music album field', ja: 'Music album field' } },
                { value: 'artist', label: { en: 'Music artist field', ja: 'Music artist field' } },
                { value: 'brand', label: { en: 'Brand field', ja: 'Brand field' } },
                { value: 'seller', label: { en: 'Seller field', ja: 'Seller field' } },
                { value: 'shipping', label: { en: 'Shipping field', ja: 'Shipping field' } },
                { value: 'review_count', label: { en: 'Review count field', ja: 'Review count field' } },
                { value: 'coupon', label: { en: 'Coupon field', ja: 'Coupon field' } },
                { value: 'deal', label: { en: 'Deal field', ja: 'Deal field' } },
                { value: 'date', label: { en: 'Music date field', ja: 'Music date field' } },
                { value: 'duration', label: { en: 'Duration field', ja: 'Duration field' } },
                { value: 'genre', label: { en: 'Prime Video genre field', ja: 'Prime Video genre field' } },
                { value: 'cast', label: { en: 'Prime Video cast field', ja: 'Prime Video cast field' } },
                { value: 'season', label: { en: 'Prime Video season field', ja: 'Prime Video season field' } },
                { value: 'maturity', label: { en: 'Prime Video maturity field', ja: 'Prime Video maturity field' } },
                { value: 'type', label: { en: 'Music type field', ja: 'Music type field' } },
                { value: 'year', label: { en: 'Prime Video year field', ja: 'Prime Video year field' } },
                { value: 'price', label: { en: 'Price field', ja: '価格欄' } },
                { value: 'rating', label: { en: 'Rating field', ja: '評価欄' } },
                { value: 'availability', label: { en: 'Availability field', ja: '在庫/配信状況欄' } },
                { value: 'id', label: { en: 'ASIN/ID field', ja: 'ASIN/ID欄' } },
            ],
        },
    ],
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
