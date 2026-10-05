'use strict';

const { extractSalePeriod } = require('./sale');

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function extractItemIds(html, shop) {
    const ids = new Set();
    const source = String(html || '');
    // The guest shop page now carries cards as entity-encoded JSON props.
    // Match the owner-qualified item URL, not recommendations or wish-list IDs.
    const decoded = source.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&amp;/gi, '&').replace(/\\\//g, '/');
    for (const match of decoded.matchAll(/"shop_item_url"\s*:\s*"https:\/\/([a-z0-9][a-z0-9-]*)\.booth\.pm\/items\/(\d+)(?:[?#][^"]*)?"/gi)) {
        if (!shop || match[1].toLowerCase() === shop.toLowerCase()) ids.add(match[2]);
    }
    for (const match of source.matchAll(/(?:href|data-url)=["']([^"']*\/items\/(\d+)[^"']*)["']/gi)) {
        if (shop) {
            try {
                const url = new URL(match[1], `https://${shop}.booth.pm/`);
                if (url.hostname !== `${shop}.booth.pm` || !/^\/(?:[a-z]{2}\/)?items\/\d+\/?$/.test(url.pathname)) continue;
            } catch { continue; }
        }
        ids.add(match[2]);
    }
    return [...ids];
}

module.exports = { stripHtml, extractItemIds, extractSalePeriod };
