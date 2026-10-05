'use strict';

// Parse embedded YouTube page data into the metadata shape used by the provider.
const { decodeHtml } = require('./html');
const { pickThumbnail, channelPageUrl } = require('./urls');

function extractBalancedJson(source, objectStart) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = objectStart; i < source.length; i++) {
        const ch = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(objectStart, i + 1);
        }
    }

    return null;
}

function parseInitialPlayerResponse(html) {
    const marker = 'ytInitialPlayerResponse';
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) return null;

    const objectStart = html.indexOf('{', markerIndex);
    if (objectStart === -1) return null;

    const jsonText = extractBalancedJson(html, objectStart);
    if (!jsonText) return null;

    return JSON.parse(jsonText);
}

function parseInitialData(html) {
    const marker = 'ytInitialData';
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) return null;

    const objectStart = html.indexOf('{', markerIndex);
    if (objectStart === -1) return null;

    const jsonText = extractBalancedJson(html, objectStart);
    if (!jsonText) return null;

    return JSON.parse(jsonText);
}

function textFromRuns(value) {
    if (!value) return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map(run => run.text || '').join('');
    return '';
}

function textFromYouTubeText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (Array.isArray(value)) return value.map(textFromYouTubeText).filter(Boolean).join('').trim();
    if (typeof value !== 'object') return '';

    if (typeof value.simpleText === 'string') return value.simpleText.trim();
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (Array.isArray(value.runs)) {
        return value.runs.map(run => run.text || textFromYouTubeText(run)).join('').trim();
    }

    const label = value.accessibility?.accessibilityData?.label;
    if (typeof label === 'string') return label.trim();

    for (const key of ['title', 'subtitle', 'description', 'label']) {
        const text = textFromYouTubeText(value[key]);
        if (text) return text;
    }
    return '';
}

function firstText(...values) {
    for (const value of values) {
        const text = textFromYouTubeText(value);
        if (text) return text;
    }
    return '';
}

function parseCompactNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    const text = textFromYouTubeText(value);
    if (!text) return null;

    const match = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
    if (!match) return text;

    const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
    const multiplier = multipliers[match[2]?.toLowerCase()] || 1;
    const number = Number(match[1]) * multiplier;
    return Number.isFinite(number) ? Math.round(number) : text;
}

function walkJson(value, visitor) {
    const queue = [value];
    const seen = new Set();

    for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);

        if (visitor(current) === false) return;

        const children = Array.isArray(current) ? current : Object.values(current);
        for (const child of children) {
            if (child && typeof child === 'object') queue.push(child);
        }
    }
}

function findFirstRenderer(data, rendererName) {
    let found = null;
    walkJson(data, (node) => {
        if (Object.prototype.hasOwnProperty.call(node, rendererName)) {
            found = node[rendererName];
            return false;
        }
        return true;
    });
    return found;
}

function findAllRenderers(data, rendererName, limit = 20) {
    const found = [];
    walkJson(data, (node) => {
        if (Object.prototype.hasOwnProperty.call(node, rendererName)) {
            found.push(node[rendererName]);
            if (found.length >= limit) return false;
        }
        return true;
    });
    return found;
}

function findFirstProperty(data, propertyName, accept = value => Boolean(value)) {
    let found = null;
    walkJson(data, (node) => {
        if (Object.prototype.hasOwnProperty.call(node, propertyName) && accept(node[propertyName])) {
            found = node[propertyName];
            return false;
        }
        return true;
    });
    return found;
}

function findFirstTextMatching(data, pattern) {
    let found = '';
    walkJson(data, (node) => {
        const text = textFromYouTubeText(node);
        if (text && pattern.test(text)) {
            found = text;
            return false;
        }
        return true;
    });
    return found;
}

function thumbnailsFrom(value) {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.filter(item => item?.url);
    if (Array.isArray(value.thumbnails)) return value.thumbnails.filter(item => item?.url);
    if (Array.isArray(value.sources)) {
        return value.sources
            .filter(item => item?.url)
            .map(item => ({ url: item.url, width: item.width, height: item.height }));
    }
    return thumbnailsFrom(value.image || value.thumbnail || value.avatar);
}

function firstThumbnails(...values) {
    for (const value of values) {
        const thumbnails = thumbnailsFrom(value);
        if (thumbnails.length > 0) return thumbnails;
    }
    return [];
}

function findFirstThumbnailProperty(data, propertyName) {
    const value = findFirstProperty(data, propertyName, item => thumbnailsFrom(item).length > 0);
    return thumbnailsFrom(value);
}

function firstBrowseId(value) {
    let found = '';
    walkJson(value, (node) => {
        const browseId = node.browseEndpoint?.browseId || node.browseId;
        if (typeof browseId === 'string' && browseId) {
            found = browseId;
            return false;
        }
        return true;
    });
    return found;
}

function firstChannelUrl(value) {
    let found = '';
    walkJson(value, (node) => {
        const candidate = node.commandMetadata?.webCommandMetadata?.url || node.urlEndpoint?.url || node.url;
        if (typeof candidate === 'string' && /^(?:https?:\/\/(?:www\.)?youtube\.com)?\/(?:channel\/|@)/.test(candidate)) {
            found = candidate;
            return false;
        }
        return true;
    });
    return found;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMetaContent(html, name) {
    const attr = escapeRegExp(name);
    const tag = html.match(new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    if (!tag) return '';
    const content = tag.match(/\bcontent=(["'])(.*?)\1/i);
    return content ? decodeHtml(content[2]).trim() : '';
}

function cleanYouTubeTitle(value) {
    return String(value || '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
}

function normalizePlayerResponse(player) {
    const details = player?.videoDetails || {};
    const microformat = player?.microformat?.playerMicroformatRenderer || {};
    if (!details.videoId || !details.title) return null;

    return {
        title: details.title,
        videoThumbnails: details.thumbnail?.thumbnails || microformat.thumbnail?.thumbnails || [],
        description: details.shortDescription || textFromRuns(microformat.description),
        publishedText: microformat.publishDate || microformat.uploadDate || '',
        published: microformat.publishDate || microformat.uploadDate || '',
        lengthSeconds: Number(details.lengthSeconds) || undefined,
        viewCount: Number(details.viewCount) || undefined,
        likeCount: undefined,
        author: details.author || microformat.ownerChannelName || '',
        authorUrl: microformat.ownerProfileUrl || (details.channelId ? `/channel/${details.channelId}` : ''),
        authorId: details.channelId,
        authorThumbnails: microformat.ownerProfileUrl ? [] : [],
        subCountText: '',
        liveNow: details.isLiveContent === true,
        formatStreams: [],
    };
}

function normalizePlaylistVideo(renderer) {
    const title = firstText(renderer.title, renderer.title?.accessibility);
    const videoId = renderer.videoId || findFirstProperty(renderer, 'videoId', value => typeof value === 'string');
    return {
        title,
        videoId,
        videoThumbnails: thumbnailsFrom(renderer.thumbnail),
    };
}

function normalizePlaylistFromInitialData(data, html, playlistId) {
    const metadata = findFirstRenderer(data, 'playlistMetadataRenderer') || {};
    const header = findFirstRenderer(data, 'playlistHeaderRenderer') || {};
    const microformat = findFirstRenderer(data, 'microformatDataRenderer') || {};
    const ownerText = header.ownerText || header.shortBylineText || findFirstProperty(data, 'ownerText', value => textFromYouTubeText(value));
    const title = cleanYouTubeTitle(firstText(
        metadata.title,
        header.title,
        microformat.title,
        readMetaContent(html, 'og:title')
    ));

    const videos = findAllRenderers(data, 'playlistVideoRenderer', 20)
        .map(normalizePlaylistVideo)
        .filter(video => video.title || video.videoId);
    const thumbnail = pickThumbnail(firstThumbnails(
        header.playlistHeaderBanner?.heroPlaylistThumbnailRenderer?.thumbnail,
        header.thumbnail,
        metadata.thumbnail,
        microformat.thumbnail
    ), 'https://www.youtube.com') || readMetaContent(html, 'og:image') || pickThumbnail(videos[0]?.videoThumbnails, 'https://www.youtube.com');
    const authorId = firstBrowseId(ownerText || header);
    const authorUrl = firstChannelUrl(ownerText || header) || (authorId ? `/channel/${authorId}` : '');

    const normalized = {
        title: title || playlistId,
        playlistThumbnail: thumbnail,
        description: firstText(
            metadata.description,
            header.descriptionText,
            microformat.description,
            readMetaContent(html, 'description'),
            readMetaContent(html, 'og:description')
        ),
        author: firstText(ownerText, header.ownerEndpoint?.browseEndpoint?.canonicalBaseUrl),
        authorUrl,
        authorId,
        videoCount: parseCompactNumber(header.numVideosText || findFirstTextMatching(data, /\b\d[\d,.]*\s+videos?\b/i)),
        viewCount: parseCompactNumber(header.viewCountText || findFirstTextMatching(data, /\b\d[\d,.]*\s+views?\b/i)),
        updated: undefined,
        videos,
    };

    if (!normalized.title && videos.length === 0) return null;
    return normalized;
}

function normalizeLatestVideo(renderer) {
    const title = firstText(renderer.title, renderer.title?.accessibility);
    return {
        title,
        videoId: renderer.videoId || undefined,
        videoThumbnails: thumbnailsFrom(renderer.thumbnail),
    };
}

function normalizeChannelFromInitialData(data, html, channelIdOrUrl, alreadyResolved) {
    const metadata = findFirstRenderer(data, 'channelMetadataRenderer') || {};
    const c4Header = findFirstRenderer(data, 'c4TabbedHeaderRenderer') || {};
    const pageHeader = findFirstRenderer(data, 'pageHeaderRenderer') || {};
    const author = cleanYouTubeTitle(firstText(
        metadata.title,
        c4Header.title,
        pageHeader.title,
        readMetaContent(html, 'og:title')
    ));
    const authorId = metadata.externalId
        || c4Header.channelId
        || firstBrowseId(pageHeader)
        || firstBrowseId(c4Header)
        || (alreadyResolved ? channelIdOrUrl : '');
    const authorUrl = metadata.channelUrl
        || metadata.vanityChannelUrl
        || firstChannelUrl(pageHeader)
        || firstChannelUrl(c4Header)
        || (authorId ? `/channel/${authorId}` : channelPageUrl(channelIdOrUrl, alreadyResolved));
    const subscriberText = c4Header.subscriberCountText
        || pageHeader.subscriberCountText
        || findFirstProperty(data, 'subscriberCountText', value => textFromYouTubeText(value));
    const viewText = c4Header.viewCountText
        || pageHeader.viewCountText
        || findFirstTextMatching(data, /\b\d[\d,.]*\s+views?\b/i);
    const headerBlob = JSON.stringify({ metadata, c4Header, pageHeader });
    const latestVideos = findAllRenderers(data, 'videoRenderer', 20)
        .map(normalizeLatestVideo)
        .filter(video => video.title)
        .slice(0, 5);

    const normalized = {
        author: author || authorId || channelIdOrUrl,
        authorId,
        authorUrl,
        authorBanners: firstThumbnails(
            c4Header.banner,
            c4Header.tvBanner,
            pageHeader.banner,
            pageHeader.imageBannerViewModel?.image,
            findFirstThumbnailProperty(data, 'banner')
        ),
        authorThumbnails: firstThumbnails(
            metadata.avatar,
            c4Header.avatar,
            c4Header.thumbnail,
            pageHeader.avatar,
            findFirstThumbnailProperty(data, 'avatar')
        ),
        subCount: parseCompactNumber(subscriberText),
        totalViews: parseCompactNumber(viewText),
        descriptionHtml: firstText(
            metadata.description,
            pageHeader.description,
            c4Header.description,
            readMetaContent(html, 'description'),
            readMetaContent(html, 'og:description')
        ),
        latestVideos,
        authorVerified: /BADGE_STYLE_TYPE_VERIFIED|"isVerified"\s*:\s*true/.test(headerBlob),
    };

    if (!normalized.author && latestVideos.length === 0) return null;
    return normalized;
}

module.exports = {
    parseInitialPlayerResponse,
    parseInitialData,
    normalizePlayerResponse,
    normalizePlaylistFromInitialData,
    normalizeChannelFromInitialData,
};
