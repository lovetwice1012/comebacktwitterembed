'use strict';

const fetch = require('node-fetch');

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
        const err = Object.assign(new Error(`Niconico API returned ${res.status} for ${url}`), {
            status: res.status,
            url,
        });
        throw err;
    }
    return await res.json();
}

async function fetchWatchData(videoId, cookieJar = new Map()) {
    const url = `${niconicoVideoUrl(videoId)}?responseType=json`;
    const json = await fetchJsonWithCookies(url, {
        headers: requestHeaders(url, {}, cookieJar),
    }, cookieJar);

    const response = json?.data?.response;
    if (!response || json?.meta?.status >= 400) {
        const code = json?.data?.response?.errorCode || json?.meta?.code || 'unknown';
        throw new Error(`Niconico watch API did not return watch data (${code})`);
    }
    return response;
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
    },
};
