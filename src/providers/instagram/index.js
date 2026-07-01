'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { videoExtensions } = require('../../utils');
const { recordProviderError } = require('../../errorTracking');
const {
    applyMediaDisplayToStep,
    buildFailureResponse,
    resolveDensityMaxLength,
    resolveDisplayDensity,
    shouldShowOutputItem,
} = require('../_output_controls');
const { toApiLocaleFamily } = require('../../discordLocales');

const INSTAGRAM_URL_PATTERN =
    /https?:\/\/(?:www\.)?instagram\.com\/(?:(?:[A-Za-z0-9_.-]+\/)?(?:(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+(?:\/\d+)?|share(?:\/reel)?\/[A-Za-z0-9_-]+)|(?!(?:p|reel|reels|tv|share|stories|explore|accounts|about|api|graphql|oauth|developer|directory|emails|challenge|web|static|privacy|terms|legal)(?:\/|$))[A-Za-z0-9._]{1,30})\/?(?:\?[^\s<>|]*)?/g;
const INSTAGRAM_CLEAN_PATTERN = new RegExp(`<${INSTAGRAM_URL_PATTERN.source}>|\\|\\|${INSTAGRAM_URL_PATTERN.source}\\|\\|`, INSTAGRAM_URL_PATTERN.flags);

const MEDIA_ROUTES = new Set(['p', 'reel', 'reels', 'tv']);
const RESERVED_PROFILE_ROUTES = new Set([
    'p', 'reel', 'reels', 'tv', 'share', 'stories', 'explore', 'accounts',
    'about', 'api', 'graphql', 'oauth', 'developer', 'directory', 'emails',
    'challenge', 'web', 'static', 'privacy', 'terms', 'legal',
]);
const EMBED_COLOR = 0xE4405F;
const MAX_MEDIA_PER_MESSAGE = 10;
const DESCRIPTION_MAX_LENGTH = 3500;
const CAPTION_MAX_LENGTH = 3000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const PROFILE_API_RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

const REQUEST_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};
const MOBILE_USER_AGENT = 'Instagram 337.0.0.35.102 Android (30/11; 420dpi; 1080x1920; Google; Pixel 5; redfin; redfin; en_US; 540986477)';
const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

const GRAPHQL_DOC_ID = '25531498899829322';
const GRAPHQL_HEADERS = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://www.instagram.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': REQUEST_HEADERS['User-Agent'],
    'X-Asbd-Id': '129477',
    'X-Fb-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
    'X-Ig-App-Id': '936619743392459',
};

const STR = {
    requesterPrefix:              { ja: '\u5c55\u958b\u8005: ', en: 'Requested by ' },
    anonRequester:                { ja: '\u533f\u540d\u30e6\u30fc\u30b6\u30fc', en: 'Anonymous requester' },
    viewLink:                     { ja: 'Instagram \u3067\u898b\u308b', en: 'View on Instagram' },
    mediaField:                   { ja: '\u30e1\u30c7\u30a3\u30a2', en: 'Media' },
    showMediaAsAttachmentsButton: { ja: '\u30e1\u30c7\u30a3\u30a2\u3092\u6dfb\u4ed8\u30d5\u30a1\u30a4\u30eb\u3068\u3057\u3066\u8868\u793a\u3059\u308b', en: 'Show media as attachments' },
    showAttachmentsAsEmbedButton: { ja: '\u753b\u50cf\u3092\u57cb\u3081\u8fbc\u307f\u753b\u50cf\u3068\u3057\u3066\u8868\u793a\u3059\u308b', en: 'Show media in embeds image' },
    translateButton:              { ja: '\u7ffb\u8a33', en: 'Translate' },
    deleteButton:                 { ja: '\u524a\u9664', en: 'Delete' },
    postsField:                   { ja: '\u6295\u7a3f', en: 'Posts' },
    followersField:               { ja: '\u30d5\u30a9\u30ed\u30ef\u30fc', en: 'Followers' },
    followingField:               { ja: '\u30d5\u30a9\u30ed\u30fc\u4e2d', en: 'Following' },
    websiteLink:                  { ja: '\u30a6\u30a7\u30d6\u30b5\u30a4\u30c8', en: 'Website' },
    likesField:                   { ja: 'Likes', en: 'Likes' },
    commentsField:                { ja: 'Comments', en: 'Comments' },
    locationField:                { ja: 'Location', en: 'Location' },
    hashtagsField:                { ja: 'Hashtags', en: 'Hashtags' },
    mentionsField:                { ja: 'Mentions', en: 'Mentions' },
    durationField:                { ja: 'Duration', en: 'Duration' },
    audioField:                   { ja: 'Audio', en: 'Audio' },
    profileStatusField:           { ja: 'Status', en: 'Status' },
    verifiedStatus:               { ja: 'Verified', en: 'Verified' },
    privateStatus:                { ja: 'Private', en: 'Private' },
};

const dataCache = new Map();
let profileApiBackoffUntil = 0;

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

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

async function resolveShareUrl(parsed) {
    const candidates = [];
    if (parsed.shareRoute === 'reel') {
        candidates.push(`https://www.instagram.com/share/reel/${parsed.shareCode}/`);
    }
    candidates.push(
        `https://www.instagram.com/share/reel/${parsed.shareCode}/`,
        `https://www.instagram.com/share/${parsed.shareCode}/`
    );

    for (const candidate of [...new Set(candidates)]) {
        try {
            const res = await fetch(candidate, {
                method: 'HEAD',
                redirect: 'manual',
                headers: REQUEST_HEADERS,
            });
            const location = res.headers?.get?.('location');
            const target = location ? new URL(location, candidate).toString() : res.url;
            const resolved = parseInstagramUrl(target);
            if (resolved && resolved.kind === 'media') {
                resolved.mediaIndex = parsed.mediaIndex;
                return resolved;
            }
        } catch {
            // Try the next share URL shape.
        }
    }

    return null;
}

async function resolveParsedUrl(parsed) {
    if (!parsed) return null;
    if (parsed.kind !== 'share') return parsed;
    return await resolveShareUrl(parsed);
}

function truncate(value, max) {
    if (!value) return '';
    if (max <= 0) return '';
    return value.length <= max ? value : value.slice(0, max - 3) + '...';
}

function decodeHtmlEntities(value) {
    if (!value) return '';
    return value
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function stripHtml(html) {
    if (!html) return '';
    return decodeHtmlEntities(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function extractAttr(tag, attrName) {
    const re = new RegExp(`${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = tag.match(re);
    return match ? decodeHtmlEntities(match[2] || match[3] || match[4] || '') : '';
}

function findTagWithClass(html, className) {
    const tagRe = /<[a-zA-Z][^>]*>/g;
    let match;
    while ((match = tagRe.exec(html)) !== null) {
        if (match[0].includes(className)) return match[0];
    }
    return '';
}

function extractElementHtmlByClass(html, className) {
    const classIndex = html.indexOf(className);
    if (classIndex === -1) return '';
    const start = html.lastIndexOf('<', classIndex);
    if (start === -1) return '';
    const openEnd = html.indexOf('>', start);
    if (openEnd === -1) return '';
    const openTag = html.slice(start, openEnd + 1);
    const tagName = openTag.match(/^<([a-zA-Z0-9:-]+)/)?.[1];
    if (!tagName || /\/>$/.test(openTag)) return openTag;

    const tagRe = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = openEnd + 1;
    let depth = 1;
    let match;
    while ((match = tagRe.exec(html)) !== null) {
        const tag = match[0];
        if (tag.startsWith(`</`)) {
            depth--;
            if (depth === 0) return html.slice(openEnd + 1, match.index);
        } else if (!/\/>$/.test(tag)) {
            depth++;
        }
    }
    return '';
}

function getMetaContent(html, property) {
    const metaRe = /<meta\b[^>]*>/gi;
    let match;
    while ((match = metaRe.exec(html)) !== null) {
        const tag = match[0];
        const prop = extractAttr(tag, 'property') || extractAttr(tag, 'name');
        if (prop === property) return extractAttr(tag, 'content');
    }
    return '';
}

function scrapeFromEmbedHtml(html) {
    const imageTag = findTagWithClass(html, 'EmbeddedMediaImage');
    const videoTag = findTagWithClass(html, 'EmbeddedMediaVideo');
    const mediaTag = imageTag || videoTag;
    let mediaUrl = extractAttr(mediaTag, 'src');
    let typeName = videoTag ? 'GraphVideo' : 'GraphImage';

    if (!mediaUrl) {
        mediaUrl = getMetaContent(html, 'og:video') || getMetaContent(html, 'og:image');
        typeName = getMetaContent(html, 'og:video') ? 'GraphVideo' : 'GraphImage';
    }
    if (!mediaUrl) return null;

    const username =
        stripHtml(extractElementHtmlByClass(html, 'UsernameText'))
        || stripHtml(getMetaContent(html, 'og:title')).replace(/^@/, '').split(' ')[0];
    let caption = stripHtml(extractElementHtmlByClass(html, 'Caption'))
        || stripHtml(getMetaContent(html, 'og:description'));
    if (username && caption.startsWith(username)) caption = caption.slice(username.length).trim();

    return {
        username,
        caption,
        medias: [{ typeName, url: normalizeCdnUrl(mediaUrl) }],
    };
}

function isEscaped(text, index) {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashCount++;
    return slashCount % 2 === 1;
}

function findJsonEnd(text, start) {
    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === quote) {
                inString = false;
            }
            continue;
        }

        if (ch === '"' || ch === "'") {
            inString = true;
            quote = ch;
        } else if (ch === '{' || ch === '[') {
            depth++;
        } else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0) return i;
        }
    }

    return -1;
}

function tryParseJson(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function readJsString(text, quoteIndex) {
    const quote = text[quoteIndex];
    if (quote !== '"' && quote !== "'") return null;
    let escaped = false;
    for (let i = quoteIndex + 1; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
        } else if (ch === '\\') {
            escaped = true;
        } else if (ch === quote) {
            const literal = text.slice(quoteIndex, i + 1);
            if (quote === '"') {
                return tryParseJson(literal);
            }
            return literal.slice(1, -1)
                .replace(/\\'/g, "'")
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\n/g, '\n')
                .replace(/\\u([0-9a-f]{4})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
        }
    }
    return null;
}

function collectJsonCandidates(html) {
    const candidates = [];
    const tokens = ['shortcode_media', 'xdt_shortcode_media'];
    const seen = new Set();

    for (const token of tokens) {
        let index = html.indexOf(token);
        while (index !== -1) {
            const windowStart = Math.max(0, index - 50000);
            const starts = [];
            for (let i = index; i >= windowStart && starts.length < 120; i--) {
                if (html[i] === '{') starts.push(i);
            }
            for (const start of starts) {
                const end = findJsonEnd(html, start);
                if (end === -1 || end < index) continue;
                const raw = html.slice(start, end + 1);
                if (seen.has(raw)) continue;
                seen.add(raw);
                const parsed = tryParseJson(raw);
                if (parsed) candidates.push(parsed);
            }

            for (let i = index; i >= windowStart; i--) {
                if ((html[i] === '"' || html[i] === "'") && !isEscaped(html, i)) {
                    const unescaped = readJsString(html, i);
                    if (typeof unescaped === 'string' && unescaped.includes(token)) {
                        const parsed = tryParseJson(unescaped);
                        if (parsed) candidates.push(parsed);
                    }
                    break;
                }
            }

            index = html.indexOf(token, index + token.length);
        }
    }

    return candidates;
}

function getPath(obj, path) {
    let cur = obj;
    for (const part of path.split('.')) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
}

function firstString(obj, paths) {
    for (const path of paths) {
        const value = getPath(obj, path);
        if (typeof value === 'string' && value) return value;
    }
    return '';
}

function firstNumber(obj, paths) {
    for (const path of paths) {
        const value = getPath(obj, path);
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function firstStringFromNodes(nodes, paths) {
    for (const node of nodes) {
        const value = firstString(node, paths);
        if (value) return value;
    }
    return '';
}

function firstNumberFromNodes(nodes, paths) {
    for (const node of nodes) {
        const value = firstNumber(node, paths);
        if (value !== null) return value;
    }
    return null;
}

function findMediaNode(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 10) return null;
    if (obj.shortcode_media) return obj.shortcode_media;
    if (obj.xdt_shortcode_media) return obj.xdt_shortcode_media;
    if (obj.gql_data) {
        const node = findMediaNode(obj.gql_data, depth + 1);
        if (node) return node;
    }
    if (obj.data) {
        const node = findMediaNode(obj.data, depth + 1);
        if (node) return node;
    }
    if ((obj.__typename || obj.owner) && (obj.display_url || obj.video_url || obj.edge_sidecar_to_children || obj.carousel_media)) {
        return obj;
    }

    for (const value of Object.values(obj)) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
            for (const item of value.slice(0, 20)) {
                const node = findMediaNode(item, depth + 1);
                if (node) return node;
            }
        } else {
            const node = findMediaNode(value, depth + 1);
            if (node) return node;
        }
    }
    return null;
}

function normalizeCdnUrl(rawUrl) {
    if (!rawUrl) return '';
    const decoded = decodeHtmlEntities(rawUrl);
    try {
        const u = new URL(decoded);
        if (u.hostname.includes('cdninstagram.com') || u.hostname.includes('fbcdn.net')) {
            u.hostname = 'scontent.cdninstagram.com';
        }
        return u.toString();
    } catch {
        return decoded;
    }
}

function mediaUrlFromNode(node) {
    const direct = firstString(node, [
        'video_url',
        'display_url',
        'thumbnail_src',
        'image_versions2.candidates.0.url',
        'video_versions.0.url',
    ]);
    if (direct) return normalizeCdnUrl(direct);

    const candidates = getPath(node, 'image_versions2.candidates');
    if (Array.isArray(candidates) && candidates[0]?.url) return normalizeCdnUrl(candidates[0].url);
    const videos = getPath(node, 'video_versions');
    if (Array.isArray(videos) && videos[0]?.url) return normalizeCdnUrl(videos[0].url);
    return '';
}

function sidecarNodes(node) {
    const edges = getPath(node, 'edge_sidecar_to_children.edges');
    if (Array.isArray(edges) && edges.length > 0) {
        return edges.map(edge => edge.node || edge).filter(Boolean);
    }
    const carousel = node.carousel_media;
    if (Array.isArray(carousel) && carousel.length > 0) return carousel;
    return [node];
}

function normalizeMediaNode(node) {
    if (!node || typeof node !== 'object') return null;

    const mediaNodes = sidecarNodes(node);
    const inspectNodes = [node, ...mediaNodes.filter(media => media !== node)];
    const medias = mediaNodes
        .map(media => ({
            typeName: media.__typename || (media.video_url || media.video_versions ? 'GraphVideo' : 'GraphImage'),
            url: mediaUrlFromNode(media),
        }))
        .filter(media => media.url);

    if (medias.length === 0) return null;

    const timestamp = Number(node.taken_at_timestamp || node.taken_at || 0);
    return {
        username: firstString(node, ['owner.username', 'user.username', 'owner.full_name']),
        caption: firstString(node, [
            'edge_media_to_caption.edges.0.node.text',
            'caption.text',
            'accessibility_caption',
        ]),
        likeCount: countFromPath(node, 'edge_media_preview_like'),
        commentCount: countFromPath(node, 'edge_media_to_comment'),
        locationName: firstString(node, ['location.name', 'location.city_name', 'location.short_name']),
        videoDuration: firstNumberFromNodes(inspectNodes, [
            'video_duration',
            'videoDuration',
            'clips_metadata.video_duration',
            'clips_metadata.videoDuration',
        ]),
        audioTitle: firstStringFromNodes(inspectNodes, [
            'clips_music_attribution_info.song_name',
            'clips_music_attribution_info.original_sound_name',
            'clips_music_attribution_info.audio_title',
            'clips_music_attribution_info.title',
            'music_metadata.song_name',
            'music_metadata.audio_title',
            'music_metadata.music_info.music_asset_info.title',
            'audio.title',
            'audio.name',
        ]),
        audioArtist: firstStringFromNodes(inspectNodes, [
            'clips_music_attribution_info.artist_name',
            'clips_music_attribution_info.author_username',
            'music_metadata.artist_name',
            'music_metadata.music_info.music_asset_info.display_artist',
            'audio.artist_name',
            'audio.artist',
        ]),
        timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : undefined,
        medias,
    };
}

function parseInstagramHtml(html) {
    for (const candidate of collectJsonCandidates(html)) {
        const node = findMediaNode(candidate);
        const normalized = normalizeMediaNode(node);
        if (normalized) return normalized;
    }

    return scrapeFromEmbedHtml(html);
}

function usernameFromAuthorUrl(authorUrl) {
    if (!authorUrl) return '';
    try {
        const u = new URL(authorUrl);
        return u.pathname.split('/').filter(Boolean)[0] || '';
    } catch {
        return '';
    }
}

function normalizeOEmbedData(oembed) {
    if (!oembed || typeof oembed !== 'object') return null;

    const thumbnailUrl = normalizeCdnUrl(oembed.thumbnail_url || '');
    if (!thumbnailUrl) return null;

    const username = usernameFromAuthorUrl(oembed.author_url) || oembed.author_name || '';
    return {
        username,
        caption: oembed.title || '',
        medias: [{
            typeName: 'GraphImage',
            url: thumbnailUrl,
        }],
    };
}

async function fetchOEmbedData(parsed) {
    const params = new URLSearchParams({ url: buildCanonicalUrl(parsed) });
    const apiUrl = `https://www.instagram.com/api/v1/oembed/?${params.toString()}`;
    const res = await fetch(apiUrl, {
        headers: {
            ...REQUEST_HEADERS,
            Accept: 'application/json,text/plain,*/*',
        },
    });
    if (!res.ok) return null;
    const data = tryParseJson(await res.text());
    return normalizeOEmbedData(data);
}

function normalizeCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function countFromPath(obj, path) {
    const value = getPath(obj, path);
    if (value && typeof value === 'object' && 'count' in value) return normalizeCount(value.count);
    return normalizeCount(value);
}

function normalizeProfileData(data) {
    const user = data?.data?.user;
    if (!user || typeof user !== 'object' || !user.username) return null;

    return {
        username: user.username,
        fullName: user.full_name || '',
        biography: user.biography || user.biography_with_entities?.raw_text || '',
        profilePicUrl: normalizeCdnUrl(user.profile_pic_url_hd || user.profile_pic_url || ''),
        externalUrl: user.external_url || '',
        isPrivate: user.is_private === true,
        isVerified: user.is_verified === true,
        posts: countFromPath(user, 'edge_owner_to_timeline_media'),
        followers: countFromPath(user, 'edge_followed_by'),
        following: countFromPath(user, 'edge_follow'),
    };
}

function profileCountFromText(value) {
    if (!value) return null;
    const text = String(value).trim();
    return text || null;
}

function parseProfileCounts(description) {
    const match = String(description || '').match(/([\d.,]+[KMB]?)\s+Followers,\s*([\d.,]+[KMB]?)\s+Following,\s*([\d.,]+[KMB]?)\s+Posts/i);
    if (!match) return {};
    return {
        followers: profileCountFromText(match[1]),
        following: profileCountFromText(match[2]),
        posts: profileCountFromText(match[3]),
    };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeProfileTitle(title, fallbackUsername) {
    const clean = stripHtml(title)
        .replace(/\s+\u2022\s+Instagram.*$/i, '')
        .trim();
    if (!clean) return { username: fallbackUsername, fullName: '' };

    const usernameMatch = clean.match(/\(@([A-Za-z0-9._]{1,30})\)\s*$/);
    const username = usernameMatch?.[1] || fallbackUsername;
    const fullName = usernameMatch
        ? clean.slice(0, usernameMatch.index).trim()
        : clean.replace(new RegExp(`^@?${escapeRegExp(fallbackUsername)}$`, 'i'), '').trim();
    return { username, fullName };
}

function normalizeProfileHtmlData(username, html) {
    const ogTitle = getMetaContent(html, 'og:title');
    const ogDescription = getMetaContent(html, 'og:description');
    const seoDescription = getMetaContent(html, 'description');
    const profilePicUrl = normalizeCdnUrl(getMetaContent(html, 'og:image'));
    const titleData = normalizeProfileTitle(ogTitle, username);
    const counts = parseProfileCounts(seoDescription || ogDescription);
    const bioMatch = String(seoDescription || '').match(/\bon Instagram:\s*"([\s\S]*)"\s*$/i);
    const biography = bioMatch ? bioMatch[1].trim() : '';

    if (!titleData.username || (!titleData.fullName && !profilePicUrl && !ogDescription && !seoDescription)) return null;

    return {
        username: titleData.username,
        fullName: titleData.fullName,
        biography,
        profilePicUrl,
        externalUrl: '',
        isPrivate: false,
        isVerified: false,
        posts: counts.posts ?? null,
        followers: counts.followers ?? null,
        following: counts.following ?? null,
    };
}

function profileApiCandidates(username) {
    const params = new URLSearchParams({ username });
    const query = params.toString();
    const referer = `https://www.instagram.com/${username}/`;
    const jsonHeaders = {
        ...REQUEST_HEADERS,
        Accept: 'application/json,text/plain,*/*',
        Referer: referer,
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
    };
    const mobileHeaders = {
        ...jsonHeaders,
        'User-Agent': MOBILE_USER_AGENT,
    };

    return [
        { url: `https://www.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: jsonHeaders },
        { url: `https://i.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: jsonHeaders },
        { url: `https://www.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: mobileHeaders },
        { url: `https://i.instagram.com/api/v1/users/web_profile_info/?${query}`, headers: mobileHeaders },
    ];
}

async function fetchProfileCandidate(candidate) {
    const res = await fetch(candidate.url, { headers: candidate.headers });
    const text = await res.text();
    if (!res.ok) {
        /** @type {Error & {status?: number}} */
        const err = new Error(`instagram profile ${res.status}`);
        err.status = res.status;
        throw err;
    }

    const parsed = tryParseJson(text);
    if (!parsed) {
        /** @type {Error & {status?: number}} */
        const err = new Error(`instagram profile non-json ${res.status}`);
        err.status = res.status;
        throw err;
    }

    const profile = normalizeProfileData(parsed);
    if (!profile) {
        /** @type {Error & {status?: number}} */
        const err = new Error(`instagram profile missing user ${res.status}`);
        err.status = res.status;
        throw err;
    }

    return profile;
}

async function fetchProfileFromApi(username) {
    let lastError = null;
    for (const candidate of profileApiCandidates(username)) {
        try {
            return await fetchProfileCandidate(candidate);
        } catch (err) {
            lastError = err;
            if (err?.status === 429) {
                profileApiBackoffUntil = Date.now() + PROFILE_API_RATE_LIMIT_BACKOFF_MS;
                throw err;
            }
        }
    }
    throw lastError || new Error('instagram profile data not found');
}

async function fetchProfileFromHtml(username) {
    const res = await fetch(`https://www.instagram.com/${username}/`, {
        headers: {
            ...REQUEST_HEADERS,
            Accept: 'text/html,*/*',
            'User-Agent': CRAWLER_USER_AGENT,
        },
    });
    const text = await res.text();
    if (!res.ok) {
        /** @type {Error & {status?: number}} */
        const err = new Error(`instagram profile html ${res.status}`);
        err.status = res.status;
        throw err;
    }

    const profile = normalizeProfileHtmlData(username, text);
    if (!profile) {
        /** @type {Error & {status?: number}} */
        const err = new Error(`instagram profile html missing user ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return profile;
}

async function fetchProfileData(username) {
    const cacheKey = `profile:${username.toLowerCase()}`;
    const cached = dataCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    if (cached) dataCache.delete(cacheKey);

    let lastError = null;
    try {
        const profile = await fetchProfileFromHtml(username);
        dataCache.set(cacheKey, { data: profile, expiresAt: Date.now() + CACHE_TTL_MS });
        return profile;
    } catch (err) {
        lastError = err;
    }

    if (Date.now() >= profileApiBackoffUntil) {
        try {
            const profile = await fetchProfileFromApi(username);
            dataCache.set(cacheKey, { data: profile, expiresAt: Date.now() + CACHE_TTL_MS });
            return profile;
        } catch (err) {
            if (err?.status === 429) {
                /** @type {Error & {status?: number}} */
                const combined = new Error(`instagram profile api rate limited after HTML fallback failed: ${lastError?.message || lastError}`);
                combined.status = err.status;
                throw combined;
            }
            throw err;
        }
    }

    throw lastError || new Error('instagram profile data not found');
}

function buildGraphqlBody(shortcode) {
    return new URLSearchParams({
        av: '0',
        __d: 'www',
        __user: '0',
        __a: '1',
        __req: 'k',
        __comet_req: '7',
        lsd: 'AVoPBTXMX0Y',
        jazoest: '2882',
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
        variables: JSON.stringify({
            shortcode,
            fetch_comment_count: 40,
            parent_comment_count: 24,
            child_comment_count: 3,
            fetch_like_count: 10,
            fetch_tagged_user_count: null,
            fetch_preview_comment_count: 2,
            has_threaded_comments: true,
            hoisted_comment_id: null,
            hoisted_reply_id: null,
        }),
        server_timestamps: 'true',
        doc_id: GRAPHQL_DOC_ID,
    });
}

async function fetchGraphqlData(shortcode) {
    const res = await fetch('https://www.instagram.com/graphql/query/', {
        method: 'POST',
        headers: GRAPHQL_HEADERS,
        body: buildGraphqlBody(shortcode).toString(),
    });
    if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 429) return null;
        /** @type {Error & {status?: number}} */
        const err = new Error(`instagram graphql ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const text = await res.text();
    if (text.includes('require_login')) return null;
    const parsed = tryParseJson(text);
    const node = findMediaNode(parsed);
    return normalizeMediaNode(node);
}

function embedUrlCandidates(parsed) {
    const routes = [parsed.route, 'p', 'reel', 'tv'].filter(Boolean);
    return [...new Set(routes.map(route => `https://www.instagram.com/${route}/${parsed.shortcode}/embed/captioned/`))];
}

async function fetchInstagramData(parsed) {
    const cached = dataCache.get(parsed.shortcode);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    if (cached) dataCache.delete(parsed.shortcode);

    let lastError = null;
    for (const embedUrl of embedUrlCandidates(parsed)) {
        try {
            const res = await fetch(embedUrl, { headers: REQUEST_HEADERS });
            if (!res.ok) {
                lastError = new Error(`instagram embed ${res.status}`);
                continue;
            }
            const html = await res.text();
            const data = parseInstagramHtml(html);
            if (data) {
                dataCache.set(parsed.shortcode, { data, expiresAt: Date.now() + CACHE_TTL_MS });
                return data;
            }
        } catch (err) {
            lastError = err;
        }
    }

    const oembedData = await fetchOEmbedData(parsed).catch(err => {
        lastError = err;
        return null;
    });
    if (oembedData) {
        dataCache.set(parsed.shortcode, { data: oembedData, expiresAt: Date.now() + CACHE_TTL_MS });
        return oembedData;
    }

    const graphqlData = await fetchGraphqlData(parsed.shortcode).catch(err => {
        lastError = err;
        return null;
    });
    if (graphqlData) {
        dataCache.set(parsed.shortcode, { data: graphqlData, expiresAt: Date.now() + CACHE_TTL_MS });
        return graphqlData;
    }

    throw lastError || new Error('instagram data not found');
}

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(word => word && text.includes(word));
}

function isVideoMedia(media) {
    if (!media) return false;
    if (String(media.typeName || '').includes('Video')) return true;
    const cleanUrl = String(media.url || '').split(/[?#]/)[0];
    const ext = cleanUrl.split('.').pop()?.toLowerCase();
    return videoExtensions.includes(ext);
}

function resolveCaptionMaxLength(value, settings = {}) {
    if (value === undefined || value === null || value === '') {
        return resolveDensityMaxLength(settings, 'instagram_caption_max_length', CAPTION_MAX_LENGTH, {
            compact: 200,
            detail: CAPTION_MAX_LENGTH,
            hardMax: CAPTION_MAX_LENGTH,
        });
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return CAPTION_MAX_LENGTH;
    return Math.max(0, Math.min(CAPTION_MAX_LENGTH, Math.round(n)));
}

function resolveMediaLimit(value, settings = {}) {
    const n = Number(value);
    if (n === 1 || n === 4) return n;
    if (resolveDisplayDensity(settings) === 'compact') return 1;
    return MAX_MEDIA_PER_MESSAGE;
}

function selectMedias(medias, mediaIndex, limit = MAX_MEDIA_PER_MESSAGE) {
    if (!Array.isArray(medias) || medias.length === 0) return [];
    if (mediaIndex && mediaIndex > 0) {
        const index = Math.min(mediaIndex, medias.length) - 1;
        return [medias[index]];
    }
    return medias.slice(0, Math.max(1, Math.min(MAX_MEDIA_PER_MESSAGE, limit)));
}

function displayRange(total, selectedCount, mediaIndex) {
    if (total <= 1) return '';
    if (mediaIndex && mediaIndex > 0) return `${Math.min(mediaIndex, total)} / ${total}`;
    return selectedCount === total ? `1-${total} / ${total}` : `1-${selectedCount} / ${total}`;
}

function uniqueTextMatches(text, pattern, limit = 10) {
    if (!text) return '';
    const seen = new Set();
    const values = [];
    for (const match of String(text).matchAll(pattern)) {
        const value = match[0];
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(value);
        if (values.length >= limit) break;
    }
    return values.join(' ');
}

function formatDurationSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const total = Math.round(n);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
    return `${minutes}:${seconds}`;
}

function audioSummary(data) {
    return [data.audioTitle, data.audioArtist].filter(Boolean).join(' - ');
}

function addField(fields, name, value, inline = true) {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: String(value), inline });
}

function buildBaseEmbed(data, canonicalUrl, lang, requesterName, selectedCount, mediaIndex, s) {
    const caption = truncate(data.caption || '', resolveCaptionMaxLength(s?.instagram_caption_max_length, s));
    let description = [caption, `[${tr(STR.viewLink, lang)}](${canonicalUrl})`].filter(Boolean).join('\n\n');
    description = truncate(description, DESCRIPTION_MAX_LENGTH);

    const title = data.username ? `@${data.username}` : 'Instagram';
    const embed = {
        title,
        url: canonicalUrl,
        description,
        color: EMBED_COLOR,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - Instagram` },
    };

    if (data.username) {
        embed.author = {
            name: `@${data.username}`,
            url: `https://www.instagram.com/${data.username}/`,
        };
    }
    if (data.timestamp) embed.timestamp = new Date(data.timestamp);

    const fields = [];
    const range = shouldShowOutputItem(s, 'media_range') ? displayRange(data.medias.length, selectedCount, mediaIndex) : '';
    addField(fields, tr(STR.mediaField, lang), range);
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.durationField, lang), formatDurationSeconds(data.videoDuration));
    if (shouldShowOutputItem(s, 'audio')) addField(fields, tr(STR.audioField, lang), audioSummary(data));
    if (shouldShowOutputItem(s, 'likes')) addField(fields, tr(STR.likesField, lang), formatCount(data.likeCount, lang));
    if (shouldShowOutputItem(s, 'comments')) addField(fields, tr(STR.commentsField, lang), formatCount(data.commentCount, lang));
    if (shouldShowOutputItem(s, 'location')) addField(fields, tr(STR.locationField, lang), data.locationName);
    if (shouldShowOutputItem(s, 'hashtags')) addField(fields, tr(STR.hashtagsField, lang), uniqueTextMatches(data.caption, /#[\p{L}\p{N}_]+/gu), false);
    if (shouldShowOutputItem(s, 'mentions')) addField(fields, tr(STR.mentionsField, lang), uniqueTextMatches(data.caption, /@[A-Za-z0-9._]+/g), false);
    if (fields.length > 0) embed.fields = fields;
    return embed;
}

function formatCount(value, lang) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim() || null;
    return new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US').format(value);
}

function buildProfilePayload(profile, canonicalUrl, lang, requesterName, s) {
    const descriptionParts = [];
    if (profile.biography) descriptionParts.push(truncate(profile.biography, 1200));
    if (profile.externalUrl) descriptionParts.push(`[${tr(STR.websiteLink, lang)}](${profile.externalUrl})`);
    descriptionParts.push(`[${tr(STR.viewLink, lang)}](${canonicalUrl})`);

    const title = profile.fullName
        ? `${profile.fullName} (@${profile.username})`
        : `@${profile.username}`;

    /** @type {any} */
    const embed = {
        title,
        url: canonicalUrl,
        description: truncate(descriptionParts.filter(Boolean).join('\n\n'), DESCRIPTION_MAX_LENGTH),
        color: EMBED_COLOR,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - Instagram` },
    };

    if (profile.profilePicUrl) embed.thumbnail = { url: profile.profilePicUrl };

    const fields = [];
    const posts = formatCount(profile.posts, lang);
    const followers = formatCount(profile.followers, lang);
    const following = formatCount(profile.following, lang);
    if (shouldShowOutputItem(s, 'profile_counts')) {
        if (posts !== null) fields.push({ name: tr(STR.postsField, lang), value: posts, inline: true });
        if (followers !== null) fields.push({ name: tr(STR.followersField, lang), value: followers, inline: true });
        if (following !== null) fields.push({ name: tr(STR.followingField, lang), value: following, inline: true });
    }
    if (shouldShowOutputItem(s, 'profile_status')) {
        const status = [
            profile.isVerified ? tr(STR.verifiedStatus, lang) : '',
            profile.isPrivate ? tr(STR.privateStatus, lang) : '',
        ].filter(Boolean).join(' / ');
        addField(fields, tr(STR.profileStatusField, lang), status);
    }
    if (fields.length > 0) embed.fields = fields;

    const payload = {
        embeds: [embed],
        files: [],
        components: buildButtons(lang, 'profile', false),
    };
    return applyMediaDisplayToStep(payload, s, profile.profilePicUrl, 'Image');
}

function buildButtons(lang, mediaMode, includeSwitcher) {
    const rows = [];
    if (includeSwitcher) {
        const customId = mediaMode === 'attachments' ? 'showAttachmentsAsEmbedsImage' : 'showMediaAsAttachments';
        const label = mediaMode === 'attachments'
            ? tr(STR.showAttachmentsAsEmbedButton, lang)
            : tr(STR.showMediaAsAttachmentsButton, lang);
        rows.push({
            type: ComponentType.ActionRow,
            components: [new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(label).setCustomId(customId)],
        });
    }

    rows.push({
        type: ComponentType.ActionRow,
        components: [
            new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.translateButton, lang)).setCustomId('translate'),
            new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(tr(STR.deleteButton, lang)).setCustomId('delete:instagram'),
        ],
    });
    return rows;
}

function buildMediaPayload(data, canonicalUrl, lang, requesterName, s, mediaIndex) {
    const selected = selectMedias(data.medias, mediaIndex, resolveMediaLimit(s.instagram_media_limit, s));
    if (selected.length === 0) return null;

    const baseEmbed = buildBaseEmbed(data, canonicalUrl, lang, requesterName, selected.length, mediaIndex, s);
    const hasVideo = selected.some(isVideoMedia);
    const shouldUseAttachments = hasVideo || selected.length > 4 || s.sendMediaAsAttachmentsAsDefault === true;

    if (shouldUseAttachments) {
        const files = selected.map(media => media.url);
        const canSwitchBack = !hasVideo && selected.length <= 4;
        const payload = {
            embeds: [baseEmbed],
            files,
            components: buildButtons(lang, 'attachments', canSwitchBack),
        };
        return applyMediaDisplayToStep(payload, s, selected.map(media => media.url), 'Media');
    }

    const embeds = selected.map((media, index) => {
        /** @type {any} */
        const embed = index === 0
            ? { ...baseEmbed }
            : { url: canonicalUrl, color: EMBED_COLOR };
        embed.image = { url: media.url };
        return embed;
    });

    const payload = {
        embeds,
        files: [],
        components: buildButtons(lang, 'embeds', selected.length > 0),
    };
    return applyMediaDisplayToStep(payload, s, selected.map(media => media.url), 'Media');
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s, opts) {
    s = s || {};
    opts = opts || {};
    const lang = toApiLocaleFamily(s.defaultLanguage);

    const parsed = await resolveParsedUrl(parseInstagramUrl(url));
    if (!parsed || (parsed.kind !== 'media' && parsed.kind !== 'profile')) return null;

    const isAnon = s.anonymous_expand === true;
    const requesterName = isAnon
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
    const canonicalUrl = buildCanonicalUrl(parsed);

    if (parsed.kind === 'profile') {
        let profile;
        try {
            profile = await fetchProfileData(parsed.username);
        } catch (err) {
            console.warn(`[instagram] Failed to extract profile ${url}: ${err?.message || err}`);
            recordProviderError('instagram', err, message, url, { endpointKey: 'instagram/profile' });
            return buildFailureResponse('instagram', url, s, err);
        }
        if (!profile) return null;

        const bannedTarget = [profile.username, profile.fullName, profile.biography].filter(Boolean).join('\n');
        if (containsBannedWord(bannedTarget, s.bannedWords)) return null;

        const payload = buildProfilePayload(profile, canonicalUrl, lang, requesterName, s);
        /** @type {import('../_types').SendStep} */
        const step = {
            content: payload.content,
            embeds: payload.embeds,
            files: payload.files,
            components: payload.components,
            allowedMentions: { repliedUser: false },
            send: opts.forceSendMode || (s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel'),
        };

        if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
            step.deleteSource = true;
        } else if (s.legacy_mode === true) {
            step.suppressSourceEmbeds = true;
        }

        return [step];
    }

    let data;
    try {
        data = await fetchInstagramData(parsed);
    } catch (err) {
        recordProviderError('instagram', err, message, url, { endpointKey: 'instagram/embed-or-graphql' });
        return buildFailureResponse('instagram', url, s, err);
    }

    if (containsBannedWord(data.caption || '', s.bannedWords)) return null;

    const payload = buildMediaPayload(data, canonicalUrl, lang, requesterName, s, parsed.mediaIndex);
    if (!payload) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        content: payload.content,
        embeds: payload.embeds,
        files: payload.files,
        components: payload.components,
        allowedMentions: { repliedUser: false },
        send: opts.forceSendMode || (s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel'),
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    } else if (s.legacy_mode === true) {
        step.suppressSourceEmbeds = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const instagramProvider = {
    id: 'instagram',
    enabledByDefault: false,
    urlPattern: INSTAGRAM_URL_PATTERN,
    cleanPattern: INSTAGRAM_CLEAN_PATTERN,
    settings: [
        'bannedWords',
        'sendMediaAsAttachmentsAsDefault',
        'display_density',
        'media_display_mode',
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'legacy_mode',
        'instagram_caption_max_length',
        'instagram_media_limit',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'likes', label: { en: 'Likes field', ja: 'Likes field' } },
                { value: 'comments', label: { en: 'Comments field', ja: 'Comments field' } },
                { value: 'location', label: { en: 'Location field', ja: 'Location field' } },
                { value: 'hashtags', label: { en: 'Hashtags field', ja: 'Hashtags field' } },
                { value: 'mentions', label: { en: 'Mentions field', ja: 'Mentions field' } },
                { value: 'duration', label: { en: 'Video duration field', ja: 'Video duration field' } },
                { value: 'audio', label: { en: 'Audio field', ja: 'Audio field' } },
                { value: 'profile_status', label: { en: 'Profile status field', ja: 'Profile status field' } },
                { value: 'media_range', label: { en: 'Media count field', ja: 'メディア枚数欄' } },
                { value: 'profile_counts', label: { en: 'Profile count fields', ja: 'プロフィール数値欄' } },
            ],
        },
    ],
    extract,
};

module.exports = instagramProvider;
module.exports.__test = {
    parseInstagramUrl,
    parseInstagramHtml,
    normalizeMediaNode,
    resolveShareUrl,
    _clearCache: () => {
        dataCache.clear();
        profileApiBackoffUntil = 0;
    },
};
