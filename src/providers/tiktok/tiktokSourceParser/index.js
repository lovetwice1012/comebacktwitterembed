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

module.exports = {
    parseTikTokVideoHtml,
    parseTikTokProfileHtml,
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
