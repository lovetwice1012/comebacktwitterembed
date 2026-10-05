'use strict';

// Guest listing metadata only. No page-global dates, sale periods or product
// numbers are interpreted as publication timestamps.
function decodeEntities(value) {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, key) => {
        if (key[0] !== '#') return named[key.toLowerCase()] || raw;
        const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : raw;
    });
}
function publicationTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`), ms = Date.parse(value);
    return Number.isFinite(ms) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10) ? ms : null;
}
function itemId(raw, shop) {
    try {
        const url = new URL(raw, `https://${shop}.booth.pm/`);
        if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== `${shop}.booth.pm`) return null;
        return /^\/(?:[a-z]{2}\/)?items\/(\d+)\/?$/.exec(url.pathname)?.[1] || null;
    } catch { return null; }
}
function extractItemMetadata(html, shop) {
    const source = String(html || ''), result = new Map();
    const add = (id, title, publishedAtMs) => {
        if (!id) return;
        const before = result.get(id) || {};
        result.set(id, { title: before.title || (typeof title === 'string' && title.trim() ? title.trim().slice(0, 1024) : null),
            publishedAtMs: before.publishedAtMs ?? publishedAtMs ?? null });
    };
    for (const attribute of source.matchAll(/\bdata-(?:item|items)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
        let data;
        try { data = JSON.parse(decodeEntities(attribute[2])); } catch { continue; }
        const cards = Array.isArray(data) ? data : [data];
        for (const card of cards) {
            if (!card || typeof card !== 'object') continue;
            const id = typeof card.shop_item_url === 'string' ? itemId(card.shop_item_url, shop) : null;
            if (!id || card.id != null && String(card.id) !== id) continue;
            add(id, card.name, publicationTime(card.published_at) ?? publicationTime(card.datePublished));
        }
    }
    for (const anchor of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(anchor[1]);
        if (!href) continue;
        const id = itemId(decodeEntities(href[2]), shop);
        const title = /<[^>]+\bitemprop=["']name["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(anchor[2])?.[1]
            || (!/<[^>]*>/.test(anchor[2]) ? anchor[2] : null);
        const datetime = /<time\b[^>]*\bdatetime=["']([^"']+)["']/i.exec(anchor[2])?.[1];
        add(id, title == null ? null : decodeEntities(title.replace(/<[^>]*>/g, '')).trim(), publicationTime(datetime));
    }
    return result;
}
module.exports = { extractItemMetadata };
