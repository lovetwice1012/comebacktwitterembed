'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');

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

function textFromRuns(value) {
    if (!value) return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map(run => run.text || '').join('');
    return '';
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
        return await fetchVideoInfo(videoId);
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

function requesterFooter(message, lang, anonymous) {
    const requester = anonymous
        ? tr(STR.anonymousRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
    return `${tr(STR.requesterPrefix, lang)}${requester} · YouTube`;
}

function buildComponents(lang) {
    return [
        {
            type: ComponentType.ActionRow,
            components: [
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.translateButton, lang)).setCustomId('translate'),
                new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(tr(STR.deleteButton, lang)).setCustomId('delete:youtube'),
            ],
        },
    ];
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

function buildStep(embed, message, url, s, lang) {
    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        components: buildComponents(lang),
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
            const { json, baseUrl } = await fetchPlaylistInfo(parsed.id);
            if (!json || json.error) return null;
            embed = buildPlaylistEmbed(json, parsed, baseUrl, message, s);
        } else if (parsed.type === 'channel') {
            const result = await fetchChannelInfo(parsed.id, parsed.resolved);
            if (!result || !result.json || result.json.error) return null;
            embed = buildChannelEmbed(result.json, parsed, result.baseUrl, message, s);
        } else {
            return null;
        }

        return [buildStep(embed, message, url, s, lang)];
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
    parseYouTubeUrl,
    parseInitialPlayerResponse,
    stripTracking,
};
