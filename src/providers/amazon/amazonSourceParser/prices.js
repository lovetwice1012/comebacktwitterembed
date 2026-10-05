'use strict';

const { cleanText, extractAttr, readMetaContent } = require('./html');

const MARKETPLACE_CURRENCIES = {
    'amazon.com': 'USD', 'amazon.co.jp': 'JPY', 'amazon.co.uk': 'GBP',
    'amazon.de': 'EUR', 'amazon.fr': 'EUR', 'amazon.it': 'EUR', 'amazon.es': 'EUR',
    'amazon.nl': 'EUR', 'amazon.com.be': 'EUR', 'amazon.ie': 'EUR',
    'amazon.ca': 'CAD', 'amazon.com.au': 'AUD', 'amazon.com.br': 'BRL',
    'amazon.com.mx': 'MXN', 'amazon.in': 'INR', 'amazon.sg': 'SGD',
    'amazon.se': 'SEK', 'amazon.pl': 'PLN', 'amazon.com.tr': 'TRY',
    'amazon.ae': 'AED', 'amazon.sa': 'SAR', 'amazon.eg': 'EGP',
    'amazon.co.za': 'ZAR', 'amazon.cn': 'CNY',
};
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const DOLLAR_CURRENCIES = new Set(['USD', 'CAD', 'AUD', 'MXN', 'SGD']);

function marketplaceCurrency(parsed) {
    try {
        const host = new URL(parsed.canonicalUrl).hostname.replace(/^(?:www|smile|m)\./, '');
        return MARKETPLACE_CURRENCIES[host] || '';
    } catch {
        return '';
    }
}

function numericPrice(value, structured) {
    let text = cleanText(value).normalize('NFKC')
        .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x660))
        .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x6f0))
        .replace(/\u066b/g, '.').replace(/\u066c/g, ',');
    if (!/^[\d.,'\s]+$/.test(text) || !/\d/.test(text)) return null;
    if (structured && /^\d+(?:\.\d+)?$/.test(text)) {
        const value = Number(text);
        return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? value : null;
    }
    const decimal = text.match(/([.,])(\d{1,2})$/)?.[1] || '';
    const split = decimal ? text.lastIndexOf(decimal) : -1;
    const integer = split < 0 ? text : text.slice(0, split);
    const fraction = split < 0 ? '' : text.slice(split + 1);
    // Accept a single consistent thousands separator, including Indian grouping.
    const separators = [...new Set(integer.replace(/\d/g, '').split(''))];
    if (separators.length > 1 || separators.includes(decimal)) return null;
    const groups = integer.split(/[.,'\s]/);
    if (groups.length > 1 && !(
        /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every(group => /^\d{3}$/.test(group))
        || /^\d{1,2}$/.test(groups[0]) && /^\d{3}$/.test(groups.at(-1))
            && groups.slice(1, -1).every(group => /^\d{2}$/.test(group))
    )) return null;
    if (!groups.every(group => /^\d+$/.test(group))) return null;
    text = groups.join('') + (fraction ? `.${fraction}` : '');
    const amount = Number(text);
    return Number.isFinite(amount) && amount <= Number.MAX_SAFE_INTEGER ? amount : null;
}

function parsePrice(value, declaredCurrency, fallbackCurrency, structured = false) {
    let raw = cleanText(value)
        .replace(/&(yen|pound|euro);/gi, (_match, name) => ({ yen: '¥', pound: '£', euro: '€' })[name.toLowerCase()])
        .replace(/&(?:thinsp|ensp|emsp);/gi, ' ')
        .normalize('NFKC').replace(/[\u200e\u200f\u061c]/g, '').trim();
    if (!raw) return null;
    let currency = cleanText(declaredCurrency).toUpperCase();
    if (currency && !CURRENCIES.has(currency)) return null;
    const marker = raw.match(/^(US\$|CA\$|CDN\$|AU\$|A\$|S\$|R\$|[A-Z]{3}|[$¥€£₹₺]|zł)\s*/i)
        || raw.match(/\s*(US\$|CA\$|CDN\$|AU\$|A\$|S\$|R\$|[A-Z]{3}|[$¥€£₹₺]|zł|円|kr)$/i);
    if (marker) {
        const symbol = marker[1].toUpperCase();
        const known = { 'US$': 'USD', 'CA$': 'CAD', 'CDN$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD', 'S$': 'SGD', 'R$': 'BRL', '€': 'EUR', '£': 'GBP', '₹': 'INR', '₺': 'TRY', 'ZŁ': 'PLN', '円': 'JPY' };
        let explicit = known[symbol] || (CURRENCIES.has(symbol) ? symbol : '');
        if (symbol === '$') explicit = DOLLAR_CURRENCIES.has(currency || fallbackCurrency) ? currency || fallbackCurrency : '';
        if (symbol === '¥') explicit = ['JPY', 'CNY'].includes(currency || fallbackCurrency) ? currency || fallbackCurrency : '';
        if (symbol === 'KR') explicit = ['SEK', 'NOK', 'DKK'].includes(currency || fallbackCurrency) ? currency || fallbackCurrency : '';
        if (!explicit || currency && explicit !== currency) return null;
        currency = explicit;
        raw = raw.slice(0, marker.index) + raw.slice(marker.index + marker[0].length);
    }
    currency ||= fallbackCurrency;
    if (!CURRENCIES.has(currency)) return null;
    const amount = numericPrice(raw.trim(), structured);
    return amount === null ? null : { amount, currency };
}

// Match complete nested elements so split whole/fraction markup survives nested spans.
function elementAt(html, match) {
    const tagName = match[1];
    const start = match.index + match[0].length;
    const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tags.lastIndex = start;
    let depth = 1;
    let tag;
    while ((tag = tags.exec(html))) {
        depth += tag[0].startsWith('</') ? -1 : /\/\s*>$/.test(tag[0]) ? 0 : 1;
        if (depth === 0) return { html: html.slice(start, tag.index), end: tags.lastIndex };
    }
    return { html: '', end: start };
}

function elementsMatching(html, attribute, value) {
    const tags = /<([a-z][a-z0-9:-]*)\b[^>]*>/gi;
    const elements = [];
    let tag;
    while ((tag = tags.exec(html))) {
        const attr = extractAttr(tag[0], attribute);
        if (!(attribute === 'class' ? attr.split(/\s+/).includes(value) : attr === value)) continue;
        const element = elementAt(html, tag);
        elements.push({ ...element, start: tag.index, tag: tag[0] });
        tags.lastIndex = element.end;
    }
    return elements;
}

function priceInArea(html, currency, fallbackCurrency) {
    const primary = tag => /\b(?:priceToPay|apexPriceToPay|apex-pricetopay-value)\b/.test(extractAttr(tag, 'class'));
    for (const unitClass of ['pricePerUnit', 'price-per-unit', 'unit-price', 'a-text-strike', 'a-text-price']) {
        for (const area of elementsMatching(html, 'class', unitClass).reverse()) {
            if (unitClass === 'a-text-price' && primary(area.tag) && extractAttr(area.tag, 'data-a-strike') !== 'true') continue;
            html = html.slice(0, area.start) + html.slice(area.end);
        }
    }
    const prices = elementsMatching(html, 'class', 'a-price');
    prices.sort((first, second) => Number(primary(second.tag)) - Number(primary(first.tag)));
    for (const price of prices) {
        const classes = extractAttr(price.tag, 'class').split(/\s+/);
        if (classes.includes('a-text-price') && !primary(price.tag) || classes.includes('a-text-strike') || extractAttr(price.tag, 'data-a-strike') === 'true') continue;
        for (const offscreen of elementsMatching(price.html, 'class', 'a-offscreen')) {
            const result = parsePrice(offscreen.html, currency, fallbackCurrency);
            if (result) return result;
        }
        const whole = elementsMatching(price.html, 'class', 'a-price-whole')[0]?.html;
        const fraction = cleanText(elementsMatching(price.html, 'class', 'a-price-fraction')[0]?.html);
        const symbol = cleanText(elementsMatching(price.html, 'class', 'a-price-symbol')[0]?.html);
        if (whole !== undefined) {
            const amount = cleanText(whole).replace(/[.,]\s*$/, '');
            const result = parsePrice(`${symbol}${amount}`, currency, fallbackCurrency);
            if (result && (!fraction || /^\d{1,2}$/.test(fraction))) {
                return { ...result, amount: result.amount + (fraction ? Number(`0.${fraction}`) : 0) };
            }
        }
    }
    return null;
}

function extractProductPrice(html, offer, parsed) {
    const fallbackCurrency = marketplaceCurrency(parsed);
    const metaCurrency = readMetaContent(html, 'product:price:currency') || readMetaContent(html, 'og:price:currency');
    const source = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const id of ['corePriceDisplay_desktop_feature_div', 'corePriceDisplay_mobile_feature_div', 'corePrice_feature_div', 'apex_desktop', 'apex_mobile', 'price']) {
        for (const area of elementsMatching(source, 'id', id)) {
            const price = priceInArea(area.html, metaCurrency, fallbackCurrency);
            if (price) return price;
        }
    }
    for (const id of ['priceblock_dealprice', 'priceblock_saleprice', 'priceblock_ourprice', 'price_inside_buybox', 'newBuyBoxPrice', 'kindle-price', 'tp_price_block_total_price_ww']) {
        for (const area of elementsMatching(source, 'id', id)) {
            const price = priceInArea(area.html, metaCurrency, fallbackCurrency) || parsePrice(area.html, metaCurrency, fallbackCurrency);
            if (price) return price;
        }
    }
    return parsePrice(offer.price, offer.currency, fallbackCurrency, true)
        || parsePrice(readMetaContent(html, 'product:price:amount') || readMetaContent(html, 'og:price:amount'), metaCurrency, fallbackCurrency, true);
}

function referencePriceInArea(html, currency, fallbackCurrency) {
    const candidates = [
        ...elementsMatching(html, 'class', 'a-text-strike'),
        ...elementsMatching(html, 'class', 'a-text-price').filter(area => extractAttr(area.tag, 'data-a-strike') === 'true'),
    ];
    for (const area of candidates) {
        for (const offscreen of elementsMatching(area.html, 'class', 'a-offscreen')) {
            const price = parsePrice(offscreen.html, currency, fallbackCurrency);
            if (price) return price;
        }
        const price = parsePrice(area.html, currency, fallbackCurrency);
        if (price) return price;
    }
    return null;
}

function extractProductReferencePrice(html, parsed) {
    const fallbackCurrency = marketplaceCurrency(parsed);
    const metaCurrency = readMetaContent(html, 'product:price:currency') || readMetaContent(html, 'og:price:currency');
    const source = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const id of ['basisPrice', 'listPrice', 'priceblock_listprice', 'priceblock_ourprice', 'priceblock_wasprice']) {
        for (const area of elementsMatching(source, 'id', id)) {
            const price = referencePriceInArea(area.html, metaCurrency, fallbackCurrency) || parsePrice(area.html, metaCurrency, fallbackCurrency);
            if (price) return price;
        }
    }
    return referencePriceInArea(source, metaCurrency, fallbackCurrency);
}

function formatProductPrice(price, locale) {
    if (!price) return '';
    try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency }).format(price.amount);
    } catch {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency }).format(price.amount);
    }
}

module.exports = { extractProductPrice, extractProductReferencePrice, formatProductPrice };
