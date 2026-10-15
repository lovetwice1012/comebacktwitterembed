'use strict';

// Pure source parsing; this folder can be copied without application dependencies.
function decodeHtml(value) {
    return String(value ?? '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)));
}

function stripHtml(value) {
    return decodeHtml(value)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function cleanText(value) {
    return stripHtml(value)
        .replace(/\s+/g, ' ')
        .trim();
}

function extractAttr(tag, attrName) {
    if (!tag) return '';
    const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = tag.match(re);
    return match ? decodeHtml(match[2] || match[3] || match[4] || '') : '';
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMetaContent(html, name) {
    const attr = escapeRegExp(name);
    const tag = html.match(new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${attr}["'])[^>]*>`, 'i'))?.[0];
    return tag ? cleanText(extractAttr(tag, 'content')) : '';
}

function readTitleTag(html) {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match ? cleanText(match[1]) : '';
}

function absoluteUrl(rawUrl, baseUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    if (value.startsWith('//')) return 'https:' + value;
    try {
        return new URL(value, baseUrl).toString();
    } catch {
        return value;
    }
}

function cleanSteamTitle(value) {
    return cleanText(value)
        .replace(/^Steam Community\s*::\s*/i, '')
        .replace(/^Steam[：:]\s*/i, '')
        .replace(/\s+on Steam$/i, '')
        .replace(/\s*::\s*Steam$/i, '')
        .trim();
}

function readElement(html, start) {
    const tagName = html.slice(start).match(/^<([a-z0-9]+)\b/i)?.[1];
    if (!tagName) return '';
    const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tags.lastIndex = start;
    let depth = 0;
    for (let match; (match = tags.exec(html));) {
        depth += match[0].startsWith('</') ? -1 : 1;
        if (depth === 0) return html.slice(start, tags.lastIndex);
    }
    return '';
}

function elementsByClass(html, className) {
    const elements = [];
    for (const match of html.matchAll(/<[a-z0-9]+\b[^>]*\bclass\s*=\s*["'][^"']*["'][^>]*>/gi)) {
        if (!extractAttr(match[0], 'class').split(/\s+/).includes(className)) continue;
        const element = readElement(html, match.index);
        if (element) elements.push(element);
    }
    return elements;
}

function readItemprop(html, name) {
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
        if (extractAttr(tag, 'itemprop') === name) return cleanText(extractAttr(tag, 'content'));
    }
    return '';
}

function readHundredths(raw) {
    if (!/^\d+$/.test(String(raw))) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
}

function readRegionalAmount(raw, country) {
    if (!raw || !/^[\d\s.,'’]+$/.test(raw)) return null;
    try {
        const locale = new Intl.Locale(`und-${country.toUpperCase()}`).maximize().toString();
        const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
        const decimal = parts.find(part => part.type === 'decimal')?.value || '.';
        const group = parts.find(part => part.type === 'group')?.value;
        let value = raw.replace(/[\s'’]/g, '');
        if (group) value = value.split(group).join('');
        value = value.replace(decimal, '.');
        if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
        const hundredths = Math.round(Number(value) * 100);
        return Number.isSafeInteger(hundredths) ? hundredths : null;
    } catch {
        return null;
    }
}

function priceFromPurchaseAction(action, country = 'us') {
    const priceElement = elementsByClass(action, 'discount_final_price')[0]
        || elementsByClass(action, 'game_purchase_price')[0];
    if (!priceElement) return null;
    const pricedTag = action.match(/<[a-z0-9]+\b[^>]*\bdata-price-final\s*=[^>]*>/i)?.[0];
    const final = readHundredths(extractAttr(pricedTag, 'data-price-final'));
    const finalFormatted = cleanText(priceElement);
    if (final === null || !finalFormatted) return null;
    const discounts = ['data-discount', 'data-bundlediscount'].map(name => extractAttr(pricedTag, name))
        .filter(value => /^\d+(?:\.\d+)?$/.test(value)).map(Number).filter(value => value >= 0 && value <= 100);
    const original = elementsByClass(action, 'discount_original_price')[0];
    const initial = original ? readRegionalAmount(cleanText(original).replace(/^[^\d]+|[^\d]+$/g, ''), country) : null;
    const regularPrice = elementsByClass(action, 'game_purchase_price').length > 0 && !elementsByClass(action, 'discount_block').length;
    return { final, final_formatted: finalFormatted,
        ...(discounts.length ? { discount_percent: Math.max(...discounts) } : regularPrice ? { discount_percent: 0 } : {}),
        ...(initial !== null && initial >= final ? { initial } : regularPrice ? { initial: final } : {}) };
}

/** @returns {{ final: number, initial?: number, currency?: string, final_formatted?: string, discount_percent?: number } | null} */
function parseSteamPrice(html, baseUrl, target = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { return null; }
    if (url.hostname !== 'store.steampowered.com') return null;
    const route = url.pathname.match(/^\/(?:agecheck\/)?(app|sub|bundle)\/(\d+)(?:\/|$)/);
    const kind = target.kind || (route?.[1] === 'sub' ? 'package' : route?.[1]);
    const id = target.id || route?.[2];
    if (!id || !['app', 'package', 'bundle'].includes(kind)) return null;
    // Ignore embedded recommendation HTML and scripts containing unrelated prices.
    const source = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const actions = elementsByClass(source, 'game_purchase_action_bg');
    const currency = readItemprop(source, 'priceCurrency').toUpperCase();
    if (kind === 'app') {
        // The main Product offer is authoritative. Never pick a DLC or bundle's
        // purchase block just because it happens to be the first visible price.
        const offerTag = /<div\b[^>]*\bitemprop\s*=["']offers["'][^>]*>/i.exec(source);
        const offer = offerTag ? readElement(source, offerTag.index) : '';
        const amount = readRegionalAmount(readItemprop(offer || '', 'price'), target.country || url.searchParams.get('cc') || 'us');
        const offerCurrency = readItemprop(offer || '', 'priceCurrency').toUpperCase();
        if (amount === null || !/^[A-Z]{3}$/.test(offerCurrency)) return null;
        // Discount markup is trustworthy only in this Product's own offer or
        // purchase block. An unrelated DLC/bundle at the same price is not a
        // source for the app's discount. The adjacent-action form is used by
        // older store pages without a purchase-block wrapper.
        const purchase = elementsByClass(source, 'game_area_purchase_game').find(block => block.includes(offer));
        let action = elementsByClass(offer || '', 'game_purchase_action_bg')[0]
            || elementsByClass(purchase || '', 'game_purchase_action_bg')[0];
        if (!action) {
            const title = cleanSteamTitle(readMetaContent(source, 'og:title') || readTitleTag(source));
            const exactHeadings = new Set([title, `Buy ${title}`, `${title}を購入する`].map(text => text.toLowerCase()));
            const matchingBlocks = title ? elementsByClass(source, 'game_area_purchase_game').filter(block => {
                const heading = cleanText(block.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1] || '').toLowerCase();
                return exactHeadings.has(heading);
            }) : [];
            if (matchingBlocks.length === 1) action = elementsByClass(matchingBlocks[0], 'game_purchase_action_bg')[0];
        }
        if (!action && offerTag) {
            const tail = source.slice(offerTag.index + offer.length);
            const adjacent = /^\s*(<div\b[^>]*\bclass\s*=["'][^"']*\bgame_purchase_action_bg\b[^"']*["'][^>]*>)/i.exec(tail);
            if (adjacent) action = readElement(tail, adjacent.index + adjacent[0].indexOf('<'));
        }
        const price = action ? priceFromPurchaseAction(action, target.country || url.searchParams.get('cc') || 'us') : null;
        return { final: amount, currency: offerCurrency,
            ...(price?.final === amount && price.discount_percent !== undefined ? { discount_percent: price.discount_percent } : {}),
            ...(price?.final === amount && price.initial !== undefined ? { initial: price.initial } : {}) };
    }
    const purchaseFunction = kind === 'bundle' ? 'addBundleToCart' : 'addToCart';
    const purchasePattern = new RegExp(`\\b${purchaseFunction}\\(\\s*${escapeRegExp(id)}(?=\\s*[,\\)])`, 'i');
    const action = actions.find(item => purchasePattern.test(item));
    const price = action ? priceFromPurchaseAction(action, target.country || url.searchParams.get('cc') || 'us') : null;
    return price ? { ...price, ...(/^[A-Z]{3}$/.test(currency) ? { currency } : {}) } : null;
}

function parseSteamPage(html, baseUrl, target) {
    const title = cleanSteamTitle(
        readMetaContent(html, 'og:title')
        || readMetaContent(html, 'twitter:title')
        || readTitleTag(html)
    );
    const description = cleanText(readMetaContent(html, 'og:description') || readMetaContent(html, 'description'));
    const imageUrl = absoluteUrl(
        readMetaContent(html, 'og:image') || readMetaContent(html, 'twitter:image'),
        baseUrl
    );
    const priceOverview = parseSteamPrice(html, baseUrl, target);
    return { title, description, imageUrl, ...(priceOverview ? { priceOverview } : {}) };
}

module.exports = { parseSteamPage, parseSteamPrice, cleanText, cleanSteamTitle };
