'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
const youtubeDownloadStore = require('../../youtubeDownloadStore');

const INVIDIOUS_INSTANCES = [
    'https://iteroni.com',
    'https://invidious.einfachzocken.eu',
    'https://iv.nboeck.de',
];

const YOUTUBE_URL_PATTERN =
    /https?:\/\/(?:(?:(?:www|m|music)\.)?youtube\.com|(?:www\.)?youtube-nocookie\.com|(?:www\.)?youtu\.be)\/[^\s<>|]+/g;

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[a-zA-Z0-9_-]{18,}$/;
const EMBED_COLOR = 0xff0000;
const DESCRIPTION_MAX_LENGTH = 1400;
const FIELD_MAX_LENGTH = 1024;
const YOUTUBE_ICON = 'https://www.youtube.com/s/desktop/3748dff5/img/favicon_144x144.png';
const REQUEST_HEADERS = {
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0; +https://github.com/iGerman00/koutube-logic-port)',
};

const TRACKING_QUERY_KEYS = [
    'feature',
    'pp',
    'si',
    'is',
    'a',
    'embeds_referring_euri',
    'embeds_referring_origin',
    'embeds_euri',
    'embeds_origin',
    'embeds_widget_referrer',
    'source_ve_path',
    'iv_load_policy',
    'rel',
    'lc',
    'ab_channel',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'gclid',
    'fbclid',
    'cid',
    'mc_cid',
    'mc_eid',
    'yclid',
    'cmp',
    'context',
    'keyword',
    'source',
    'medium',
    'campaign',
    'term',
    'content',
];

const STR = {
    requesterPrefix: { ja: '展開者: ', en: 'Requested by ' },
    anonymousRequester: { ja: '匿名ユーザー', en: 'Anonymous requester' },
    translateButton: { ja: '翻訳', en: 'Translate' },
    deleteButton: { ja: '削除', en: 'Delete' },
    video: { ja: '動画', en: 'Video' },
    playlist: { ja: 'プレイリスト', en: 'Playlist' },
    channel: { ja: 'チャンネル', en: 'Channel' },
    views: { ja: '再生数', en: 'Views' },
    likes: { ja: '高評価', en: 'Likes' },
    subscribers: { ja: '登録者', en: 'Subscribers' },
    videos: { ja: '動画数', en: 'Videos' },
    updated: { ja: '更新日', en: 'Updated' },
    uploaded: { ja: '公開', en: 'Uploaded' },
    liveNow: { ja: 'ライブ配信中', en: 'Live now' },
    latestVideos: { ja: '最新動画', en: 'Latest videos' },
};

function tr(spec, lang) {
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLang(s) {
    const lang = s?.defaultLanguage;
    return lang === 'ja' ? 'ja' : 'en';
}

function getInstances() {
    const configured = process.env.YOUTUBE_INVIDIOUS_INSTANCES;
    if (!configured) return INVIDIOUS_INSTANCES;
    const values = configured.split(',').map(v => v.trim()).filter(Boolean);
    return values.length > 0 ? values : INVIDIOUS_INSTANCES;
}

function stripTracking(rawUrl) {
    const url = new URL(rawUrl);
    for (const key of TRACKING_QUERY_KEYS) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
}

function decodeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)));
}

function truncate(text, maxLength) {
    const s = String(text ?? '').trim();
    if (s.length <= maxLength) return s;
    return s.slice(0, maxLength - 3).trimEnd() + '...';
}

function formatNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') return value;
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n.toLocaleString('en-US');
}

function absoluteUrl(value, baseUrl) {
    if (!value) return null;
    if (value.startsWith('//')) return 'https:' + value;
    if (value.startsWith('/')) return baseUrl + value;
    return value;
}

function pickThumbnail(thumbnails, baseUrl) {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
    const best = thumbnails
        .filter(t => t && t.url)
        .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    return best ? absoluteUrl(best.url, baseUrl) : null;
}

function isTransientInvidiousError(errorText) {
    if (!errorText) return false;
    return /please sign in|community|temporarily|429|rate limit|extract/i.test(String(errorText));
}

async function fetchJsonFromInstances(path) {
    let lastError = null;
    for (const baseUrl of getInstances()) {
        try {
            const res = await fetch(baseUrl + path, { headers: REQUEST_HEADERS });
            if (!res.ok) {
                lastError = new Error(`Invidious ${res.status} for ${path}`);
                continue;
            }
            const json = await res.json();
            if (json?.error && isTransientInvidiousError(json.error)) {
                lastError = new Error(json.error);
                continue;
            }
            return { json, baseUrl };
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error(`Invidious request failed: ${path}`);
}

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

async function fetchVideoInfoFromYouTubePage(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
        headers: REQUEST_HEADERS,
    });
    if (!res.ok) throw new Error(`YouTube page ${res.status} for ${videoId}`);

    const html = await res.text();
    const player = parseInitialPlayerResponse(html);
    const normalized = normalizePlayerResponse(player);
    if (!normalized) throw new Error(`YouTube page did not contain player metadata for ${videoId}`);

    return { json: normalized, baseUrl: 'https://www.youtube.com' };
}

async function fetchVideoInfoFromOEmbed(videoId) {
    const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`, {
        headers: REQUEST_HEADERS,
    });
    if (!res.ok) throw new Error(`YouTube oEmbed ${res.status} for ${videoId}`);

    const info = await res.json();
    return {
        json: {
            title: info.title,
            videoThumbnails: [{ url: info.thumbnail_url, width: info.thumbnail_width, height: info.thumbnail_height }],
            description: '',
            publishedText: '',
            viewCount: undefined,
            likeCount: undefined,
            author: info.author_name,
            authorUrl: info.author_url,
            authorId: undefined,
            authorThumbnails: [],
            subCountText: '',
            liveNow: false,
            formatStreams: [],
        },
        baseUrl: 'https://www.youtube.com',
    };
}

function parseYouTubeUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    const isYouTube =
        hostname === 'youtube.com'
        || hostname === 'www.youtube.com'
        || hostname === 'm.youtube.com'
        || hostname === 'music.youtube.com'
        || hostname === 'youtu.be'
        || hostname === 'www.youtu.be'
        || hostname === 'youtube-nocookie.com'
        || hostname === 'www.youtube-nocookie.com';
    if (!isYouTube) return null;

    const pathname = url.pathname;
    const segments = pathname.split('/').filter(Boolean);
    const originalUrl = stripTracking(url.toString());

    if ((hostname === 'youtu.be' || hostname === 'www.youtu.be') && VIDEO_ID_RE.test(segments[0] || '')) {
        return { type: 'video', id: segments[0], originalUrl, isShorts: false };
    }

    if (pathname === '/watch') {
        const videoId = url.searchParams.get('v');
        if (videoId && VIDEO_ID_RE.test(videoId)) {
            return { type: 'video', id: videoId, originalUrl, isShorts: false };
        }
        const playlistId = url.searchParams.get('list');
        if (playlistId && PLAYLIST_ID_RE.test(playlistId)) {
            return { type: 'playlist', id: playlistId, originalUrl };
        }
    }

    if (pathname === '/playlist') {
        const playlistId = url.searchParams.get('list');
        if (playlistId && PLAYLIST_ID_RE.test(playlistId)) {
            return { type: 'playlist', id: playlistId, originalUrl };
        }
    }

    if ((segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live' || segments[0] === 'v') && VIDEO_ID_RE.test(segments[1] || '')) {
        return { type: 'video', id: segments[1], originalUrl, isShorts: segments[0] === 'shorts' };
    }

    if (segments[0] === 'channel' && segments[1]) {
        return { type: 'channel', id: segments[1], originalUrl, resolved: true };
    }

    if (segments[0] === 'c' || segments[0] === 'user' || pathname.startsWith('/@')) {
        return { type: 'channel', id: originalUrl, originalUrl, resolved: false };
    }

    return null;
}

async function fetchVideoInfo(videoId) {
    const path = `/api/v1/videos/${encodeURIComponent(videoId)}?hl=en`;
    return fetchJsonFromInstances(path);
}

async function fetchVideoInfoWithFallback(videoId) {
    try {
        const result = await fetchVideoInfo(videoId);
        if (result?.json?.error) throw new Error(result.json.error);
        return result;
    } catch (invidiousError) {
        try {
            return await fetchVideoInfoFromYouTubePage(videoId);
        } catch {
            try {
                return await fetchVideoInfoFromOEmbed(videoId);
            } catch {
                throw invidiousError;
            }
        }
    }
}

async function fetchPlaylistInfo(playlistId) {
    const path = `/api/v1/playlists/${encodeURIComponent(playlistId)}?hl=en`;
    return fetchJsonFromInstances(path);
}

async function fetchYouTubeInitialDataPage(pageUrl, context) {
    const target = new URL(pageUrl);
    if (!target.searchParams.has('hl')) target.searchParams.set('hl', 'en');

    const res = await fetch(target.toString(), { headers: REQUEST_HEADERS });
    if (!res.ok) throw new Error(`YouTube page ${res.status} for ${context}`);

    const html = await res.text();
    const data = parseInitialData(html);
    if (!data) throw new Error(`YouTube page did not contain initial data for ${context}`);

    return { data, html, baseUrl: 'https://www.youtube.com' };
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

async function fetchPlaylistInfoFromYouTubePage(playlistId) {
    const pageUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
    const { data, html, baseUrl } = await fetchYouTubeInitialDataPage(pageUrl, `playlist ${playlistId}`);
    const json = normalizePlaylistFromInitialData(data, html, playlistId);
    if (!json) throw new Error(`YouTube page did not contain playlist metadata for ${playlistId}`);
    return { json, baseUrl };
}

async function fetchPlaylistInfoWithFallback(playlistId) {
    try {
        const result = await fetchPlaylistInfo(playlistId);
        if (result?.json?.error) throw new Error(result.json.error);
        return result;
    } catch (invidiousError) {
        try {
            return await fetchPlaylistInfoFromYouTubePage(playlistId);
        } catch {
            throw invidiousError;
        }
    }
}

async function resolveChannelUrl(channelUrl) {
    const path = `/api/v1/resolveurl?url=${encodeURIComponent(channelUrl)}`;
    const { json } = await fetchJsonFromInstances(path);
    return json?.ucid || null;
}

async function fetchChannelInfo(channelIdOrUrl, alreadyResolved) {
    const channelId = alreadyResolved ? channelIdOrUrl : await resolveChannelUrl(channelIdOrUrl);
    if (!channelId) return null;
    const path = `/api/v1/channels/${encodeURIComponent(channelId)}?hl=en`;
    const result = await fetchJsonFromInstances(path);
    return { ...result, channelId };
}

function channelPageUrl(channelIdOrUrl, alreadyResolved) {
    if (alreadyResolved) {
        return `https://www.youtube.com/channel/${encodeURIComponent(channelIdOrUrl)}`;
    }
    try {
        return new URL(channelIdOrUrl).toString();
    } catch {
        return `https://www.youtube.com/${encodeURIComponent(String(channelIdOrUrl).replace(/^\/+/, ''))}`;
    }
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

async function fetchChannelInfoFromYouTubePage(channelIdOrUrl, alreadyResolved) {
    const pageUrl = channelPageUrl(channelIdOrUrl, alreadyResolved);
    const { data, html, baseUrl } = await fetchYouTubeInitialDataPage(pageUrl, `channel ${channelIdOrUrl}`);
    const json = normalizeChannelFromInitialData(data, html, channelIdOrUrl, alreadyResolved);
    if (!json) throw new Error(`YouTube page did not contain channel metadata for ${channelIdOrUrl}`);
    return { json, baseUrl, channelId: json.authorId || channelIdOrUrl };
}

async function fetchChannelInfoWithFallback(channelIdOrUrl, alreadyResolved) {
    try {
        const result = await fetchChannelInfo(channelIdOrUrl, alreadyResolved);
        if (result?.json?.error) throw new Error(result.json.error);
        if (result) return result;
    } catch (invidiousError) {
        try {
            return await fetchChannelInfoFromYouTubePage(channelIdOrUrl, alreadyResolved);
        } catch {
            throw invidiousError;
        }
    }

    return fetchChannelInfoFromYouTubePage(channelIdOrUrl, alreadyResolved);
}

function requesterFooter(message, lang, anonymous) {
    const requester = anonymous
        ? tr(STR.anonymousRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
    return `${tr(STR.requesterPrefix, lang)}${requester} · YouTube`;
}

function buildComponents(lang, includeDownload) {
    const components = [
        new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.translateButton, lang)).setCustomId('translate'),
    ];
    if (includeDownload && youtubeDownloadStore.isDownloadButtonEnabled()) {
        components.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Download').setCustomId('downloadYouTubeVideo'));
    }
    components.push(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(tr(STR.deleteButton, lang)).setCustomId('delete:youtube'));

    return [{ type: ComponentType.ActionRow, components }];
}

function addField(fields, name, value, inline = true) {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: truncate(String(value), FIELD_MAX_LENGTH), inline });
}

function videoUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
}

function channelUrl(authorUrl, authorId) {
    if (authorUrl) return absoluteUrl(authorUrl, 'https://www.youtube.com');
    return authorId ? `https://www.youtube.com/channel/${authorId}` : 'https://www.youtube.com';
}

function buildVideoEmbed(info, parsed, baseUrl, message, s) {
    const lang = normalizeLang(s);
    const thumbnail = pickThumbnail(info.videoThumbnails, baseUrl);
    const authorUrl = channelUrl(info.authorUrl, info.authorId);
    const fields = [];
    addField(fields, tr(STR.views, lang), formatNumber(info.viewCount));
    addField(fields, tr(STR.likes, lang), formatNumber(info.likeCount));
    addField(fields, tr(STR.subscribers, lang), info.subCountText);
    addField(fields, tr(STR.uploaded, lang), info.liveNow ? tr(STR.liveNow, lang) : info.publishedText);

    const titlePrefix = info.liveNow ? `${tr(STR.liveNow, lang)} · ` : '';
    const description = truncate(decodeHtml(info.description), DESCRIPTION_MAX_LENGTH);
    const requester = requesterFooter(message, lang, s?.anonymous_expand === true);
    const embed = {
        author: {
            name: info.author || tr(STR.video, lang),
            url: authorUrl,
            icon_url: pickThumbnail(info.authorThumbnails, baseUrl) || undefined,
        },
        title: titlePrefix + (info.title || parsed.id),
        url: parsed.originalUrl || videoUrl(parsed.id),
        description: description || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requester, icon_url: YOUTUBE_ICON },
    };
    if (thumbnail) embed.image = { url: thumbnail };
    return embed;
}

function buildPlaylistDescription(info, lang) {
    const lines = [];
    const description = truncate(decodeHtml(info.description), 500);
    if (description) lines.push(description);

    const videos = Array.isArray(info.videos) ? info.videos.filter(v => v?.title && v.title !== '[Private video]').slice(0, 5) : [];
    if (videos.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`${tr(STR.videos, lang)}:`);
        videos.forEach((video, index) => lines.push(`${index + 1}. ${video.title}`));
    }

    return truncate(lines.join('\n'), DESCRIPTION_MAX_LENGTH);
}

function buildPlaylistEmbed(info, parsed, baseUrl, message, s) {
    const lang = normalizeLang(s);
    const fields = [];
    addField(fields, tr(STR.channel, lang), info.author ? `[${info.author}](${channelUrl(info.authorUrl, info.authorId)})` : null);
    addField(fields, tr(STR.views, lang), formatNumber(info.viewCount));
    addField(fields, tr(STR.videos, lang), formatNumber(info.videoCount));
    if (info.updated) addField(fields, tr(STR.updated, lang), `<t:${Number(info.updated)}:d>`);

    const embed = {
        author: { name: tr(STR.playlist, lang), icon_url: YOUTUBE_ICON },
        title: info.title || parsed.id,
        url: parsed.originalUrl || `https://www.youtube.com/playlist?list=${parsed.id}`,
        description: buildPlaylistDescription(info, lang) || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requesterFooter(message, lang, s?.anonymous_expand === true), icon_url: YOUTUBE_ICON },
    };

    const thumbnail = absoluteUrl(info.playlistThumbnail, baseUrl)
        || pickThumbnail(info.videos?.[0]?.videoThumbnails, baseUrl);
    if (thumbnail) embed.image = { url: thumbnail };
    return embed;
}

function buildChannelDescription(info, lang) {
    const lines = [];
    const description = truncate(decodeHtml(info.descriptionHtml || info.description), 600);
    if (description) lines.push(description);

    const videos = Array.isArray(info.latestVideos) ? info.latestVideos.filter(v => v?.title && v.title !== '[Private video]').slice(0, 5) : [];
    if (videos.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`${tr(STR.latestVideos, lang)}:`);
        videos.forEach((video, index) => lines.push(`${index + 1}. ${video.title}`));
    }

    return truncate(lines.join('\n'), DESCRIPTION_MAX_LENGTH);
}

function buildChannelEmbed(info, parsed, baseUrl, message, s) {
    const lang = normalizeLang(s);
    const fields = [];
    addField(fields, tr(STR.subscribers, lang), formatNumber(info.subCount));
    addField(fields, tr(STR.views, lang), formatNumber(info.totalViews));

    const url = channelUrl(info.authorUrl, info.authorId || parsed.id);
    const embed = {
        author: { name: tr(STR.channel, lang), icon_url: YOUTUBE_ICON },
        title: `${info.author || parsed.id}${info.authorVerified ? ' ✓' : ''}`,
        url,
        description: buildChannelDescription(info, lang) || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requesterFooter(message, lang, s?.anonymous_expand === true), icon_url: YOUTUBE_ICON },
    };

    const thumbnail = pickThumbnail(info.authorThumbnails, baseUrl);
    if (thumbnail) embed.thumbnail = { url: thumbnail };
    const banner = pickThumbnail(info.authorBanners, baseUrl);
    if (banner) embed.image = { url: banner };
    return embed;
}

function buildStep(embed, message, url, s, lang, includeDownload = false) {
    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        components: buildComponents(lang, includeDownload),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }
    return step;
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};

    const parsed = parseYouTubeUrl(url);
    if (!parsed) return null;

    try {
        const lang = normalizeLang(s);
        let embed;
        if (parsed.type === 'video') {
            const { json, baseUrl } = await fetchVideoInfoWithFallback(parsed.id);
            if (!json || json.error) return null;
            embed = buildVideoEmbed(json, parsed, baseUrl, message, s);
        } else if (parsed.type === 'playlist') {
            const { json, baseUrl } = await fetchPlaylistInfoWithFallback(parsed.id);
            if (!json || json.error) return null;
            embed = buildPlaylistEmbed(json, parsed, baseUrl, message, s);
        } else if (parsed.type === 'channel') {
            const result = await fetchChannelInfoWithFallback(parsed.id, parsed.resolved);
            if (!result || !result.json || result.json.error) return null;
            embed = buildChannelEmbed(result.json, parsed, result.baseUrl, message, s);
        } else {
            return null;
        }

        return [buildStep(embed, message, url, s, lang, parsed.type === 'video')];
    } catch (err) {
        recordProviderError('youtube', err, message, url, { endpointKey: 'invidious/api' });
        return null;
    }
}

/** @type {import('../_types').Provider} */
const youtubeProvider = {
    id: 'youtube',
    enabledByDefault: false,
    urlPattern: YOUTUBE_URL_PATTERN,
    extract,
};

module.exports = youtubeProvider;
module.exports._internal = {
    buildChannelEmbed,
    buildPlaylistEmbed,
    buildVideoEmbed,
    fetchVideoInfoFromOEmbed,
    fetchVideoInfoFromYouTubePage,
    fetchChannelInfoFromYouTubePage,
    fetchPlaylistInfoFromYouTubePage,
    parseYouTubeUrl,
    parseInitialData,
    parseInitialPlayerResponse,
    stripTracking,
};
