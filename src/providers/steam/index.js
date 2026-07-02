'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
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
const { createProviderAnalytics, facet, finiteNumber, tagFacets } = require('../../analytics/providerMetrics');

const STEAM_COLOR = 0x171a21;
const DESCRIPTION_MAX_LENGTH = 900;
const FIELD_MAX_LENGTH = 1024;
const STEAM_URL_PATTERN =
    /https?:\/\/(?:(?:store)\.steampowered\.com|(?:www\.)?steamcommunity\.com|s\.team)\/[^\s<>|]+/gi;
const STEAM_IMAGE_SOURCES = new Set(['header', 'screenshot', 'thumbnail']);

const REQUEST_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};

const TRACKING_QUERY_KEYS = [
    'snr',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'gclid',
    'fbclid',
];

const STR = {
    openStoreButton: { ja: 'Open in Steam Store', en: 'Open in Steam Store' },
    openCommunityButton: { ja: 'Open in Steam Community', en: 'Open in Steam Community' },
    openButton: { ja: 'Open in Steam', en: 'Open in Steam' },
    showImageAsAttachmentButton: { ja: 'Show image as attachment', en: 'Show image as attachment' },
    translateButton: { ja: 'Translate', en: 'Translate' },
    deleteButton: { ja: 'Delete', en: 'Delete' },
    typeField: { ja: 'Type', en: 'Type' },
    priceField: { ja: 'Price', en: 'Price' },
    discountField: { ja: 'Discount', en: 'Discount' },
    saleEndsField: { ja: 'Sale ends', en: 'Sale ends' },
    releaseDateField: { ja: 'Release date', en: 'Release date' },
    developerField: { ja: 'Developer', en: 'Developer' },
    publisherField: { ja: 'Publisher', en: 'Publisher' },
    genresField: { ja: 'Genres', en: 'Genres' },
    platformsField: { ja: 'Platforms', en: 'Platforms' },
    recommendationsField: { ja: 'Recommendations', en: 'Recommendations' },
    currentPlayersField: { ja: 'Current players', en: 'Current players' },
    reviewSummaryField: { ja: 'Review summary', en: 'Review summary' },
    metacriticField: { ja: 'Metacritic', en: 'Metacritic' },
    idField: { ja: 'ID', en: 'ID' },
    requesterPrefix: { ja: 'Requested by ', en: 'Requested by ' },
    anonymousRequester: { ja: 'Anonymous requester', en: 'Anonymous requester' },
    freeToPlay: { ja: 'Free To Play', en: 'Free To Play' },
    fallbackAppTitle: { ja: 'Steam app #', en: 'Steam app #' },
    fallbackPackageTitle: { ja: 'Steam package #', en: 'Steam package #' },
    fallbackBundleTitle: { ja: 'Steam bundle #', en: 'Steam bundle #' },
    fallbackWorkshopTitle: { ja: 'Steam Workshop item #', en: 'Steam Workshop item #' },
    fallbackMarketTitle: { ja: 'Steam market listing', en: 'Steam market listing' },
    fallbackProfileTitle: { ja: 'Steam profile', en: 'Steam profile' },
};

const KIND_LABELS = {
    app: 'App',
    package: 'Package',
    bundle: 'Bundle',
    workshop: 'Workshop item',
    market: 'Market listing',
    profile: 'Profile',
    workshopHub: 'Workshop',
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLanguage(settings) {
    return toApiLocaleFamily(settings?.defaultLanguage);
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

function steamDescriptionMaxLength(settings) {
    return resolveDensityMaxLength(settings, 'steam_description_max_length', DESCRIPTION_MAX_LENGTH, {
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

function readTitleTag(html) {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match ? cleanText(match[1]) : '';
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

function normalizeNumericId(value) {
    const match = String(value || '').trim().match(/^(\d{1,20})(?=$|[^\d])/);
    return match?.[1] || '';
}

function normalizeSteamTextId(value) {
    const text = String(value || '').trim();
    const match = text.match(/^([A-Za-z0-9][A-Za-z0-9._-]{1,63})(?=$|[^A-Za-z0-9._-])/);
    return match?.[1] || '';
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

function stripTracking(rawUrl) {
    const url = new URL(rawUrl);
    for (const key of TRACKING_QUERY_KEYS) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
}

function canonicalStoreUrl(kind, id) {
    if (kind === 'package') return `https://store.steampowered.com/sub/${encodeURIComponent(id)}`;
    if (kind === 'bundle') return `https://store.steampowered.com/bundle/${encodeURIComponent(id)}`;
    return `https://store.steampowered.com/app/${encodeURIComponent(id)}`;
}

function canonicalCommunityFileUrl(id) {
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;
}

function parseStoreUrl(url, originalUrl) {
    const segments = decodedPathSegments(url);
    const lower = segments.map(part => part.toLowerCase());
    const offset = lower[0] === 'agecheck' ? 1 : 0;
    const route = lower[offset];
    const id = normalizeNumericId(segments[offset + 1]);
    if (!id) return null;

    if (route === 'app') {
        return {
            kind: 'app',
            id,
            canonicalUrl: canonicalStoreUrl('app', id),
            openUrl: originalUrl,
        };
    }
    if (route === 'sub') {
        return {
            kind: 'package',
            id,
            canonicalUrl: canonicalStoreUrl('package', id),
            openUrl: originalUrl,
        };
    }
    if (route === 'bundle') {
        return {
            kind: 'bundle',
            id,
            canonicalUrl: canonicalStoreUrl('bundle', id),
            openUrl: originalUrl,
        };
    }

    return null;
}

function parseShortSteamUrl(url, originalUrl) {
    const segments = decodedPathSegments(url);
    const route = segments[0]?.toLowerCase();
    const id = normalizeNumericId(segments[1]);
    if (!id) return null;

    if (route === 'a' || route === 'app') {
        return {
            kind: 'app',
            id,
            canonicalUrl: canonicalStoreUrl('app', id),
            openUrl: originalUrl,
        };
    }
    if (route === 'p' || route === 'sub') {
        return {
            kind: 'package',
            id,
            canonicalUrl: canonicalStoreUrl('package', id),
            openUrl: originalUrl,
        };
    }
    return null;
}

function parseCommunityUrl(url, originalUrl) {
    const segments = decodedPathSegments(url);
    const lower = segments.map(part => part.toLowerCase());

    if ((lower[0] === 'sharedfiles' || lower[0] === 'workshop') && lower[1] === 'filedetails') {
        const id = normalizeNumericId(url.searchParams.get('id'));
        if (!id) return null;
        return {
            kind: 'workshop',
            id,
            canonicalUrl: canonicalCommunityFileUrl(id),
            openUrl: originalUrl,
        };
    }

    if (lower[0] === 'market' && lower[1] === 'listings') {
        const appId = normalizeNumericId(segments[2]);
        const itemName = segments.slice(3).join('/');
        if (!appId || !itemName) return null;
        return {
            kind: 'market',
            id: `${appId}/${itemName}`,
            canonicalUrl: `https://steamcommunity.com/market/listings/${encodeURIComponent(appId)}/${encodeURIComponent(itemName)}`,
            openUrl: originalUrl,
        };
    }

    if (lower[0] === 'profiles') {
        const id = normalizeNumericId(segments[1]);
        if (!id) return null;
        return {
            kind: 'profile',
            id,
            canonicalUrl: `https://steamcommunity.com/profiles/${encodeURIComponent(id)}`,
            openUrl: originalUrl,
        };
    }

    if (lower[0] === 'id') {
        const id = normalizeSteamTextId(segments[1]);
        if (!id) return null;
        return {
            kind: 'profile',
            id,
            canonicalUrl: `https://steamcommunity.com/id/${encodeURIComponent(id)}`,
            openUrl: originalUrl,
        };
    }

    if (lower[0] === 'app' && normalizeNumericId(segments[1]) && lower[2] === 'workshop') {
        const id = normalizeNumericId(segments[1]);
        return {
            kind: 'workshopHub',
            id,
            canonicalUrl: `https://steamcommunity.com/app/${encodeURIComponent(id)}/workshop`,
            openUrl: originalUrl,
        };
    }

    return null;
}

function parseSteamUrl(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl || '').trim());
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const originalUrl = stripTracking(url.toString());
    if (hostname === 'store.steampowered.com') return parseStoreUrl(url, originalUrl);
    if (hostname === 's.team') return parseShortSteamUrl(url, originalUrl);
    if (hostname === 'steamcommunity.com') return parseCommunityUrl(url, originalUrl);
    return null;
}

function steamApiLanguage(settings) {
    return toApiLocaleFamily(settings?.defaultLanguage) === 'ja' ? 'japanese' : 'english';
}

function steamApiCountry(settings) {
    return toApiLocaleFamily(settings?.defaultLanguage) === 'ja' ? 'jp' : 'us';
}

async function fetchSteamAppDetails(appId, settings) {
    const apiUrl = new URL('https://store.steampowered.com/api/appdetails');
    apiUrl.searchParams.set('appids', appId);
    apiUrl.searchParams.set('l', steamApiLanguage(settings));
    apiUrl.searchParams.set('cc', steamApiCountry(settings));

    const res = await fetch(apiUrl.toString(), {
        headers: {
            Accept: 'application/json',
            'User-Agent': REQUEST_HEADERS['User-Agent'],
        },
    });
    if (!res.ok) throw new Error(`steam appdetails ${res.status} for ${appId}`);

    const json = await res.json();
    const entry = json?.[appId];
    if (!entry?.success || !entry.data) throw new Error(`steam appdetails missing data for ${appId}`);
    return entry.data;
}

async function fetchSteamCurrentPlayers(appId) {
    const apiUrl = new URL('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/');
    apiUrl.searchParams.set('appid', appId);
    const res = await fetch(apiUrl.toString(), {
        headers: {
            Accept: 'application/json',
            'User-Agent': REQUEST_HEADERS['User-Agent'],
        },
    });
    if (!res.ok) throw new Error(`steam current players ${res.status} for ${appId}`);
    const json = await res.json();
    const count = Number(json?.response?.player_count);
    return Number.isFinite(count) && count >= 0 ? formatNumber(count) : '';
}

async function fetchSteamReviewSummary(appId, settings) {
    const apiUrl = new URL(`https://store.steampowered.com/appreviews/${encodeURIComponent(appId)}`);
    apiUrl.searchParams.set('json', '1');
    apiUrl.searchParams.set('language', steamApiLanguage(settings));
    apiUrl.searchParams.set('purchase_type', 'all');
    apiUrl.searchParams.set('num_per_page', '0');
    const res = await fetch(apiUrl.toString(), {
        headers: {
            Accept: 'application/json',
            'User-Agent': REQUEST_HEADERS['User-Agent'],
        },
    });
    if (!res.ok) throw new Error(`steam appreviews ${res.status} for ${appId}`);
    const json = await res.json();
    const summary = json?.query_summary;
    if ((json?.success !== 1 && json?.success !== true) || !summary) return '';
    return formatReviewSummary(summary);
}

async function optionalSteamValue(factory) {
    try {
        return await factory();
    } catch {
        return '';
    }
}

async function fetchSteamPage(rawUrl) {
    const res = await fetch(rawUrl, { headers: REQUEST_HEADERS, redirect: 'follow' });
    if (!res.ok) throw new Error(`steam page ${res.status} for ${rawUrl}`);
    return {
        html: await res.text(),
        finalUrl: res.url || rawUrl,
    };
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return cleanText(value);
    return n.toLocaleString('en-US');
}

function formatPrice(data, lang) {
    if (data?.is_free === true) return tr(STR.freeToPlay, lang);
    const price = data?.price_overview;
    if (!price || typeof price !== 'object') return '';
    const finalPrice = cleanText(price.final_formatted || '');
    if (!finalPrice) return '';
    const discount = Number(price.discount_percent) || 0;
    return discount > 0 ? `${finalPrice} (${discount}% off)` : finalPrice;
}

function formatDiscount(data) {
    const discount = Number(data?.price_overview?.discount_percent) || 0;
    return discount > 0 ? `${discount}% off` : '';
}

function formatSaleEnds(data) {
    const unix = Number(data?.price_overview?.discount_expiration);
    if (!Number.isFinite(unix) || unix <= 0) return '';
    return `<t:${Math.round(unix)}:R>`;
}

function formatMetacritic(data) {
    const score = Number(data?.metacritic?.score);
    if (!Number.isFinite(score) || score <= 0) return '';
    return data?.metacritic?.url ? `[${score}](${data.metacritic.url})` : String(score);
}

function formatReviewSummary(summary) {
    const label = cleanText(summary?.review_score_desc || '');
    const total = Number(summary?.total_reviews);
    const positive = Number(summary?.total_positive);
    const totalText = Number.isFinite(total) && total > 0 ? formatNumber(total) : '';
    if (label && totalText) return `${label} (${totalText})`;
    if (label) return label;
    if (Number.isFinite(positive) && Number.isFinite(total) && total > 0) {
        return `${Math.round((positive / total) * 100)}% positive (${formatNumber(total)})`;
    }
    return totalText;
}

function formatList(value) {
    if (!Array.isArray(value)) return cleanText(value);
    return value
        .map(item => cleanText(typeof item === 'string' ? item : item?.description || item?.name))
        .filter(Boolean)
        .join(', ');
}

function formatAppType(type) {
    const value = cleanText(type);
    if (!value) return KIND_LABELS.app;
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatPlatforms(platforms) {
    if (!platforms || typeof platforms !== 'object') return '';
    const out = [];
    if (platforms.windows) out.push('Windows');
    if (platforms.mac) out.push('macOS');
    if (platforms.linux) out.push('Linux');
    return out.join(', ');
}

function splitList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function resolveSteamImageSource(settings) {
    const value = String(settings?.steam_image_source || 'header').trim();
    return STEAM_IMAGE_SOURCES.has(value) ? value : 'header';
}

function firstScreenshotImage(screenshots) {
    if (!Array.isArray(screenshots)) return '';
    const item = screenshots.find(screenshot => screenshot?.path_full || screenshot?.path_thumbnail);
    return item?.path_full || item?.path_thumbnail || '';
}

function steamAppImageUrl(data, settings) {
    const header = data?.header_image || data?.capsule_image || data?.library_600x900 || data?.background_raw || '';
    const screenshot = firstScreenshotImage(data?.screenshots);
    const thumbnail = data?.capsule_imagev5 || data?.capsule_image || data?.header_image || data?.library_600x900 || '';
    const source = resolveSteamImageSource(settings);
    if (source === 'screenshot') return screenshot || header || thumbnail || data?.background_raw || '';
    if (source === 'thumbnail') return thumbnail || header || screenshot || data?.background_raw || '';
    return header || screenshot || thumbnail || data?.background_raw || '';
}

function cleanSteamTitle(value) {
    return cleanText(value)
        .replace(/^Steam Community\s*::\s*/i, '')
        .replace(/\s+on Steam$/i, '')
        .replace(/\s*::\s*Steam$/i, '')
        .trim();
}

function normalizeSteamAppDetails(data, parsed, lang, settings, extras = {}) {
    return {
        title: cleanSteamTitle(data?.name) || `${tr(STR.fallbackAppTitle, lang)}${parsed.id}`,
        description: truncate(cleanText(data?.short_description || data?.about_the_game || ''), steamDescriptionMaxLength(settings)),
        imageUrl: steamAppImageUrl(data, settings),
        typeLabel: formatAppType(data?.type),
        price: formatPrice(data, lang),
        discount: formatDiscount(data),
        saleEnds: formatSaleEnds(data),
        releaseDate: cleanText(data?.release_date?.date || ''),
        developers: formatList(data?.developers),
        publishers: formatList(data?.publishers),
        genres: formatList(data?.genres),
        platforms: formatPlatforms(data?.platforms),
        recommendations: data?.recommendations?.total ? formatNumber(data.recommendations.total) : '',
        currentPlayers: extras.currentPlayers || '',
        reviewSummary: extras.reviewSummary || '',
        metacritic: formatMetacritic(data),
    };
}

function extractSteamPageInfo(html, parsed, baseUrl, lang, settings) {
    const title = cleanSteamTitle(
        readMetaContent(html, 'og:title')
        || readMetaContent(html, 'twitter:title')
        || readTitleTag(html)
    );
    const description = truncate(
        cleanText(readMetaContent(html, 'og:description') || readMetaContent(html, 'description')),
        steamDescriptionMaxLength(settings)
    );
    const imageUrl = absoluteUrl(
        readMetaContent(html, 'og:image') || readMetaContent(html, 'twitter:image'),
        baseUrl
    );

    return {
        title: title || fallbackTitleFor(parsed, lang),
        description,
        imageUrl,
        typeLabel: KIND_LABELS[parsed.kind] || 'Steam',
    };
}

function fallbackTitleFor(parsed, lang) {
    if (parsed.kind === 'package') return `${tr(STR.fallbackPackageTitle, lang)}${parsed.id}`;
    if (parsed.kind === 'bundle') return `${tr(STR.fallbackBundleTitle, lang)}${parsed.id}`;
    if (parsed.kind === 'workshop') return `${tr(STR.fallbackWorkshopTitle, lang)}${parsed.id}`;
    if (parsed.kind === 'market') return tr(STR.fallbackMarketTitle, lang);
    if (parsed.kind === 'profile') return tr(STR.fallbackProfileTitle, lang);
    return `${tr(STR.fallbackAppTitle, lang)}${parsed.id}`;
}

function addField(fields, name, value, inline = true) {
    const raw = String(value ?? '').trim();
    const text = /^<t:\d+:[tTdDfFR]>$/.test(raw)
        ? raw
        : truncate(cleanText(raw), FIELD_MAX_LENGTH);
    if (!text) return;
    fields.push({ name, value: text, inline });
}

function addInfoFields(fields, parsed, info, lang, settings) {
    if (shouldShowOutputItem(settings, 'type')) addField(fields, tr(STR.typeField, lang), info.typeLabel || KIND_LABELS[parsed.kind]);
    if (shouldShowOutputItem(settings, 'price')) addField(fields, tr(STR.priceField, lang), info.price);
    if (shouldShowOutputItem(settings, 'discount')) addField(fields, tr(STR.discountField, lang), info.discount);
    if (shouldShowOutputItem(settings, 'sale_ends')) addField(fields, tr(STR.saleEndsField, lang), info.saleEnds);
    if (shouldShowOutputItem(settings, 'release_date')) addField(fields, tr(STR.releaseDateField, lang), info.releaseDate);
    if (shouldShowOutputItem(settings, 'developer')) addField(fields, tr(STR.developerField, lang), info.developers);
    if (shouldShowOutputItem(settings, 'publisher')) addField(fields, tr(STR.publisherField, lang), info.publishers);
    if (shouldShowOutputItem(settings, 'genres')) addField(fields, tr(STR.genresField, lang), info.genres);
    if (shouldShowOutputItem(settings, 'platforms')) addField(fields, tr(STR.platformsField, lang), info.platforms);
    if (shouldShowOutputItem(settings, 'recommendations')) addField(fields, tr(STR.recommendationsField, lang), info.recommendations);
    if (shouldShowOutputItem(settings, 'current_players')) addField(fields, tr(STR.currentPlayersField, lang), info.currentPlayers);
    if (shouldShowOutputItem(settings, 'review_summary')) addField(fields, tr(STR.reviewSummaryField, lang), info.reviewSummary);
    if (shouldShowOutputItem(settings, 'metacritic')) addField(fields, tr(STR.metacriticField, lang), info.metacritic);
    if (shouldShowOutputItem(settings, 'id')) addField(fields, tr(STR.idField, lang), parsed.id);
}

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(word => word && text.includes(word));
}

function requesterName(message, lang, anonymous) {
    if (anonymous) return tr(STR.anonymousRequester, lang);
    return `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
}

function isCommunityKind(kind) {
    return ['workshop', 'market', 'profile', 'workshopHub'].includes(kind);
}

function serviceNameFor(parsed) {
    return isCommunityKind(parsed.kind) ? 'Steam Community' : 'Steam Store';
}

function openButtonLabelFor(parsed, lang) {
    if (isCommunityKind(parsed.kind)) return tr(STR.openCommunityButton, lang);
    if (['app', 'package', 'bundle'].includes(parsed.kind)) return tr(STR.openStoreButton, lang);
    return tr(STR.openButton, lang);
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
                .setLabel(tr(STR.showImageAsAttachmentButton, lang))
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
                .setCustomId('delete:steam'),
        ],
    });
    return rows;
}

function buildEmbed(parsed, info, message, settings, lang) {
    const fields = [];
    addInfoFields(fields, parsed, info, lang, settings);

    const embed = {
        title: info.title || fallbackTitleFor(parsed, lang),
        url: parsed.canonicalUrl,
        description: info.description || undefined,
        color: STEAM_COLOR,
        fields,
        footer: {
            text: `${tr(STR.requesterPrefix, lang)}${requesterName(message, lang, settings?.anonymous_expand === true)} - ${serviceNameFor(parsed)}`,
        },
    };
    applyEmbedMedia(embed, info.imageUrl, settings);
    return embed;
}

function buildSteamAnalytics(parsed, info) {
    const developers = splitList(info.developers);
    const publishers = splitList(info.publishers);
    const genres = splitList(info.genres);
    const platforms = splitList(info.platforms);
    return createProviderAnalytics({
        content: {
            accountKey: developers[0] || publishers[0] || parsed.kind,
            contentId: parsed.id,
            contentType: parsed.kind || 'app',
            contentUrl: parsed.canonicalUrl,
            title: info.title,
            descriptionPreview: info.description,
            authorName: developers[0] || publishers[0],
            mediaCount: info.imageUrl ? 1 : 0,
        },
        metrics: {
            price: finiteNumber(info.price),
            discount_percent: finiteNumber(info.discount),
            recommendations: finiteNumber(info.recommendations),
            current_players: finiteNumber(info.currentPlayers),
            review_count: finiteNumber(info.reviewSummary),
            rating: finiteNumber(info.metacritic),
        },
        facets: [
            facet('type', info.typeLabel || parsed.kind),
            facet('kind', parsed.kind),
            facet('price_label', info.price),
            facet('review_summary', info.reviewSummary),
            facet('release_label', info.releaseDate),
            ...tagFacets('developer', developers),
            ...tagFacets('publisher', publishers),
            ...tagFacets('genre', genres),
            ...tagFacets('platform', platforms),
        ],
    });
}

function buildSteamAnalyticsEnrichers(parsed, settings, info) {
    if (parsed.kind !== 'app') return [];
    const needsCurrentPlayers = !info.currentPlayers;
    const needsReviewSummary = !info.reviewSummary;
    if (!needsCurrentPlayers && !needsReviewSummary) return [];

    const job = async () => {
        const [currentPlayers, reviewSummary] = await Promise.all([
            needsCurrentPlayers ? optionalSteamValue(() => fetchSteamCurrentPlayers(parsed.id)) : info.currentPlayers,
            needsReviewSummary ? optionalSteamValue(() => fetchSteamReviewSummary(parsed.id, settings)) : info.reviewSummary,
        ]);
        return createProviderAnalytics({
            metrics: {
                current_players: finiteNumber(currentPlayers),
                review_count: finiteNumber(reviewSummary),
            },
            facets: [
                facet('review_summary', reviewSummary),
            ],
        });
    };
    job.analyticsMetadata = {
        source: 'steam.analytics.enrichment',
        schemaVersion: 'steam.v1',
        stage: 'enriched',
        timeoutMs: 3000,
    };
    return [job];
}

async function resolveSteamInfo(parsed, settings) {
    const lang = normalizeLanguage(settings);

    if (parsed.kind === 'app') {
        try {
            const appDetails = await fetchSteamAppDetails(parsed.id, settings);
            const [currentPlayers, reviewSummary] = await Promise.all([
                shouldShowOutputItem(settings, 'current_players')
                    ? optionalSteamValue(() => fetchSteamCurrentPlayers(parsed.id))
                    : '',
                shouldShowOutputItem(settings, 'review_summary')
                    ? optionalSteamValue(() => fetchSteamReviewSummary(parsed.id, settings))
                    : '',
            ]);
            return {
                parsed,
                info: normalizeSteamAppDetails(appDetails, parsed, lang, settings, { currentPlayers, reviewSummary }),
            };
        } catch (err) {
            void err;
        }
    }

    const page = await fetchSteamPage(parsed.openUrl || parsed.canonicalUrl);
    const resolved = parseSteamUrl(page.finalUrl);
    const effectiveParsed = resolved?.id
        ? { ...resolved, openUrl: parsed.openUrl || parsed.canonicalUrl }
        : parsed;

    return {
        parsed: effectiveParsed,
        info: extractSteamPageInfo(page.html, effectiveParsed, page.finalUrl, lang, settings),
    };
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const initialParsed = parseSteamUrl(url);
    if (!initialParsed) return null;

    const lang = normalizeLanguage(s);
    let parsed;
    let info;
    try {
        const resolved = await resolveSteamInfo(initialParsed, s);
        parsed = resolved.parsed;
        info = resolved.info;
    } catch (err) {
        recordProviderError('steam', err, message, url, { endpointKey: 'steam/api-or-page' });
        return buildFailureResponse('steam', url, s, err);
    }

    const bannedTarget = [
        info.title,
        info.description,
        info.developers,
        info.publishers,
        info.genres,
    ].filter(Boolean).join('\n');
    if (containsBannedWord(bannedTarget, s.bannedWords)) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [buildEmbed(parsed, info, message, s, lang)],
        components: buildComponents(lang, parsed, !!info.imageUrl, s),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
        analytics: buildSteamAnalytics(parsed, info),
        analyticsEnrichers: buildSteamAnalyticsEnrichers(parsed, s, info),
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
const steamProvider = {
    id: 'steam',
    enabledByDefault: false,
    urlPattern: STEAM_URL_PATTERN,
    settings: [
        'bannedWords',
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'display_density',
        'media_display_mode',
        'steam_description_max_length',
        'steam_image_source',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'discount', label: { en: 'Discount field', ja: 'Discount field' } },
                { value: 'sale_ends', label: { en: 'Sale ends field', ja: 'Sale ends field' } },
                { value: 'metacritic', label: { en: 'Metacritic field', ja: 'Metacritic field' } },
                { value: 'type', label: { en: 'Type field', ja: 'Type field' } },
                { value: 'release_date', label: { en: 'Release date field', ja: 'Release date field' } },
                { value: 'developer', label: { en: 'Developer field', ja: 'Developer field' } },
                { value: 'publisher', label: { en: 'Publisher field', ja: 'Publisher field' } },
                { value: 'genres', label: { en: 'Genres field', ja: 'Genres field' } },
                { value: 'price', label: { en: 'Price field', ja: '価格欄' } },
                { value: 'platforms', label: { en: 'Platform field', ja: '対応OS欄' } },
                { value: 'recommendations', label: { en: 'Recommendations field', ja: 'レビュー/おすすめ数欄' } },
                { value: 'current_players', label: { en: 'Current players field', ja: 'Current players field' } },
                { value: 'review_summary', label: { en: 'Review summary field', ja: 'Review summary field' } },
                { value: 'id', label: { en: 'ID field', ja: 'ID欄' } },
            ],
        },
    ],
    extract,
};

module.exports = steamProvider;
module.exports._internal = {
    cleanSteamTitle,
    extractSteamPageInfo,
    normalizeSteamAppDetails,
    parseSteamUrl,
    stripTracking,
};
