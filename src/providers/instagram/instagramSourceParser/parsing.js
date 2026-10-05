'use strict';

// Pure parsing and normalization for page HTML, GraphQL, oEmbed, and profiles.
// Cap the carousel child contribution while ranking source media records.
const MAX_CAROUSEL_SCORE_ITEMS = 10;
const { parseInstagramUrl } = require('./urls');

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
    const attributes = /([^\s=<>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of tag.matchAll(attributes)) {
        if (match[1].toLowerCase() === attrName.toLowerCase()) {
            return decodeHtmlEntities(match[2] || match[3] || match[4] || '');
        }
    }
    return '';
}

function visibleHtml(html) {
    // Script identifiers (e.g. ComposeCaption) and string literals are not DOM
    // elements. Never allow them to supply captions, classes or metadata.
    return html.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

function findElementWithClass(html, className) {
    const tagRe = /<[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>/g;
    for (const match of html.matchAll(tagRe)) {
        if (extractAttr(match[0], 'class').split(/\s+/).includes(className)) return match;
    }
    return null;
}

function findTagWithClass(html, className) {
    return findElementWithClass(visibleHtml(html), className)?.[0] || '';
}

function extractElementHtmlByClass(html, className) {
    html = visibleHtml(html);
    const element = findElementWithClass(html, className);
    if (!element) return '';
    const openTag = element[0];
    const openEnd = element.index + openTag.length - 1;
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
    html = visibleHtml(html);
    const metaRe = /<meta\b[^>]*>/gi;
    let match;
    while ((match = metaRe.exec(html)) !== null) {
        const tag = match[0];
        const prop = extractAttr(tag, 'property') || extractAttr(tag, 'name');
        if (prop === property) return extractAttr(tag, 'content');
    }
    return '';
}

function scrapeFromEmbedHtml(html, shortcode = '') {
    const pageUrl = getMetaContent(html, 'og:url');
    if (shortcode && pageUrl) {
        const page = parseInstagramUrl(pageUrl);
        if (page?.kind !== 'media' || page.shortcode !== shortcode) return null;
    }

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
    // Instagram's current crawler page uses XIGPolaris media objects instead
    // of the legacy shortcode_media wrapper. Keep the legacy markers too so
    // older page variants and GraphQL responses remain supported.
    const tokens = [
        'shortcode_media', 'xdt_shortcode_media', 'carousel_media',
        'video_versions', 'video_url', 'video_dash_manifest',
        'display_url', 'display_uri', 'image_versions2',
    ];
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

function isVideoNode(node) {
    return Number(node?.media_type) === 2
        || /video/i.test(String(node?.__typename || ''))
        || Boolean(node?.video_url)
        || (Array.isArray(node?.video_versions) && node.video_versions.length > 0);
}

function mediaNodeScore(node) {
    if (!node || typeof node !== 'object') return 0;

    const sidecarEdges = getPath(node, 'edge_sidecar_to_children.edges');
    const carousel = node.carousel_media;
    const childCount = Array.isArray(sidecarEdges) ? sidecarEdges.length
        : Array.isArray(carousel) ? carousel.length : 0;
    const hasImage = Boolean(firstString(node, [
        'display_url', 'display_uri', 'thumbnail_src', 'image_versions2.candidates.0.url',
    ]));
    const hasVideo = isVideoNode(node);
    if (childCount === 0 && !hasImage && !hasVideo) return 0;

    let score = hasImage ? 100 : 0;
    if (hasVideo) score += 10_000;
    // A carousel parent must win over one of its child preview records.
    if (childCount > 0) score += 1_000_000 + Math.min(childCount, MAX_CAROUSEL_SCORE_ITEMS) * 100;
    if (node.owner || node.user) score += 10;
    return score;
}

function findMediaNode(candidates, shortcode = '') {
    let best = null;
    let bestScore = 0;
    let bestMatch = null;
    let bestMatchScore = 0;
    let hasIdentifiedMedia = false;
    let visited = 0;
    const seen = new Set();

    function visit(value, currentDepth) {
        if (!value || typeof value !== 'object' || currentDepth > 14 || visited >= 12_000) return;
        if (Array.isArray(value)) {
            for (const item of value.slice(0, 50)) visit(item, currentDepth + 1);
            return;
        }
        if (seen.has(value)) return;
        seen.add(value);
        visited++;

        const score = mediaNodeScore(value);
        if (score > 0) {
            const code = firstString(value, ['shortcode', 'code']);
            if (code) hasIdentifiedMedia = true;
            if (shortcode && code === shortcode && score > bestMatchScore) {
                bestMatch = value;
                bestMatchScore = score;
            }
            if ((!shortcode || !code) && score > bestScore) {
                best = value;
                bestScore = score;
            }
        }

        for (const child of Object.values(value)) visit(child, currentDepth + 1);
    }

    for (const candidate of candidates) {
        visited = 0;
        visit(candidate, 0);
    }
    // A page can contain recommendations as well as the requested post. Rank
    // media types only within that post, never across different shortcodes.
    // If only other posts are identified, anonymous fragments may be their
    // carousel children: do not let those fragments bypass the identity check.
    return bestMatch || (shortcode && hasIdentifiedMedia ? null : best);
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
    if (isVideoNode(node)) {
        const video = firstString(node, ['video_url', 'video_versions.0.url']);
        if (video) return normalizeCdnUrl(video);
    }

    const image = firstString(node, [
        'display_url',
        'display_uri',
        'thumbnail_src',
        'image_versions2.candidates.0.url',
    ]);
    if (image) return normalizeCdnUrl(image);

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
            typeName: isVideoNode(media) ? 'GraphVideo' : (media.__typename || 'GraphImage'),
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

function parseInstagramHtml(html, shortcode = '') {
    const node = findMediaNode(collectJsonCandidates(html), shortcode);
    const normalized = normalizeMediaNode(node);
    if (normalized) return normalized;

    return scrapeFromEmbedHtml(html, shortcode);
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

module.exports = {
    parseInstagramHtml,
    normalizeMediaNode,
    normalizeOEmbedData,
    normalizeProfileData,
    normalizeProfileHtmlData,
    findMediaNode,
    tryParseJson,
};
