'use strict';

const fetch = require('./providerFetch').withDeadline(require('node-fetch'));

const VIDEO_ID_RE = /^(?:[a-z]{0,4})?\d+$/i;
const NICONICO_URL_PATTERN =
    /https?:\/\/(?:(?:(?:www|sp)\.)?nicovideo\.jp\/watch\/(?:[A-Za-z]{0,4})?\d+|nico\.ms\/(?:[A-Za-z]{0,4})?\d+)[^\s<>|]*/g;

const USER_AGENT = 'niconico.py';
const FRONTEND_ID = '6';
const FRONTEND_VERSION = '0';

function parseNiconicoUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    let id = '';

    if (hostname === 'nicovideo.jp' || hostname === 'www.nicovideo.jp' || hostname === 'sp.nicovideo.jp') {
        if (segments[0] !== 'watch') return null;
        id = segments[1] || '';
    } else if (hostname === 'nico.ms') {
        id = segments[0] || '';
    } else {
        return null;
    }

    if (!VIDEO_ID_RE.test(id)) return null;
    const videoId = id.toLowerCase();
    return {
        type: 'video',
        id: videoId,
        originalUrl: `https://www.nicovideo.jp/watch/${videoId}`,
    };
}

function niconicoVideoUrl(videoId) {
    return `https://www.nicovideo.jp/watch/${encodeURIComponent(videoId)}`;
}

function hostFor(rawUrl) {
    try {
        return new URL(rawUrl).host;
    } catch {
        return '';
    }
}

function cookieHeader(cookieJar, onlyNames = null) {
    if (!cookieJar || typeof cookieJar.entries !== 'function') return '';
    const allowed = Array.isArray(onlyNames) ? new Set(onlyNames) : null;
    return [...cookieJar.entries()]
        .filter(([name, value]) => value && (!allowed || allowed.has(name)))
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function requestHeaders(rawUrl, extra = {}, cookieJar = null) {
    /** @type {Record<string, string>} */
    const headers = {
        'User-Agent': USER_AGENT,
        'X-Frontend-Id': FRONTEND_ID,
        'X-Frontend-Version': FRONTEND_VERSION,
        ...extra,
    };

    const host = hostFor(rawUrl);
    if (host) headers.Host = host;

    const cookies = cookieHeader(cookieJar);
    if (cookies) headers.Cookie = cookies;

    return headers;
}

function postHeaders(rawUrl, extra = {}, cookieJar = null) {
    return requestHeaders(rawUrl, {
        'X-Niconico-Language': 'ja-jp',
        'X-Client-Os-Type': 'others',
        'X-Request-With': 'https://www.nicovideo.jp',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://www.nicovideo.jp',
        Referer: 'https://www.nicovideo.jp/',
        ...extra,
    }, cookieJar);
}

function setCookieValues(headers) {
    if (!headers) return [];
    if (typeof headers.raw === 'function') return headers.raw()['set-cookie'] || [];
    const single = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
    return single ? [single] : [];
}

function storeResponseCookies(headers, cookieJar) {
    if (!cookieJar || typeof cookieJar.set !== 'function') return cookieJar;
    for (const value of setCookieValues(headers)) {
        const pair = String(value || '').split(';')[0];
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        const name = pair.slice(0, index).trim();
        const cookieValue = pair.slice(index + 1).trim();
        if (name && cookieValue) cookieJar.set(name, cookieValue);
    }
    return cookieJar;
}

async function fetchJsonWithCookies(url, options = {}, cookieJar = new Map()) {
    const res = await fetch(url, options);
    storeResponseCookies(res.headers, cookieJar);
    if (!res.ok) {
        const err = Object.assign(new Error(`Niconico API returned ${res.status}`), {
            status: res.status,
            code: 'NICONICO_UPSTREAM_HTTP',
        });
        throw err;
    }
    return await res.json();
}

function decodeHtmlAttribute(value) {
    const named = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
    return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (raw, key) => {
        if (key[0] !== '#') return named[key.toLowerCase()] || raw;
        const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : raw;
    });
}

function normalizeWatchResponse(json, videoId) {
    if (!json || Number(json?.meta?.status) >= 400) return null;
    const source = json?.data?.response;
    const data = source?.$watchV4?.data || source;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.video || typeof data.video !== 'object') return null;
    const id = String(data.video.id || data.client?.watchId || '').toLowerCase();
    if (id !== String(videoId).toLowerCase() || typeof data.video.title !== 'string' || !data.video.title.trim()) return null;
    if (data.client?.watchId && String(data.client.watchId).toLowerCase() !== id) return null;
    const media = data.media || {};
    const newMedia = !media.domand && media.contents && typeof media.contents === 'object' ? {
        ...media, domand: { ...media.contents, accessRightKey: media.accessRightKey },
    } : media;
    const pageOwner = data.metadata?.jsonLd?.owner;
    const identity = pageOwner && ['user', 'channel'].includes(pageOwner.type) && /^(?:ch)?\d+$/.test(String(pageOwner.id || ''))
        ? pageOwner.type === 'user' ? { owner: { id: pageOwner.id, nickname: pageOwner.name, iconUrl: pageOwner.iconUrl } }
            : { channel: { id: pageOwner.id, name: pageOwner.name, thumbnail: { url: pageOwner.iconUrl } } }
        : {};
    return { ...data, ...(!data.owner && !data.channel ? identity : {}), tag: data.tag || data.tags, media: newMedia };
}

function watchResponseFromHtml(html, videoId) {
    for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
        const attrs = {};
        const attribute = /([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        for (const match of tag.matchAll(attribute)) attrs[match[1].toLowerCase()] = decodeHtmlAttribute(match[2] ?? match[3]);
        if (attrs.name !== 'server-response' || !attrs.content) continue;
        try { return normalizeWatchResponse(JSON.parse(attrs.content), videoId); } catch { return null; }
    }
    return null;
}

async function fetchWatchData(videoId, cookieJar = new Map()) {
    const url = `${niconicoVideoUrl(videoId)}?responseType=json`;
    let failure;
    try {
        const json = await fetchJsonWithCookies(url, { headers: requestHeaders(url, {}, cookieJar) }, cookieJar);
        const response = normalizeWatchResponse(json, videoId);
        if (response) return response;
        failure = Object.assign(new Error('Niconico watch API returned invalid video data'), { code: 'NICONICO_INVALID_RESPONSE' });
    } catch (error) {
        if (![400, 404, 405].includes(error?.status) && !(error instanceof SyntaxError)) throw error;
        failure = error;
    }
    const pageUrl = niconicoVideoUrl(videoId);
    const page = await fetch(pageUrl, { headers: requestHeaders(pageUrl, { Accept: 'text/html' }, cookieJar) });
    storeResponseCookies(page.headers, cookieJar);
    if (!page.ok) throw Object.assign(new Error(`Niconico watch page returned ${page.status}`), { status: page.status });
    if (page.url && !/^(?:www\.)?nicovideo\.jp$/i.test(new URL(page.url).hostname)) throw new Error('Niconico watch page redirected outside its service');
    const parsed = watchResponseFromHtml(await page.text(), videoId);
    if (!parsed) throw failure;
    return parsed;
}

function pickHighestQualityAudio(audios) {
    return (audios || [])
        .filter(audio => audio?.isAvailable && audio.id)
        .sort((a, b) => (Number(b.qualityLevel) || 0) - (Number(a.qualityLevel) || 0))[0] || null;
}

function pickHighestQualityVideo(videos) {
    return (videos || [])
        .filter(video => video?.isAvailable && video.id)
        .sort((a, b) => {
            const aPixels = (Number(a.width) || 0) * (Number(a.height) || 0);
            const bPixels = (Number(b.width) || 0) * (Number(b.height) || 0);
            return (Number(b.qualityLevel) || 0) - (Number(a.qualityLevel) || 0) || bPixels - aPixels;
        })[0] || null;
}

function pickBestDomandOutput(watchData, { audioOnly = false } = {}) {
    const domand = watchData?.media?.domand;
    const audio = pickHighestQualityAudio(domand?.audios);
    if (!audio) return null;

    if (audioOnly) {
        return {
            label: 'audio',
            ids: [audio.id],
            audio,
            video: null,
        };
    }

    const video = pickHighestQualityVideo(domand?.videos);
    if (!video) return null;

    return {
        label: video.label || video.id,
        ids: [video.id, audio.id],
        audio,
        video,
    };
}

async function createHlsContentUrl(watchData, outputs, cookieJar = new Map()) {
    const videoId = watchData?.client?.watchId;
    const actionTrackId = watchData?.client?.watchTrackId;
    const accessRightKey = watchData?.media?.domand?.accessRightKey;
    if (!videoId || !actionTrackId || !accessRightKey) {
        throw new Error('Niconico watch data is missing DOMAND access-right fields');
    }

    const url = `https://nvapi.nicovideo.jp/v1/watch/${encodeURIComponent(videoId)}/access-rights/hls?actionTrackId=${encodeURIComponent(actionTrackId)}`;
    const json = await fetchJsonWithCookies(url, {
        method: 'POST',
        headers: postHeaders(url, {
            'Content-Type': 'application/json',
            'X-Access-Right-Key': accessRightKey,
        }, cookieJar),
        body: JSON.stringify({ outputs }),
    }, cookieJar);

    const contentUrl = json?.data?.contentUrl;
    if (!contentUrl) throw new Error('Niconico access-rights API did not return contentUrl');
    return contentUrl;
}

module.exports = {
    NICONICO_URL_PATTERN,
    cookieHeader,
    createHlsContentUrl,
    fetchWatchData,
    niconicoVideoUrl,
    parseNiconicoUrl,
    pickBestDomandOutput,
    postHeaders,
    requestHeaders,
    storeResponseCookies,
    _internal: {
        setCookieValues,
        decodeHtmlAttribute,
        normalizeWatchResponse,
        watchResponseFromHtml,
    },
};
