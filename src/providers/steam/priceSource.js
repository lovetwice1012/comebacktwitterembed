'use strict';

const { resolveSteamLocale } = require('./pricing');
function parsePriceSource(raw) {
    let url;
    try { url = new URL(String(raw || '').trim()); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['store.steampowered.com', 's.team'].includes(host)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'store.steampowered.com' && parts[0]?.toLowerCase() === 'agecheck') parts.shift();
    const route = parts[0]?.toLowerCase(), kind = route === 'app' || host === 's.team' && route === 'a' ? 'app' : route === 'sub' || host === 's.team' && route === 'p' ? 'package' : host === 'store.steampowered.com' && route === 'bundle' ? 'bundle' : null;
    if (!kind || !/^\d{1,20}$/.test(parts[1] || '')) return null;
    const id = BigInt(parts[1]).toString();
    if (id === '0') return null;
    const canonical = new URL(`https://store.steampowered.com/${kind === 'package' ? 'sub' : kind}/${id}`);
    // Resolve/validate the market using the same country rules as expansion.
    const requested = url.searchParams.get('cc')?.toLowerCase();
    const market = resolveSteamLocale({ defaultLanguage: 'en-US' }, { openUrl: url.href });
    if (requested && market.country === requested) canonical.searchParams.set('cc', requested);
    return { kind, id, canonicalUrl: canonical.href, openUrl: canonical.href };
}
module.exports = { parsePriceSource };
