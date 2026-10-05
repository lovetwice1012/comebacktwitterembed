'use strict';

// YouTube display labels, text limits, and date/number formatting.
const { toApiLocaleFamily } = require('../../discordLocales');
const { resolveDensityMaxLength, resolveDisplayDensity, shouldShowOutputItem } = require('../_output_controls');
const { decodeHtml } = require('./youtubeSourceParser');

const DESCRIPTION_MAX_LENGTH = 1400;

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
    duration: { ja: 'Duration', en: 'Duration' },
    type: { ja: 'Type', en: 'Type' },
    shorts: { ja: 'Shorts', en: 'Shorts' },
    premiere: { ja: 'Premiere', en: 'Premiere' },
};

function tr(spec, lang) {
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLang(s) {
    return toApiLocaleFamily(s?.defaultLanguage);
}

function truncate(text, maxLength) {
    const s = String(text ?? '').trim();
    if (maxLength <= 0) return '';
    if (s.length <= maxLength) return s;
    if (maxLength <= 3) return s.slice(0, maxLength);
    return s.slice(0, maxLength - 3).trimEnd() + '...';
}

function youtubeDescriptionMaxLength(s) {
    return resolveDensityMaxLength(
        { ...s, youtube_description_max_length: s?.youtube_description_max_length ?? s?.youtubeDescriptionMaxLength },
        'youtube_description_max_length',
        DESCRIPTION_MAX_LENGTH,
        { compact: 200, detail: DESCRIPTION_MAX_LENGTH, hardMax: DESCRIPTION_MAX_LENGTH }
    );
}

function truncateYouTubeDescription(text, s) {
    const maxLength = youtubeDescriptionMaxLength(s);
    if (maxLength <= 0) return '';
    return truncate(decodeHtml(text), maxLength);
}

function showYouTubeStats(s) {
    return shouldShowOutputItem(s, 'stats');
}

function showYouTubeLatestVideos(s) {
    return shouldShowOutputItem(s, 'video_list', { hideInCompact: false });
}

function resolveYouTubeVideoListLimit(s) {
    if (!showYouTubeLatestVideos(s)) return 0;
    const raw = s?.youtube_video_list_limit;
    const value = Number(raw);
    if ([0, 3, 5, 10].includes(value)) return value;
    const density = resolveDisplayDensity(s);
    if (density === 'compact') return 3;
    if (density === 'detail') return 10;
    return 5;
}

function formatNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') return value;
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n.toLocaleString('en-US');
}

function durationSeconds(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return Number(text);
    const iso = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (iso) return (Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0);
    if (/^\d{1,2}(?::\d{2}){1,2}$/.test(text)) {
        return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    }
    return null;
}

function formatDurationValue(value) {
    const seconds = durationSeconds(value);
    if (!seconds) return typeof value === 'string' ? value : '';
    const parts = [];
    let remaining = seconds;
    const hours = Math.floor(remaining / 3600);
    remaining %= 3600;
    const minutes = Math.floor(remaining / 60);
    remaining %= 60;
    if (hours > 0) parts.push(String(hours));
    parts.push(hours > 0 ? String(minutes).padStart(2, '0') : String(minutes));
    parts.push(String(remaining).padStart(2, '0'));
    return parts.join(':');
}

function videoDuration(info) {
    return formatDurationValue(info?.lengthSeconds ?? info?.length_seconds ?? info?.durationSeconds ?? info?.duration);
}

function timestampSeconds(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.floor(value > 1e12 ? value / 1000 : value);
    }
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return timestampSeconds(Number(text));
    if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function publishedText(info, lang) {
    if (info?.liveNow) return tr(STR.liveNow, lang);
    const timestamp = timestampSeconds(info?.published ?? info?.publishedAt ?? info?.publishedText);
    if (timestamp) return `<t:${timestamp}:d>`;
    return info?.publishedText || '';
}

function videoType(info, parsed, lang) {
    if (info?.liveNow) return tr(STR.liveNow, lang);
    if (info?.premiereTimestamp || info?.premiereDate || info?.isUpcoming) return tr(STR.premiere, lang);
    if (parsed?.isShorts || info?.isShort || info?.isShorts) return tr(STR.shorts, lang);
    return tr(STR.video, lang);
}

module.exports = {
    DESCRIPTION_MAX_LENGTH,
    STR,
    tr,
    normalizeLang,
    decodeHtml,
    truncate,
    truncateYouTubeDescription,
    showYouTubeStats,
    resolveYouTubeVideoListLimit,
    formatNumber,
    videoDuration,
    publishedText,
    videoType,
};
