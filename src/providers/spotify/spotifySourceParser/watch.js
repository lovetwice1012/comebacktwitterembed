'use strict';

function decodeEntities(value) {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, key) => {
        if (key[0] !== '#') return named[key.toLowerCase()] || raw;
        const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : raw;
    });
}
function plainText(value) { return decodeEntities(String(value || '').replace(/<[^>]*>/g, '')).trim(); }
function publicationTime(value) {
    // A year/date without a time zone is not an instant. Keep it unknown for
    // publication-relative delays rather than inventing January 1 / midnight.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`), ms = Date.parse(value);
    return Number.isFinite(ms) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10) ? ms : null;
}
function albumId(raw) {
    try {
        const url = new URL(raw, 'https://open.spotify.com/');
        if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'open.spotify.com') return null;
        return /^\/(?:intl-[a-z-]+\/)?album\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname)?.[1] || null;
    } catch { return null; }
}
function extractArtistReleaseMetadata(html) {
    const source = String(html || ''), text = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const sections = [...text.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)], result = new Map();
    for (let i = 0; i < sections.length; i++) {
        if (!/^(?:Albums|Singles and EPs|Singles & EPs|アルバム|シングルとEP|シングル、EP)$/i.test(plainText(sections[i][1]))) continue;
        const section = text.slice(sections[i].index + sections[i][0].length, sections[i + 1]?.index ?? text.length);
        for (const anchor of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
            const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(anchor[1]);
            const id = href ? albumId(decodeEntities(href[2])) : null;
            if (!id) continue;
            // The guest card's bold span contains the title; its adjacent
            // Album/Single + year line must not become part of that title.
            const title = /<span\b[^>]*\bclass=["'][^"']*\bencore-text-body-small-bold\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(anchor[2])?.[1]
                || /<[^>]+\bitemprop=["']name["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(anchor[2])?.[1]
                || (!/<[^>]*>/.test(anchor[2]) ? anchor[2] : null);
            const datetime = /<time\b[^>]*\bdatetime=["']([^"']+)["']/i.exec(anchor[2])?.[1];
            const before = result.get(id) || {};
            result.set(id, { title: before.title || (title == null ? null : plainText(title).slice(0, 1024) || null),
                publishedAtMs: before.publishedAtMs ?? publicationTime(datetime) });
        }
    }
    // JSON-LD may describe the artist, recommendations or another album. Only
    // explicit album records matching a release-section card may enrich it.
    for (const script of source.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        let data;
        try { data = JSON.parse(script[1]); } catch { continue; }
        const nodes = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
        for (const node of nodes) {
            if (node?.['@type'] !== 'MusicAlbum') continue;
            const id = albumId(node.url || node['@id']);
            if (!result.has(id)) continue;
            const before = result.get(id);
            result.set(id, { title: before.title || (typeof node.name === 'string' ? node.name.trim().slice(0, 1024) || null : null),
                publishedAtMs: before.publishedAtMs ?? publicationTime(node.datePublished) });
        }
    }
    return result;
}
module.exports = { extractArtistReleaseMetadata };
