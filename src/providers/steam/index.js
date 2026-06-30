'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');

const STEAM_COLOR = 0x171a21;
const DESCRIPTION_MAX_LENGTH = 900;
const FIELD_MAX_LENGTH = 1024;
const STEAM_URL_PATTERN =
    /https?:\/\/(?:(?:store)\.steampowered\.com|(?:www\.)?steamcommunity\.com|s\.team)\/[^\s<>|]+/gi;

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
    releaseDateField: { ja: 'Release date', en: 'Release date' },
    developerField: { ja: 'Developer', en: 'Developer' },
    publisherField: { ja: 'Publisher', en: 'Publisher' },
    genresField: { ja: 'Genres', en: 'Genres' },
    platformsField: { ja: 'Platforms', en: 'Platforms' },
    recommendationsField: { ja: 'Recommendations', en: 'Recommendations' },
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
    return settings?.defaultLanguage === 'ja' ? 'japanese' : 'english';
}

function steamApiCountry(settings) {
    return settings?.defaultLanguage === 'ja' ? 'jp' : 'us';
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

function cleanSteamTitle(value) {
    return cleanText(value)
        .replace(/^Steam Community\s*::\s*/i, '')
        .replace(/\s+on Steam$/i, '')
        .replace(/\s*::\s*Steam$/i, '')
        .trim();
}

function normalizeSteamAppDetails(data, parsed, lang) {
    return {
        title: cleanSteamTitle(data?.name) || `${tr(STR.fallbackAppTitle, lang)}${parsed.id}`,
        description: truncate(cleanText(data?.short_description || data?.about_the_game || ''), DESCRIPTION_MAX_LENGTH),
        imageUrl: data?.header_image || data?.capsule_image || data?.library_600x900 || data?.background_raw || '',
        typeLabel: formatAppType(data?.type),
        price: formatPrice(data, lang),
        releaseDate: cleanText(data?.release_date?.date || ''),
        developers: formatList(data?.developers),
        publishers: formatList(data?.publishers),
        genres: formatList(data?.genres),
        platforms: formatPlatforms(data?.platforms),
        recommendations: data?.recommendations?.total ? formatNumber(data.recommendations.total) : '',
    };
}

function extractSteamPageInfo(html, parsed, baseUrl, lang) {
    const title = cleanSteamTitle(
        readMetaContent(html, 'og:title')
        || readMetaContent(html, 'twitter:title')
        || readTitleTag(html)
    );
    const description = truncate(
        cleanText(readMetaContent(html, 'og:description') || readMetaContent(html, 'description')),
        DESCRIPTION_MAX_LENGTH
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
    const text = truncate(cleanText(value), FIELD_MAX_LENGTH);
    if (!text) return;
    fields.push({ name, value: text, inline });
}

function addInfoFields(fields, parsed, info, lang) {
    addField(fields, tr(STR.typeField, lang), info.typeLabel || KIND_LABELS[parsed.kind]);
    addField(fields, tr(STR.priceField, lang), info.price);
    addField(fields, tr(STR.releaseDateField, lang), info.releaseDate);
    addField(fields, tr(STR.developerField, lang), info.developers);
    addField(fields, tr(STR.publisherField, lang), info.publishers);
    addField(fields, tr(STR.genresField, lang), info.genres);
    addField(fields, tr(STR.platformsField, lang), info.platforms);
    addField(fields, tr(STR.recommendationsField, lang), info.recommendations);
    addField(fields, tr(STR.idField, lang), parsed.id);
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
    addInfoFields(fields, parsed, info, lang);

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
    if (info.imageUrl) embed.image = { url: info.imageUrl };
    return embed;
}

async function resolveSteamInfo(parsed, settings) {
    const lang = normalizeLanguage(settings);

    if (parsed.kind === 'app') {
        try {
            return {
                parsed,
                info: normalizeSteamAppDetails(await fetchSteamAppDetails(parsed.id, settings), parsed, lang),
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
        info: extractSteamPageInfo(page.html, effectiveParsed, page.finalUrl, lang),
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
        return null;
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
        components: buildComponents(lang, parsed, !!info.imageUrl),
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
const steamProvider = {
    id: 'steam',
    enabledByDefault: false,
    urlPattern: STEAM_URL_PATTERN,
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
