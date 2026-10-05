'use strict';

const { normalizeDiscordLocale, DEFAULT_DISCORD_LOCALE } = require('../../discordLocales');
const { parsePriceSource: parseSteamUrl } = require('./priceSource');
const { resolveSteamLocale, steamPriceAmount } = require('./pricing');
const { parseSteamPage, cleanSteamTitle } = require('./steamSourceParser');

const REQUEST_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (compatible; ComebackTwitterEmbed/1.0)',
};

function normalPrice(value) {
    const amount = steamPriceAmount(value);
    return amount === null ? null : amount;
}

function normalizeSource(input) {
    const parsed = parseSteamUrl(input?.url);
    if (!parsed || !['app', 'package', 'bundle'].includes(parsed.kind) || !parsed.id) {
        throw Object.assign(new Error('Steam price alerts require an app, package, or bundle URL.'), { code: 'PRICE_WATCH_INVALID_SOURCE' });
    }
    const locale = normalizeDiscordLocale(input?.locale, DEFAULT_DISCORD_LOCALE);
    const country = resolveSteamLocale({ defaultLanguage: locale }, parsed).country;
    const defaultCountry = resolveSteamLocale({ defaultLanguage: locale }).country;
    return {
        productKey: `${parsed.kind}:${parsed.id}${country === defaultCountry ? '' : `:cc:${country}`}`,
        productUrl: parsed.canonicalUrl,
        sourceLocale: locale,
        productKind: parsed.kind,
        productId: parsed.id,
    };
}

function snapshotFromPrice(parsed, name, price) {
    const priceAmount = normalPrice(price?.final);
    const referencePriceAmount = normalPrice(price?.initial);
    const currency = String(price?.currency || '').toUpperCase();
    if (priceAmount === null || !/^[A-Z]{3}$/.test(currency)) {
        throw Object.assign(new Error('Steam did not expose a reliable current price.'), { code: 'PRICE_WATCH_PRICE_UNAVAILABLE' });
    }
    return {
        providerId: 'steam',
        productKey: `${parsed.kind}:${parsed.id}`,
        productUrl: parsed.canonicalUrl,
        productName: cleanSteamTitle(name) || `Steam ${parsed.kind} #${parsed.id}`,
        priceAmount,
        referencePriceAmount,
        discountPercent: Number(price?.discount_percent) || (referencePriceAmount && referencePriceAmount > priceAmount
            ? ((referencePriceAmount - priceAmount) / referencePriceAmount) * 100
            : 0),
        currency,
    };
}

async function fetchAppPrice(parsed, source, context) {
    const region = resolveSteamLocale({ defaultLanguage: source.source_locale }, { canonicalUrl: source.product_url });
    const url = new URL('https://store.steampowered.com/api/appdetails');
    url.searchParams.set('appids', parsed.id);
    url.searchParams.set('l', region.language);
    url.searchParams.set('cc', region.country);
    const response = await context.fetch(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': REQUEST_HEADERS['User-Agent'] } });
    if (!response.ok) throw Object.assign(new Error(`Steam app details returned HTTP ${response.status}.`), { code: 'PRICE_WATCH_UPSTREAM_ERROR', status: response.status });
    const data = await response.json();
    const entry = data?.[parsed.id];
    if (!entry?.success || !entry.data) throw Object.assign(new Error('Steam app details did not include price data.'), { code: 'PRICE_WATCH_PRICE_UNAVAILABLE' });
    return snapshotFromPrice(parsed, entry.data.name, entry.data.price_overview);
}

async function fetchStorePagePrice(parsed, source, context) {
    const region = resolveSteamLocale({ defaultLanguage: source.source_locale }, { canonicalUrl: source.product_url });
    const url = new URL(source.product_url);
    url.searchParams.set('cc', region.country);
    url.searchParams.set('l', region.language);
    const response = await context.fetch(url.toString(), { headers: REQUEST_HEADERS });
    if (!response.ok) throw Object.assign(new Error(`Steam store page returned HTTP ${response.status}.`), { code: 'PRICE_WATCH_UPSTREAM_ERROR', status: response.status });
    const html = await response.text();
    const info = parseSteamPage(html, response.url || url.toString(), { ...parsed, country: region.country });
    return snapshotFromPrice(parsed, info.title, info.priceOverview);
}

async function fetch(source, context) {
    const parsed = parseSteamUrl(source.product_url);
    if (!parsed || !['app', 'package', 'bundle'].includes(parsed.kind) || !parsed.id) {
        throw Object.assign(new Error('Stored Steam price source is invalid.'), { code: 'PRICE_WATCH_INVALID_SOURCE' });
    }
    if (parsed.kind === 'app') {
        try { return await fetchAppPrice(parsed, source, context); } catch { /* Store page fallback below. */ }
    }
    return await fetchStorePagePrice(parsed, source, context);
}

function formatPrice(snapshot, locale) {
    try {
        return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: snapshot.currency }).format(snapshot.priceAmount);
    } catch {
        return `${snapshot.currency} ${snapshot.priceAmount}`;
    }
}

module.exports = {
    id: 'steam',
    minPollMs: 15 * 60 * 1000,
    defaultPollMs: 30 * 60 * 1000,
    globalSpacingMs: 2000,
    normalizeSource,
    fetch,
    formatPrice,
    _internal: { normalizeSource, snapshotFromPrice },
};
