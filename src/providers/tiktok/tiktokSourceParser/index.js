'use strict';

// Standalone source parsing and media selection; callers handle network and output.
const AWEME_LINK_PATTERN = /\/@?([\w\d_.-]+)\/(video|photo)\/(\d{1,25})/;
const PROFILE_LINK_PATTERN = /^\/@([\w\d_.-]+)\/?$/;

function extractJsonFromScript(html, scriptId) {
    const startTag = `<script id="${scriptId}" type="application/json">`;
    const endTag = '</script>';
    const startIndex = html.indexOf(startTag);
    if (startIndex === -1) throw new Error(`Script tag ${scriptId} not found`);
    const jsonStart = startIndex + startTag.length;
    const jsonEnd = html.indexOf(endTag, jsonStart);
    if (jsonEnd === -1) throw new Error(`End tag for ${scriptId} not found`);
    return html.substring(jsonStart, jsonEnd);
}

function parseTikTokUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'tiktok.com' && !hostname.endsWith('.tiktok.com')) return null;

    const awemeMatch = url.pathname.match(AWEME_LINK_PATTERN);
    if (awemeMatch) {
        return {
            needsResolve: false,
            id: awemeMatch[3],
            kind: awemeMatch[2],
            canonicalUrl: `https://www.tiktok.com/@${awemeMatch[1]}/${awemeMatch[2]}/${awemeMatch[3]}`,
        };
    }

    const mobileVideo = url.pathname.match(/^\/v\/(\d{1,25})(?:\.html)?/);
    if (mobileVideo) {
        return {
            needsResolve: false,
            id: mobileVideo[1],
            kind: 'video',
            canonicalUrl: `https://www.tiktok.com/@i/video/${mobileVideo[1]}`,
        };
    }

    const profileMatch = url.pathname.match(PROFILE_LINK_PATTERN);
    if (profileMatch) {
        return {
            needsResolve: false,
            id: profileMatch[1],
            kind: 'profile',
            canonicalUrl: `https://www.tiktok.com/@${profileMatch[1]}`,
        };
    }

    return { needsResolve: true, url: rawUrl };
}

function pickStrings(...values) {
    const out = [];
    for (const value of values) {
        if (typeof value === 'string' && value) out.push(value);
        if (Array.isArray(value)) {
            out.push(...value.filter(item => typeof item === 'string' && item));
        }
    }
    return out;
}

function pickFirstString(...values) {
    return pickStrings(...values)[0] || '';
}

function dedupeStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function getVideoUrlCandidates(data, hq) {
    const video = data?.video;
    if (!video) return [];
    const urls = [];
    if (hq) {
        const h265 = video.bitrateInfo?.filter(item => String(item?.CodecType || '').includes('h265')) || [];
        for (const item of h265) urls.push(...pickStrings(item?.PlayAddr?.UrlList));
    }
    urls.push(...pickStrings(video.PlayAddrStruct?.UrlList, video.playAddr, video.downloadAddr));
    for (const item of video.bitrateInfo || []) {
        urls.push(...pickStrings(item?.PlayAddr?.UrlList));
    }
    return dedupeStrings(urls);
}

function pickVideoUrl(data, hq) {
    return getVideoUrlCandidates(data, hq)[0] || '';
}

function pickCoverUrl(data) {
    return pickFirstString(
        data?.video?.cover,
        data?.video?.originCover,
        data?.video?.dynamicCover,
        data?.video?.animatedCover,
        data?.author?.avatarMedium,
        data?.author?.avatarLarger,
        data?.author?.avatarThumb
    );
}

function pickImageUrls(data) {
    const images = data?.imagePost?.images;
    if (!Array.isArray(images)) return [];
    return images
        .map(image => pickFirstString(image?.imageURL?.urlList, image?.imageURL?.urlPrefix, image?.imageURL?.uri))
        .filter(Boolean);
}

function isPhotoPost(data) {
    return Array.isArray(data?.imagePost?.images) && data.imagePost.images.length > 0;
}

function parseTikTokVideoHtml(html) {
    const jsonText = extractJsonFromScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const json = JSON.parse(jsonText);
    return json?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct || null;
}

function parseTikTokProfileHtml(html) {
    const jsonText = extractJsonFromScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const json = JSON.parse(jsonText);
    return json?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo || null;
}

function decodeMetaValue(value) {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (raw, key) => {
        if (key[0] !== '#') return named[key.toLowerCase()] || raw;
        const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : raw;
    });
}

function parseTikTokProfileMeta(html, expectedId) {
    const metadata = new Map();
    for (const [tag] of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = {};
        for (const match of tag.matchAll(/([^\s=<>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
            attrs[match[1].toLowerCase()] = decodeMetaValue(match[2] ?? match[3] ?? match[4] ?? '');
        const key = String(attrs.property || attrs.name || '').toLowerCase();
        if (!key.startsWith('og:')) continue;
        if (metadata.has(key) && metadata.get(key) !== attrs.content) return null;
        metadata.set(key, attrs.content || '');
    }
    const canonical = metadata.get('og:url');
    let parsed, url;
    try { url = new URL(canonical); parsed = parseTikTokUrl(canonical); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || parsed?.kind !== 'profile'
        || parsed.id.toLowerCase() !== String(expectedId).toLowerCase()) return null;
    let title = String(metadata.get('og:title') || '').trim().replace(/\s+on TikTok\s*$/i, '').trim();
    if (!title) return null;
    const titleHandle = title.match(/\(@([\w.-]+)\)\s*$/);
    if (titleHandle && titleHandle[1].toLowerCase() !== String(expectedId).toLowerCase()) return null;
    if (titleHandle) title = title.slice(0, titleHandle.index).trim() || parsed.id;
    let avatar;
    try {
        const image = new URL(metadata.get('og:image'));
        if (image.protocol === 'https:' && !image.username && !image.password) avatar = image.toString();
    } catch { /* A profile without an avatar is still usable. */ }
    const stats = {};
    const description = String(metadata.get('og:description') || '');
    const descriptionHandle = description.match(/^\s*@([\w.-]+)/);
    if (descriptionHandle && descriptionHandle[1].toLowerCase() !== String(expectedId).toLowerCase()) return null;
    // A generic error page can echo the requested og:url. Require an
    // independent handle in the displayed profile metadata as well.
    if (!titleHandle && !descriptionHandle) return null;
    const match = description.match(/^\s*@([\w.-]+)\s+([\d,.]+[KMB]?)\s+Followers,\s*([\d,.]+[KMB]?)\s+Following,\s*([\d,.]+[KMB]?)\s+Likes\b/i);
    if (match && match[1].toLowerCase() === String(expectedId).toLowerCase()) {
        const count = value => {
            if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[KMB]?$/i.test(value)) return undefined;
            const suffix = value.slice(-1).toLowerCase(), multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix] || 1;
            const parsedCount = Number(value.replace(/,/g, '').replace(/[kmb]$/i, '')) * multiplier;
            return Number.isFinite(parsedCount) && parsedCount >= 0 && parsedCount <= Number.MAX_SAFE_INTEGER ? Math.round(parsedCount) : undefined;
        };
        stats.followerCount = count(match[2]);
        stats.followingCount = count(match[3]);
        stats.heartCount = count(match[4]);
    }
    return { user: { uniqueId: parsed.id, nickname: title, ...(avatar ? { avatarMedium: avatar } : {}) }, stats };
}

module.exports = {
    parseTikTokVideoHtml,
    parseTikTokProfileHtml,
    parseTikTokProfileMeta,
    extractJsonFromScript,
    parseTikTokUrl,
    pickStrings,
    pickFirstString,
    dedupeStrings,
    getVideoUrlCandidates,
    pickVideoUrl,
    pickCoverUrl,
    pickImageUrls,
    isPhotoPost,
};
