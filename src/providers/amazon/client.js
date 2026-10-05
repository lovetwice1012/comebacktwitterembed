'use strict';

const { normalizeAmazonMusicHost } = require('./urls');
const { parseJsonSafely, iframeSrcFromHtml } = require('./amazonSourceParser');
const { normalizeDiscordLocale, DEFAULT_DISCORD_LOCALE } = require('../../discordLocales');

const REQUEST_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};

const AMAZON_MUSIC_SOCIAL_HEADERS = {
    ...REQUEST_HEADERS,
    'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
};

const AMAZON_MUSIC_EMBED_HEADERS = {
    ...REQUEST_HEADERS,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

function localizedHeaders(headers, locale) {
    const language = normalizeDiscordLocale(locale, DEFAULT_DISCORD_LOCALE);
    const family = language.split('-')[0];
    return { ...headers, 'Accept-Language': language === family ? language : `${language},${family};q=0.9` };
}

// Bind each provider instance to its own transport, including deadline handling.
function createAmazonClient(fetch) {
    async function fetchAmazonPage(rawUrl, headers = REQUEST_HEADERS, locale = DEFAULT_DISCORD_LOCALE) {
        const res = await fetch(rawUrl, { headers: localizedHeaders(headers, locale), redirect: 'follow' });
        if (!res.ok) {
            /** @type {Error & {status?: number}} */
            const err = new Error(`amazon page ${res.status} for ${rawUrl}`);
            err.status = res.status;
            throw err;
        }
        return {
            html: await res.text(),
            finalUrl: res.url || rawUrl,
        };
    }

    async function fetchJsonPage(rawUrl, headers = REQUEST_HEADERS, locale = DEFAULT_DISCORD_LOCALE) {
        const res = await fetch(rawUrl, { headers: localizedHeaders(headers, locale), redirect: 'follow' });
        if (!res.ok) {
            /** @type {Error & {status?: number}} */
            const err = new Error(`amazon json ${res.status} for ${rawUrl}`);
            err.status = res.status;
            throw err;
        }
        const text = await res.text();
        const parsed = parseJsonSafely(text);
        if (!parsed || typeof parsed !== 'object') {
            /** @type {Error & {status?: number}} */
            const err = new Error(`amazon json parse failed for ${rawUrl}`);
            err.status = res.status;
            throw err;
        }
        return parsed;
    }

    function amazonMusicOembedUrl(parsed) {
        const host = parsed.host || normalizeAmazonMusicHost(new URL(parsed.canonicalUrl).hostname);
        return `https://${host}/embed/oembed?url=${encodeURIComponent(parsed.canonicalUrl)}`;
    }

    async function fetchAmazonMusicSupplement(parsed, locale = DEFAULT_DISCORD_LOCALE) {
        const supplement = { socialHtml: '', embedHtml: '', oembed: null };

        try {
            const page = await fetchAmazonPage(parsed.canonicalUrl, AMAZON_MUSIC_SOCIAL_HEADERS, locale);
            supplement.socialHtml = page.html;
        } catch {
            // Amazon Music still has enough fallbacks below when social metadata is unavailable.
        }

        try {
            const oembedUrl = amazonMusicOembedUrl(parsed);
            const oembed = await fetchJsonPage(oembedUrl, AMAZON_MUSIC_SOCIAL_HEADERS, locale);
            supplement.oembed = oembed;
            const iframeSrc = iframeSrcFromHtml(oembed.html, oembedUrl);
            if (iframeSrc) {
                const embedPage = await fetchAmazonPage(iframeSrc, AMAZON_MUSIC_EMBED_HEADERS, locale);
                supplement.embedHtml = embedPage.html;
            }
        } catch {
            // oEmbed is supplemental only; keep the normal page metadata if it fails.
        }

        return supplement;
    }

    return { fetchAmazonPage, fetchAmazonMusicSupplement };
}

module.exports = { createAmazonClient };
