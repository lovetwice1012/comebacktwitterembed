'use strict';

const TNKTOK_HOST = 'www.tnktok.com';
const MODE_QUERY_KEYS = new Set(['addDesc', 'hq', 'quality', 'isDirect']);

const TIKTOK_URL_PATTERN =
    /https?:\/\/(?:(?:www|m|vm|vt)\.)?tiktok\.com\/[^\s<>|]+/g;

function rewriteTikTokUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'tiktok.com' && !hostname.endsWith('.tiktok.com')) return null;

    const nextSearch = new URLSearchParams();
    for (const key of MODE_QUERY_KEYS) {
        const value = url.searchParams.get(key);
        if (value !== null) nextSearch.set(key, value);
    }

    url.protocol = 'https:';
    url.hostname = TNKTOK_HOST;
    url.username = '';
    url.password = '';
    url.search = nextSearch.toString();
    url.hash = '';

    return url.toString();
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};

    const fixedUrl = rewriteTikTokUrl(url);
    if (!fixedUrl) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        content: fixedUrl,
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const tiktokProvider = {
    id: 'tiktok',
    enabledByDefault: false,
    urlPattern: TIKTOK_URL_PATTERN,
    extract,
};

module.exports = tiktokProvider;
module.exports._internal = {
    rewriteTikTokUrl,
};
