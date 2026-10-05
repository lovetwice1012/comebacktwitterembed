'use strict';

const { normalizeDiscordLocale, DEFAULT_DISCORD_LOCALE } = require('../../discordLocales');
const { parseAmazonUrl } = require('./urls');
const { createAmazonClient } = require('./client');
const { extractProductInfo } = require('./parsing');

function finiteAmount(value) {
    if (value === null || value === undefined || value === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeSource(input) {
    const parsed = parseAmazonUrl(input?.url);
    if (!parsed || parsed.kind !== 'product' || !parsed.asin) {
        throw Object.assign(new Error('Amazon price alerts require a product URL with an ASIN.'), { code: 'PRICE_WATCH_INVALID_SOURCE' });
    }
    const hostname = new URL(parsed.canonicalUrl).hostname.toLowerCase();
    const locale = normalizeDiscordLocale(input?.locale, DEFAULT_DISCORD_LOCALE);
    return {
        productKey: `${hostname}:${parsed.asin}`,
        productUrl: parsed.canonicalUrl,
        sourceLocale: locale,
        productKind: 'product',
        productId: parsed.asin,
    };
}

function priceSnapshot(parsed, info) {
    const priceAmount = finiteAmount(info?.priceAmount);
    const referencePriceAmount = finiteAmount(info?.referencePriceAmount);
    const currency = String(info?.priceCurrency || '').toUpperCase();
    if (priceAmount === null || !/^[A-Z]{3}$/.test(currency)) {
        throw Object.assign(new Error('Amazon did not expose a reliable current price.'), { code: 'PRICE_WATCH_PRICE_UNAVAILABLE' });
    }
    const discountPercent = referencePriceAmount && referencePriceAmount > priceAmount
        ? ((referencePriceAmount - priceAmount) / referencePriceAmount) * 100
        : 0;
    return {
        providerId: 'amazon',
        productKey: `${new URL(parsed.canonicalUrl).hostname.toLowerCase()}:${parsed.asin}`,
        productUrl: parsed.canonicalUrl,
        productName: info.title || `Amazon ${parsed.asin}`,
        priceAmount,
        referencePriceAmount,
        discountPercent,
        currency,
    };
}

async function fetch(source, context) {
    const parsed = parseAmazonUrl(source.product_url);
    if (!parsed || parsed.kind !== 'product' || !parsed.asin) {
        throw Object.assign(new Error('Stored Amazon price source is invalid.'), { code: 'PRICE_WATCH_INVALID_SOURCE' });
    }
    const client = createAmazonClient(context.fetch);
    const page = await client.fetchAmazonPage(source.product_url, undefined, source.source_locale);
    const resolved = parseAmazonUrl(page.finalUrl);
    const effective = resolved?.kind === 'product' && resolved.asin
        ? { ...resolved, openUrl: source.product_url }
        : parsed;
    const info = extractProductInfo(page.html, effective, { defaultLanguage: source.source_locale });
    return priceSnapshot(effective, info);
}

function formatPrice(snapshot, locale) {
    try {
        return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: snapshot.currency }).format(snapshot.priceAmount);
    } catch {
        return `${snapshot.currency} ${snapshot.priceAmount}`;
    }
}

module.exports = {
    id: 'amazon',
    minPollMs: 30 * 60 * 1000,
    defaultPollMs: 60 * 60 * 1000,
    globalSpacingMs: 5000,
    normalizeSource,
    fetch,
    formatPrice,
    _internal: { priceSnapshot, normalizeSource },
};
