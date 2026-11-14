'use strict';

// Provider identity is derived from a parsed URL host, never from URL text,
// query parameters, fragments, userinfo, or arbitrary suffixes.
function detectProviderIdFromMessage(message) {
    let url;
    try { url = new URL(message?.embeds?.[0]?.url || ''); } catch { return null; }
    if (url.username || url.password) return null;
    if (url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '3088'
        && /^\/data\/\d{16,22}\/\d{1,22}\/data\.json$/.test(url.pathname)) return 'twitter';
    if (!['http:', 'https:'].includes(url.protocol) || url.port) return null;
    const host = url.hostname.toLowerCase();
    const exactHosts = {
        github: ['github.com', 'www.github.com', 'gist.github.com'],
        tiktok: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
        steam: ['store.steampowered.com', 'steamcommunity.com', 'www.steamcommunity.com', 's.team'],
    };
    for (const [provider, candidates] of Object.entries(exactHosts)) if (candidates.includes(host)) return provider;
    if (require('./providers/amazon/urls').parseAmazonUrl(url.toString())) return 'amazon';
    const domains = {
        twitter: ['twitter.com', 'x.com', 'vxtwitter.com', 'fxtwitter.com', 'twidata.sprink.cloud'],
        instagram: ['instagram.com'], pixiv: ['pixiv.net', 'phixiv.net', 'ppxiv.net'], booth: ['booth.pm'],
        spotify: ['open.spotify.com'], twitch: ['twitch.tv'], youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
        niconico: ['nicovideo.jp', 'nico.ms'],
    };
    for (const [provider, candidates] of Object.entries(domains))
        if (candidates.some(domain => host === domain || host.endsWith(`.${domain}`))) return provider;
    return null;
}

module.exports = { detectProviderIdFromMessage };
